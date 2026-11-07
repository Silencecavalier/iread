using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>One untrusted rule task per disposable process; never evaluates in the application WebView.</summary>
internal static class RuleProcess
{
    private static readonly SemaphoreSlim Slots = new(4, 4);
    private static readonly CancellationTokenSource ShuttingDown = new();
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<RuleJobObject, byte> ActiveJobs = new();
    internal const int MaxMessageBytes = 16 * 1024 * 1024;
    internal const int MaxCookieCount = 256;
    internal const int MaxCookieBytes = 4096;
    internal const string PipePrefix = "iread-rule-";

    /// <summary>Application exit hook: reject future work and kill only jobs created by this host.</summary>
    internal static void Shutdown()
    {
        ShuttingDown.Cancel();
        DrainWarm();
        foreach (var job in ActiveJobs.Keys) job.Dispose();
    }

    internal static async Task<object> ExecuteAsync(JsonElement request)
    {
        int timeout = Validate(request);
        request = request.Clone();
        using var scope = HostTaskScope.Open(request.TryGetProperty("taskId", out var taskId) ? taskId.GetString() : null,
            timeout, ShuttingDown.Token);
        bool entered = false;
        Process child = null;
        RuleJobObject job = null;
        string profile = null;
        NamedPipeServerStream pipe = null;
        try
        {
            await Slots.WaitAsync(scope.Token).ConfigureAwait(false);
            entered = true;
            // Reuse a worker whose browser is already up; only a cold start pays the WebView2 setup.
            WarmWorker warm = await TakeWarmAsync(scope.Token).ConfigureAwait(false);
            pipe = warm.Pipe;
            child = warm.Child;
            job = warm.Job;
            profile = warm.Profile;
            RefillWarm();
            await WriteAsync(pipe, request, scope.Token).ConfigureAwait(false);
            JsonElement response = await ReadAsync(pipe, scope.Token).ConfigureAwait(false);
            scope.Token.ThrowIfCancellationRequested();
            if (!response.TryGetProperty("ok", out var ok) || ok.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw Error("RULE_WORKER", "Invalid worker response");
            if (!ok.GetBoolean())
            {
                var error = response.GetProperty("error");
                var e = new Exception(error.GetProperty("message").GetString() ?? "RULE_WORKER");
                if (error.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
                    foreach (var p in data.EnumerateObject()) e.Data[p.Name] = Scalar(p.Value);
                throw e;
            }
            var result = response.GetProperty("result");
            if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty("value", out _) ||
                !result.TryGetProperty("state", out var resultState) || !result.TryGetProperty("diag", out _))
                throw Error("RULE_WORKER", "Invalid rule result");
            ValidateState(resultState);
            var accepted = result.Clone();
            scope.Token.ThrowIfCancellationRequested();
            return accepted;
        }
        catch (Exception) when (ShuttingDown.IsCancellationRequested)
        {
            throw Error("RULE_CANCELLED", "Application rule host is shutting down");
        }
        catch (Exception) when (scope.Cancelled)
        {
            var e = Error("CANCELLED", "Rule task cancelled by user");
            e.Data["cancelled"] = true;
            throw e;
        }
        catch (OperationCanceledException) when (scope.Token.IsCancellationRequested)
        {
            var e = Error("RULE_TIMEOUT", $"RULE_TIMEOUT: exceeded {timeout}ms");
            e.Data["timeout"] = true;
            throw e;
        }
        catch (Exception e) when (!e.Data.Contains("code"))
        {
            throw Error("RULE_WORKER", e.Message);
        }
        finally
        {
            // Both success and failure terminate only this task's job (including browser processes).
            try
            {
                if (job != null)
                {
                    ActiveJobs.TryRemove(job, out _);
                    job.Dispose();
                }
            }
            finally
            {
                try { pipe?.Dispose(); }
                catch (Exception e) when (e is ObjectDisposedException or IOException) { }
                if (child != null)
                {
                    // Job disposal owns descendant termination; only the launched child is a fallback
                    // if assignment failed while it was still waiting for its initial request.
                    try { if (!child.HasExited) child.Kill(); }
                    catch (InvalidOperationException) { }
                    catch (System.ComponentModel.Win32Exception) { }
                    try { await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false); }
                    catch (TimeoutException) { }
                    child.Dispose();
                }
                if (profile != null)
                {
                    // Mapped Chromium files can temporarily report ACCESS_DENIED, not just sharing violations.
                    // Retry only this task's random TEMP profile; never change ACLs or file attributes.
                    for (int attempt = 0; attempt < 8 && Directory.Exists(profile); attempt++)
                    {
                        try { Directory.Delete(profile, recursive: true); }
                        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                        {
                            if (attempt < 7) await Task.Delay(100).ConfigureAwait(false);
                        }
                    }
                }
                if (entered) Slots.Release();
            }
        }
    }

    private sealed class WarmWorker
    {
        internal Process Child;
        internal NamedPipeServerStream Pipe;
        internal RuleJobObject Job;
        internal string Profile;
    }

    private static readonly System.Collections.Concurrent.ConcurrentBag<WarmWorker> Warm = new();
    private const int WarmTarget = 4;
    private const int WarmReadyTimeoutMs = 30000;
    private static int warmPending;

    /// <summary>Starts one worker and waits until its browser is up, before any task is assigned.</summary>
    private static async Task<WarmWorker> PrepareWarmAsync(CancellationToken token)
    {
        string name = PipePrefix + Guid.NewGuid().ToString("N");
        string profile = ProfilePath(name);
        var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var job = new RuleJobObject();
        ActiveJobs.TryAdd(job, 0);
        Process child = null;
        try
        {
            var start = new ProcessStartInfo(Environment.ProcessPath ?? throw Error("RULE_WORKER", "Executable path unavailable"))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = AppContext.BaseDirectory
            };
            // Framework-dependent hosts launched as `dotnet app.dll` must relaunch that same assembly.
            if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
                start.ArgumentList.Add(typeof(Program).Assembly.Location);
            start.ArgumentList.Add("--rule-worker");
            start.ArgumentList.Add(name);
            // Do not inherit WebView overrides that can bypass the worker's profile/settings.
            foreach (string key in start.Environment.Keys.Where(k => k.StartsWith("WEBVIEW2_", StringComparison.OrdinalIgnoreCase)).ToArray())
                start.Environment.Remove(key);
            child = Process.Start(start) ?? throw Error("RULE_WORKER", "Unable to start worker");
            job.Assign(child);
            using var connect = CancellationTokenSource.CreateLinkedTokenSource(token);
            Task connected = pipe.WaitForConnectionAsync(connect.Token);
            Task exited = child.WaitForExitAsync(connect.Token);
            if (await Task.WhenAny(connected, exited).ConfigureAwait(false) != connected)
            {
                token.ThrowIfCancellationRequested();
                throw Error("RULE_WORKER", "Worker exited before pipe connection");
            }
            await connected.ConfigureAwait(false);
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out uint pid) || pid != child.Id)
                throw Error("RULE_WORKER", "Unexpected pipe client");
            using var ready = CancellationTokenSource.CreateLinkedTokenSource(token);
            ready.CancelAfter(WarmReadyTimeoutMs);
            JsonElement hello = await ReadAsync(pipe, ready.Token).ConfigureAwait(false);
            if (!hello.TryGetProperty("ready", out var flag) || flag.ValueKind != JsonValueKind.True)
                throw Error("RULE_WORKER", "Worker did not report ready");
            Log("prepare ready pid=" + child.Id);
            return new WarmWorker { Child = child, Pipe = pipe, Job = job, Profile = profile };
        }
        catch
        {
            try { pipe.Dispose(); }
            catch (Exception e) when (e is ObjectDisposedException or IOException) { }
            if (child != null)
            {
                try { if (!child.HasExited) child.Kill(); }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                child.Dispose();
            }
            ActiveJobs.TryRemove(job, out _);
            job.Dispose();
            await DeleteProfileAsync(profile).ConfigureAwait(false);
            throw;
        }
    }

    private static async Task<WarmWorker> TakeWarmAsync(CancellationToken token)
    {
        while (Warm.TryTake(out WarmWorker warm))
        {
            bool alive;
            try { alive = !warm.Child.HasExited; }
            catch (InvalidOperationException) { alive = false; }
            Log("take pool alive=" + alive);
            if (alive) return warm;
            DiscardWarm(warm);
        }
        Log("take pool empty -> cold");
        return await PrepareWarmAsync(token).ConfigureAwait(false);
    }

    /// <summary>Keeps a small warm pool so the next task skips the WebView2 start-up cost.</summary>
    private static void RefillWarm()
    {
        if (ShuttingDown.IsCancellationRequested) return;
        if (Warm.Count + Volatile.Read(ref warmPending) >= WarmTarget) return;
        Interlocked.Increment(ref warmPending);
        _ = Task.Run(async () =>
        {
            try
            {
                using var token = new CancellationTokenSource(TimeSpan.FromSeconds(120));
                WarmWorker warm = await PrepareWarmAsync(token.Token).ConfigureAwait(false);
                Log("refill ready pid=" + warm.Child.Id);
                if (ShuttingDown.IsCancellationRequested) DiscardWarm(warm);
                else Warm.Add(warm);
            }
            catch (Exception e)
            {
                // warm-up is opportunistic: a cold start still works
                Log("refill failed " + e.GetType().Name + ": " + e.Message);
            }
            finally { Interlocked.Decrement(ref warmPending); }
        });
    }

    /// <summary>Starts the first workers early so the very first task is not a cold start.</summary>
    internal static void Prime(int count = 1)
    {
        SweepProfiles();
        for (int i = 0; i < count; i++) RefillWarm();
    }

    /// <summary>Removes TEMP profiles left behind when a previous run was killed before its cleanup.</summary>
    private static void SweepProfiles()
    {
        try
        {
            string root = Path.GetTempPath();
            foreach (string dir in Directory.EnumerateDirectories(root, PipePrefix + "*"))
            {
                try
                {
                    // A live worker of this process is never older than the sweep itself.
                    if (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(dir) < TimeSpan.FromMinutes(60)) continue;
                    Directory.Delete(dir, recursive: true);
                    Log("swept stale profile " + Path.GetFileName(dir));
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or DirectoryNotFoundException) { }
    }

    private static void DiscardWarm(WarmWorker warm)
    {
        if (warm == null) return;
        try { warm.Pipe.Dispose(); }
        catch (Exception e) when (e is ObjectDisposedException or IOException) { }
        ActiveJobs.TryRemove(warm.Job, out _);
        warm.Job.Dispose();
        try { if (!warm.Child.HasExited) warm.Child.Kill(); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        warm.Child.Dispose();
        _ = DeleteProfileAsync(warm.Profile);
    }

    private static async Task DeleteProfileAsync(string profile)
    {
        for (int attempt = 0; attempt < 8 && Directory.Exists(profile); attempt++)
        {
            try { Directory.Delete(profile, recursive: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                if (attempt < 7) await Task.Delay(100).ConfigureAwait(false);
            }
        }
    }

    private static void DrainWarm()
    {
        while (Warm.TryTake(out WarmWorker warm)) DiscardWarm(warm);
    }

    // TEMP DIAGNOSTIC: remove together with the warm.log file once tuning is done.
    internal static void Log(string message)
    {
        if (!DebugWarm) return;
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "iread-warm.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    private static readonly bool DebugWarm = Environment.GetEnvironmentVariable("IREAD_DEBUG_WARM") == "1";

    internal static int Validate(JsonElement request)
    {
        if (request.ValueKind != JsonValueKind.Object) throw Error("RULE_REQUEST", "RULE_REQUEST: object required");
        if (System.Text.Encoding.UTF8.GetByteCount(request.GetRawText()) > MaxMessageBytes)
            throw Error("RULE_REQUEST", "RULE_REQUEST: request too large");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in request.EnumerateObject())
            if (p.Name is not ("operation" or "source" or "args" or "state" or "timeout" or "taskId") || !names.Add(p.Name))
                throw Error("RULE_REQUEST", "RULE_REQUEST: unexpected or duplicate field " + p.Name);
        if (request.TryGetProperty("taskId", out var taskId))
        {
            if (!IsString(taskId)) throw Error("RULE_REQUEST", "RULE_REQUEST: taskId must be a string");
            HostTaskScope.ValidateTaskId(taskId.GetString());
        }
        if (!request.TryGetProperty("operation", out var op) || op.ValueKind != JsonValueKind.String ||
            op.GetString() is not ("search" or "explore" or "detail" or "catalog" or "content" or "test" or "fetchPage" or "decodeImage"))
            throw Error("RULE_REQUEST", "RULE_REQUEST: operation not allowed");
        if (!request.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.Object ||
            !request.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Array)
            throw Error("RULE_REQUEST", "RULE_REQUEST: source/args required");
        int n = args.GetArrayLength();
        bool valid = op.GetString() switch
        {
            "search" => n is 1 or 2 && IsString(args[0]) && (n == 1 || args[1].ValueKind == JsonValueKind.Number),
            "explore" => n == 0 || n == 1 && IsObject(args[0]),
            "detail" => n == 1 && IsString(args[0]),
            "catalog" => n is 1 or 2 && IsString(args[0]) && (n == 1 || IsObject(args[1])),
            "content" => n is 1 or 2 && IsObject(args[0]) && (n == 1 || ValidChapterUrls(args[1])),
            "test" => n == 0 || n == 1 && IsString(args[0]),
            "fetchPage" => n is >= 1 and <= 3 && IsString(args[0]) && (n < 2 || IsObject(args[1])) && (n < 3 || IsString(args[2])),
            "decodeImage" => n == 2 && IsString(args[0]) && IsString(args[1]),
            _ => false
        };
        if (!valid) throw Error("RULE_REQUEST", "RULE_REQUEST: invalid operation arguments");
        if (request.TryGetProperty("state", out var state)) ValidateState(state);
        int timeout = 20000;
        if (request.TryGetProperty("timeout", out var t) && (t.ValueKind != JsonValueKind.Number || !t.TryGetInt32(out timeout) || timeout is < 1 or > 120000))
            throw Error("RULE_REQUEST", "RULE_REQUEST: timeout must be 1..120000ms");
        return timeout;
    }

    private static bool ValidChapterUrls(JsonElement context)
    {
        if (!IsObject(context)) return false;
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in context.EnumerateObject())
            if (property.Name != "chapterUrls" || !names.Add(property.Name)) return false;
        if (!context.TryGetProperty("chapterUrls", out var urls) || urls.ValueKind != JsonValueKind.Array || urls.GetArrayLength() > 4096) return false;
        foreach (var url in urls.EnumerateArray())
            if (!IsString(url) || url.GetString().Length is < 1 or > 2048) return false;
        return true;
    }

    internal static void ValidateState(JsonElement state)
    {
        if (!IsObject(state)) throw Error("RULE_REQUEST", "RULE_REQUEST: state must be an object");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in state.EnumerateObject())
            if (p.Name is not ("sourceStore" or "vars" or "memory" or "cookies") || !IsObject(p.Value) || !names.Add(p.Name))
                throw Error("RULE_REQUEST", "RULE_REQUEST: invalid state field");
        if (state.TryGetProperty("sourceStore", out var store))
            foreach (var entry in store.EnumerateObject())
            {
                if (!IsObject(entry.Value)) throw Error("RULE_REQUEST", "RULE_REQUEST: invalid source store");
                foreach (var p in entry.Value.EnumerateObject())
                    if (p.Name == "map" ? !IsObject(p.Value) :
                        p.Name is not ("key" or "raw" or "loginInfo" or "loginHeader") || !IsString(p.Value))
                        throw Error("RULE_REQUEST", "RULE_REQUEST: invalid source store field");
            }
        if (state.TryGetProperty("memory", out var memory))
        {
            names.Clear();
            foreach (var p in memory.EnumerateObject())
                if (!IsString(p.Value) || !names.Add(p.Name))
                    throw Error("RULE_REQUEST", "RULE_REQUEST: memory values must be strings without duplicate keys");
        }
        ImportCookies(state);
    }

    // This DTO contains cookie data only; no URLs, resource selectors or disk paths are accepted.
    internal static CookieContainer ImportCookies(JsonElement state)
    {
        var container = new CookieContainer(MaxCookieCount, MaxCookieCount, MaxCookieBytes);
        if (!state.TryGetProperty("cookies", out var cookies)) return container;
        if (!IsObject(cookies) || cookies.EnumerateObject().Count() != 1 ||
            !cookies.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array ||
            entries.GetArrayLength() > MaxCookieCount)
            throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie entries");
        foreach (var entry in entries.EnumerateArray())
        {
            if (!IsObject(entry)) throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie entry");
            var fields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in entry.EnumerateObject())
                if (p.Name is not ("name" or "value" or "domain" or "path" or "secure" or "httpOnly" or "expires") || !fields.Add(p.Name))
                    throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie field");
            if (fields.Count != 7) throw Error("RULE_REQUEST", "RULE_REQUEST: incomplete cookie entry");
            string name = CookieString(entry, "name", 256);
            string value = CookieString(entry, "value", MaxCookieBytes);
            string domain = CookieString(entry, "domain", 253);
            string path = CookieString(entry, "path", 2048);
            if (name.Length == 0 || System.Text.Encoding.UTF8.GetByteCount(name) + System.Text.Encoding.UTF8.GetByteCount(value) > MaxCookieBytes ||
                Uri.CheckHostName(domain.StartsWith('.') ? domain.Substring(1) : domain) == UriHostNameType.Unknown ||
                !path.StartsWith('/') || entry.GetProperty("secure").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                entry.GetProperty("httpOnly").ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie attributes");
            var expires = entry.GetProperty("expires");
            DateTime expiry = default;
            if (expires.ValueKind != JsonValueKind.Null &&
                (!IsString(expires) || expires.GetString().Length > 64 || !expires.TryGetDateTime(out expiry) || expiry.Kind == DateTimeKind.Unspecified))
                throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie expiry");
            try
            {
                var cookie = new Cookie(name, value, path, domain)
                {
                    Secure = entry.GetProperty("secure").GetBoolean(),
                    HttpOnly = entry.GetProperty("httpOnly").GetBoolean()
                };
                if (expires.ValueKind != JsonValueKind.Null) cookie.Expires = expiry.ToUniversalTime();
                container.Add(cookie);
            }
            catch (Exception e) when (e is CookieException or ArgumentException)
            {
                throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie: " + e.Message);
            }
        }
        return container;
    }

    private static string CookieString(JsonElement entry, string key, int maxBytes)
    {
        var field = entry.GetProperty(key);
        if (!IsString(field)) throw Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie string");
        string value = field.GetString();
        if (System.Text.Encoding.UTF8.GetByteCount(value) > maxBytes || value.Any(char.IsControl))
            throw Error("RULE_REQUEST", "RULE_REQUEST: cookie string too large or contains controls");
        return value;
    }

    private static bool IsString(JsonElement e) => e.ValueKind == JsonValueKind.String;
    private static bool IsObject(JsonElement e) => e.ValueKind == JsonValueKind.Object;
    internal static string ProfilePath(string pipeName) => Path.Combine(Path.GetTempPath(), pipeName);
    internal static Exception Error(string code, string message)
    {
        var e = new Exception(message.Contains(code, StringComparison.Ordinal) ? message : code + ": " + message);
        e.Data["code"] = code;
        return e;
    }
    internal static object Scalar(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.String => e.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number when e.TryGetInt64(out long number) => number,
        JsonValueKind.Null => null,
        _ => e.Clone()
    };
    internal static async Task WriteAsync(Stream pipe, object value, CancellationToken token = default)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(value);
        if (body.Length > MaxMessageBytes) throw Error("RULE_WORKER", "IPC response too large");
        byte[] header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, body.Length);
        await pipe.WriteAsync(header, token).ConfigureAwait(false);
        await pipe.WriteAsync(body, token).ConfigureAwait(false);
        await pipe.FlushAsync(token).ConfigureAwait(false);
    }
    internal static async Task<JsonElement> ReadAsync(Stream pipe, CancellationToken token = default)
    {
        byte[] header = new byte[4];
        await pipe.ReadExactlyAsync(header, token).ConfigureAwait(false);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length < 1 || length > MaxMessageBytes) throw Error("RULE_WORKER", "Invalid IPC length");
        byte[] body = new byte[length];
        await pipe.ReadExactlyAsync(body, token).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.Clone();
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);
}
