using System.Collections;
using System.IO.Pipes;
using System.Net;
using System.Net.Http;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/// <summary>Private STA/DOM host. No application files, storage, window or evaluation command bridge.</summary>
internal sealed class RuleWorkerHost : IDisposable
{
    private const string Origin = "https://rule-worker.invalid";
    private const string PageUrl = Origin + "/worker.html";
    private const int MaxBodyBytes = 8 * 1024 * 1024;
    private readonly NamedPipeClientStream pipe;
    // Assigned once the host hands over a task; a pre-warmed worker has created its browser first.
    private JsonElement request;
    private readonly string profile;
    private readonly CancellationTokenSource stop = new();
    private readonly CookieContainer cookies;
    private readonly HttpClient http;
    private readonly Dictionary<string, string> scripts = new(StringComparer.Ordinal);
    private Form form;
    private WebView2 view;
    private CoreWebView2 core;
    private bool navigated;
    private bool taskAsked;
    private int finished, activeFetches, totalFetches;
    private static readonly System.Diagnostics.Stopwatch Clock = System.Diagnostics.Stopwatch.StartNew();
    private bool loggedFetch;
    private readonly HashSet<int> fetchIds = new();

    internal static void Run(string pipeName)
    {
        if (!pipeName.StartsWith(RuleProcess.PipePrefix, StringComparison.Ordinal) ||
            !Guid.TryParseExact(pipeName.Substring(RuleProcess.PipePrefix.Length), "N", out _))
        {
            Environment.ExitCode = 2;
            return;
        }
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Anonymous);
        try
        {
            pipe.Connect(15000);
            using var host = new RuleWorkerHost(pipe, RuleProcess.ProfilePath(pipeName));
            host.Run();
        }
        catch (Exception e)
        {
            try { if (pipe.IsConnected) RuleProcess.WriteAsync(pipe, ErrorEnvelope(e)).GetAwaiter().GetResult(); }
            catch (IOException) { }
            Environment.ExitCode = 1;
        }
    }

    private RuleWorkerHost(NamedPipeClientStream pipe, string profile)
    {
        this.pipe = pipe;
        this.profile = profile;
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        cookies = RuleProcess.ImportCookies(JsonSerializer.SerializeToElement(new { }));
        http = new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.All,
            UseCookies = true,
            CookieContainer = cookies,
            MaxConnectionsPerServer = 8
        }) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private void Run()
    {
        // These are the only disk assets the worker can serve, never a directory mapping.
        foreach (string name in new[] { "rule.js", "legacy-js.js", "legado.js" })
            scripts.Add(Origin + "/" + name, File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "wwwroot", "js", "sources", name)));
        Application.EnableVisualStyles();
        form = new Form
        {
            ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(-32000, -32000),
            Size = new System.Drawing.Size(64, 64), Text = "iread rule worker"
        };
        view = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(view);
        form.Shown += async (_, _) =>
        {
            try { await InitializeAsync(); }
            catch (Exception e) { await CompleteAsync(ErrorEnvelope(e)); }
        };
        Application.Run(form);
    }

    private async Task InitializeAsync()
    {
        Directory.CreateDirectory(profile);
        var scheme = new CoreWebView2CustomSchemeRegistration("yedu-net") { HasAuthorityComponent = true, TreatAsSecure = true };
        scheme.AllowedOrigins.Add(Origin);
        var options = new CoreWebView2EnvironmentOptions(
            "--disable-extensions --disable-background-networking --disable-component-update --disable-sync --no-first-run",
            null, null, false, new List<CoreWebView2CustomSchemeRegistration> { scheme });
        var environment = await CoreWebView2Environment.CreateAsync(null, profile, options);
        await view.EnsureCoreWebView2Async(environment);
        core = view.CoreWebView2;
        var settings = core.Settings;
        settings.AreHostObjectsAllowed = false;
        settings.AreDevToolsEnabled = false;
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreDefaultScriptDialogsEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsBuiltInErrorPageEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        core.NavigationStarting += (_, e) =>
        {
            if (!navigated && e.Uri == PageUrl) navigated = true;
            else e.Cancel = true;
        };
        core.FrameCreated += (_, e) => e.Frame.NavigationStarting += (_, navigation) => navigation.Cancel = true;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.PermissionRequested += (_, e) => { e.State = CoreWebView2PermissionState.Deny; e.Handled = true; };
        core.ScriptDialogOpening += (_, e) => e.Accept();
        core.ProcessFailed += async (_, e) => await CompleteAsync(ErrorEnvelope(RuleProcess.Error("RULE_WORKER", "Browser process failed: " + e.ProcessFailedKind)));
        core.NavigationCompleted += async (_, e) =>
        {
            if (!e.IsSuccess && Volatile.Read(ref finished) == 0)
                await CompleteAsync(ErrorEnvelope(RuleProcess.Error("RULE_WORKER", "Worker page failed: " + e.WebErrorStatus)));
        };
        core.WebMessageReceived += OnMessage;
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnResource;
        // Load the rule engine up-front so a pooled worker only pays for the task itself.
        core.Navigate(PageUrl);
        await RuleProcess.WriteAsync(pipe, new { ok = true, ready = true }, stop.Token);
        JsonElement next = await RuleProcess.ReadAsync(pipe, stop.Token);
        RuleProcess.Validate(next);
        request = next;
        RuleProcess.Log("t=" + Clock.ElapsedMilliseconds + " worker request received");
        if (next.TryGetProperty("state", out var state)) ImportCookies(state);
        if (taskAsked) SendTask();
        RuleProcess.Log("t=" + Clock.ElapsedMilliseconds + " worker task handed over");
    }

    private void SendTask()
    {
        if (request.ValueKind != JsonValueKind.Object) return;
        taskAsked = false;
        core.PostWebMessageAsJson(JsonSerializer.Serialize(new { kind = "task", request = request.GetRawText() }));
    }

    private void ImportCookies(JsonElement state)
    {
        foreach (Cookie cookie in RuleProcess.ImportCookies(state).GetAllCookies())
        {
            try { cookies.Add(cookie); }
            catch (CookieException) { throw RuleProcess.Error("RULE_REQUEST", "RULE_REQUEST: invalid cookie"); }
        }
    }

    private async void OnResource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = e.Request.Uri;
        if (e.Request.Method == "GET" && uri == PageUrl)
        {
            Respond(e, 200, "text/html; charset=utf-8", Page(),
                "Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src yedu-net://net; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'\r\nCache-Control: no-store");
            return;
        }
        if (e.Request.Method == "GET" && scripts.TryGetValue(uri, out string script))
        {
            Respond(e, 200, "application/javascript; charset=utf-8", script);
            return;
        }
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var address) || address.Scheme != "yedu-net" ||
            address.Host != "net" || address.AbsolutePath != "/" || e.Request.Method != "GET" ||
            e.ResourceContext is not (CoreWebView2WebResourceContext.XmlHttpRequest or CoreWebView2WebResourceContext.Fetch))
        {
            Respond(e, 403, "text/plain; charset=utf-8", "NET: resource denied");
            return;
        }
        using var deferral = e.GetDeferral();
        bool counted = false;
        try
        {
            EnterFetch(); counted = true;
            var query = Query(address);
            foreach (var key in query.Keys)
                if (key is not ("u" or "m" or "body" or "cs" or "h")) throw RuleProcess.Error("NET", "Invalid proxy field");
            query.TryGetValue("u", out var url);
            query.TryGetValue("m", out var method);
            query.TryGetValue("body", out var body);
            query.TryGetValue("cs", out var charset);
            query.TryGetValue("h", out var headers);
            var opts = JsonSerializer.SerializeToElement(new
            {
                url, method = method ?? "GET", body, charset,
                headers = string.IsNullOrEmpty(headers) ? JsonSerializer.SerializeToElement(new { }) : JsonSerializer.Deserialize<JsonElement>(headers)
            });
            var result = await FetchAsync(opts);
            Respond(e, (int)result["status"], "text/plain; charset=utf-8", (string)result["text"]);
        }
        catch (Exception error) { Respond(e, 502, "text/plain; charset=utf-8", error.Message); }
        finally
        {
            if (counted) activeFetches--;
            deferral.Complete();
        }
    }

    private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (e.Source != PageUrl || Volatile.Read(ref finished) != 0) return;
        try
        {
            string json = e.WebMessageAsJson;
            if (Encoding.UTF8.GetByteCount(json) > RuleProcess.MaxMessageBytes) throw RuleProcess.Error("RULE_WORKER", "Web message too large");
            using var doc = JsonDocument.Parse(json);
            var message = doc.RootElement;
            string kind = message.GetProperty("kind").GetString();
            if (kind == "getTask")
            {
                taskAsked = true;
                SendTask();
                return;
            }
            if (kind == "done")
            {
                var envelope = JsonNode.Parse(message.GetProperty("envelope").GetRawText()) as JsonObject
                    ?? throw RuleProcess.Error("RULE_WORKER", "Invalid completion envelope");
                if (envelope["ok"]?.GetValue<bool>() == true)
                {
                    var state = envelope["result"]?["state"] as JsonObject
                        ?? throw RuleProcess.Error("RULE_WORKER", "Invalid completion state");
                    // Include every retained domain/path, not just cookies applicable to the last URL.
                    state["cookies"] = JsonSerializer.SerializeToNode(new
                    {
                        entries = cookies.GetAllCookies().Cast<Cookie>().Where(c => !c.Expired).Select(c => new
                        {
                            name = c.Name, value = c.Value, domain = c.Domain, path = c.Path,
                            secure = c.Secure, httpOnly = c.HttpOnly,
                            expires = c.Expires == DateTime.MinValue ? null : c.Expires.ToUniversalTime().ToString("O")
                        }).ToArray()
                    });
                    RuleProcess.ValidateState(JsonSerializer.SerializeToElement(state));
                }
                await CompleteAsync(envelope);
                return;
            }
            if (kind != "fetchText") throw RuleProcess.Error("RULE_REQUEST", "Worker bridge command denied");
            int id = message.GetProperty("id").GetInt32();
            if (id < 1 || !fetchIds.Add(id)) throw RuleProcess.Error("RULE_REQUEST", "Invalid network request ID");
            var opts = message.GetProperty("opts").Clone();
            if (!loggedFetch) { loggedFetch = true; RuleProcess.Log("t=" + Clock.ElapsedMilliseconds + " worker first fetch"); }
            bool counted = false;
            object reply;
            try
            {
                EnterFetch(); counted = true;
                reply = new { kind = "fetchResult", id, ok = true, result = await FetchWithRetry(opts) };
            }
            catch (Exception error) { reply = new { kind = "fetchResult", id, ok = false, error = ErrorData(error) }; }
            finally { if (counted) activeFetches--; }
            if (Volatile.Read(ref finished) == 0) core.PostWebMessageAsJson(JsonSerializer.Serialize(reply));
        }
        catch (Exception error) { await CompleteAsync(ErrorEnvelope(error)); }
    }

    private void EnterFetch()
    {
        if (++totalFetches > 2048 || activeFetches >= 16) throw RuleProcess.Error("NET", "Worker network request limit");
        activeFetches++;
    }

    private async Task CompleteAsync(object envelope)
    {
        if (Interlocked.Exchange(ref finished, 1) != 0) return;
        RuleProcess.Log("t=" + Clock.ElapsedMilliseconds + " worker complete");
        stop.Cancel();
        try { await RuleProcess.WriteAsync(pipe, envelope); }
        catch (Exception) { Environment.ExitCode = 1; }
        finally { form.Close(); }
    }

    private static object ErrorEnvelope(Exception e) => new { ok = false, error = ErrorData(e) };
    private static object ErrorData(Exception e)
    {
        var data = new Dictionary<string, object>();
        foreach (DictionaryEntry p in e.Data) data[Convert.ToString(p.Key)] = p.Value;
        if (!data.ContainsKey("code")) data["code"] = "RULE_WORKER";
        return new { message = e.Message, data };
    }

    private void Respond(CoreWebView2WebResourceRequestedEventArgs e, int status, string type, string text, string extra = null)
    {
        e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(text)),
            status, status < 400 ? "OK" : "Error", "Content-Type: " + type + "\r\nAccess-Control-Allow-Origin: " + Origin +
            (extra == null ? "" : "\r\n" + extra));
    }

    // 有些站的 TLS 握手会被随机重置（curl/.NET/node 都偶发 ECONNRESET），重试两轮基本就过了。
    private async Task<Dictionary<string, object>> FetchWithRetry(JsonElement opts)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { return await FetchAsync(opts); }
            catch (Exception ex) when (attempt < 1 && IsTransientNetwork(ex))
            {
                RuleProcess.Log("fetch retry " + (attempt + 1) + ": " + ex.Message);
                await Task.Delay(400 * (attempt + 1));
            }
        }
    }

    private static bool IsTransientNetwork(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is not (System.Net.Http.HttpRequestException or System.IO.IOException or System.Net.Sockets.SocketException)) continue;
            var m = ((e.Message ?? "") + " " + (e.InnerException?.Message ?? "")).ToLowerInvariant();
            if (m.Contains("ssl") || m.Contains("socket") || m.Contains("reset") || m.Contains("prematurely") || m.Contains("connection") || m.Contains("forcibly")) return true;
        }
        return false;
    }

    private async Task<Dictionary<string, object>> FetchAsync(JsonElement opts)
    {
        string url = null;
        try
        {
            if (opts.ValueKind != JsonValueKind.Object) throw RuleProcess.Error("NET", "Network options must be an object");
            foreach (var p in opts.EnumerateObject())
                if (p.Name is not ("url" or "method" or "body" or "charset" or "requestCharset" or "lenientDecode" or "headers" or "referer" or "timeout"))
                    throw RuleProcess.Error("NET", "Network option denied: " + p.Name);
            url = StringOption(opts, "url");
            Uri current = HttpUri(url);
            string method = (StringOption(opts, "method") ?? "GET").ToUpperInvariant();
            if (method is not ("GET" or "HEAD" or "POST" or "PUT" or "PATCH" or "DELETE" or "OPTIONS"))
                throw RuleProcess.Error("NET", "HTTP method denied");
            string body = null;
            if (opts.TryGetProperty("body", out var b) && b.ValueKind != JsonValueKind.Null)
                body = b.ValueKind == JsonValueKind.String ? b.GetString() : b.GetRawText();
            string charset = StringOption(opts, "charset");
            string requestCharset = StringOption(opts, "requestCharset");
            bool lenientDecode = false;
            if (opts.TryGetProperty("lenientDecode", out var lenient) && lenient.ValueKind != JsonValueKind.Null)
            {
                if (lenient.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw RuleProcess.Error("NET", "Invalid boolean option: lenientDecode");
                lenientDecode = lenient.GetBoolean();
            }
            string referer = StringOption(opts, "referer");
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (opts.TryGetProperty("headers", out var h) && h.ValueKind != JsonValueKind.Null)
            {
                if (h.ValueKind != JsonValueKind.Object || h.EnumerateObject().Count() > 128) throw RuleProcess.Error("NET", "Invalid HTTP headers");
                foreach (var p in h.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.String) throw RuleProcess.Error("NET", "Header values must be strings");
                    string value = p.Value.GetString();
                    if (value.Length > 16384 || value.Contains('\r') || value.Contains('\n')) throw RuleProcess.Error("NET", "Invalid HTTP header");
                    headers[p.Name] = value;
                }
            }
            int timeout = 15000;
            if (opts.TryGetProperty("timeout", out var t) && t.ValueKind != JsonValueKind.Null)
            {
                if (t.ValueKind != JsonValueKind.Number || !t.TryGetInt32(out timeout) || timeout <= 0) throw RuleProcess.Error("NET", "Invalid HTTP timeout");
                timeout = Math.Min(timeout, 120000);
            }
            using var cancel = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
            cancel.CancelAfter(timeout);
            for (int redirects = 0; redirects <= 10; redirects++)
            {
                using var message = new HttpRequestMessage(new HttpMethod(method), current);
                if (body != null && method is not ("GET" or "HEAD"))
                    message.Content = NetworkEncoding.CreateContent(body, headers.GetValueOrDefault("Content-Type"), requestCharset);
                message.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36");
                message.Headers.TryAddWithoutValidation("Accept", "text/html,application/xhtml+xml,application/json,text/plain,*/*");
                message.Headers.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
                if (!string.IsNullOrEmpty(referer)) message.Headers.TryAddWithoutValidation("Referer", referer);
                foreach (var header in headers)
                {
                    // CreateContent owns Content-Type so a later header cannot contradict its body encoding.
                    if (header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) continue;
                    if (header.Key.StartsWith("Content-", StringComparison.OrdinalIgnoreCase) ||
                        header.Key.Equals("Expires", StringComparison.OrdinalIgnoreCase) ||
                        header.Key.Equals("Last-Modified", StringComparison.OrdinalIgnoreCase) ||
                        header.Key.Equals("Allow", StringComparison.OrdinalIgnoreCase))
                    {
                        if (message.Content == null) continue;
                        message.Content.Headers.Remove(header.Key);
                        message.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
                    }
                    else
                    {
                        message.Headers.Remove(header.Key);
                        message.Headers.TryAddWithoutValidation(header.Key, header.Value);
                    }
                }
                using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancel.Token);
                int status = (int)response.StatusCode;
                if (status is 301 or 302 or 303 or 307 or 308 && response.Headers.Location != null)
                {
                    if (redirects == 10) throw RuleProcess.Error("NET", "Too many redirects");
                    var next = HttpUri(new Uri(current, response.Headers.Location).AbsoluteUri);
                    if (!string.Equals(current.Authority, next.Authority, StringComparison.OrdinalIgnoreCase))
                    {
                        headers.Remove("Authorization"); headers.Remove("Proxy-Authorization"); headers.Remove("Cookie");
                    }
                    if (status == 303 && method != "HEAD" || status is 301 or 302 && method == "POST") { method = "GET"; body = null; }
                    current = next;
                    continue;
                }
                if (response.Content.Headers.ContentLength > MaxBodyBytes) throw RuleProcess.Error("NET", "HTTP response too large");
                using var stream = await response.Content.ReadAsStreamAsync(cancel.Token);
                using var buffer = new MemoryStream();
                byte[] chunk = new byte[8192];
                int read;
                while ((read = await stream.ReadAsync(chunk, cancel.Token)) > 0)
                {
                    if (buffer.Length + read > MaxBodyBytes) throw RuleProcess.Error("NET", "HTTP response too large");
                    buffer.Write(chunk, 0, read);
                }
                string contentType = response.Content.Headers.NonValidated.TryGetValues("Content-Type", out var types) ? string.Join("; ", types) : "";
                var decoded = Decode(buffer.ToArray(), contentType, charset, lenientDecode);
                return new Dictionary<string, object>
                {
                    ["ok"] = response.IsSuccessStatusCode, ["status"] = status, ["url"] = current.AbsoluteUri,
                    ["text"] = decoded.text, ["charset"] = decoded.charset, ["contentType"] = contentType
                };
            }
            throw RuleProcess.Error("NET", "Redirect failure");
        }
        catch (Exception e)
        {
            if (!e.Data.Contains("code")) e.Data["code"] = "NET";
            if (!e.Data.Contains("url")) e.Data["url"] = url ?? "";
            if (e is OperationCanceledException) e.Data["timeout"] = true;
            throw;
        }
    }

    private static Uri HttpUri(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw RuleProcess.Error("NET", "Only http/https URLs are allowed: " + url);
        return uri;
    }
    private static string StringOption(JsonElement opts, string key)
    {
        if (!opts.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String) throw RuleProcess.Error("NET", "Invalid string option: " + key);
        return value.GetString();
    }
    private static Dictionary<string, string> Query(Uri uri)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            int equal = pair.IndexOf('=');
            if (equal < 0 || !result.TryAdd(Uri.UnescapeDataString(pair.Substring(0, equal)),
                Uri.UnescapeDataString(pair.Substring(equal + 1).Replace("+", "%20"))))
                throw RuleProcess.Error("NET", "Invalid proxy query");
        }
        return result;
    }
    private static (string text, string charset) Decode(byte[] bytes, string contentType, string asked, bool lenient = false) =>
        NetworkEncoding.Decode(bytes, contentType, asked, lenient);

    private string Page()
    {
        // The task arrives over the bridge so a pooled worker can load the engine before it is known.
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>rule worker</title></head><body><script>" + Bridge +
            "</script><script src=\"/rule.js\"></script><script src=\"/legacy-js.js\"></script><script src=\"/legado.js\"></script><script>" +
            "(async function(){const req = await yedu.task();" + Dispatch + "})();</script></body></html>";
    }
    private const string Bridge = """
(function(){
  'use strict';
  const channel = chrome.webview;
  const post = channel.postMessage.bind(channel);
  const pending = new Map();
  let sequence = 0;
  let taskResolve = null;
  const taskPromise = new Promise(function(resolve){ taskResolve = resolve; });
  channel.addEventListener('message', function(ev){
    const m = ev.data;
    if (!m) return;
    if (m.kind === 'task') { if (taskResolve) taskResolve(JSON.parse(m.request)); taskResolve = null; return; }
    if (m.kind !== 'fetchResult') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else {
      const e = new Error(m.error.message);
      Object.keys(m.error.data || {}).forEach(k => Object.defineProperty(e, k, {value:m.error.data[k], enumerable:true}));
      p.reject(e);
    }
  });
  post({kind:'getTask'});
  Object.defineProperty(window, 'yedu', {value: Object.freeze({
    task: function(){ return taskPromise; },
    fetchText: function(opts){
      return new Promise(function(resolve,reject){
        const id = ++sequence;
        pending.set(id, {resolve,reject});
        try { post({kind:'fetchText',id,opts}); } catch(e) { pending.delete(id); reject(e); }
      });
    }
  }), writable:false, configurable:false});
})();
""";
    private const string Dispatch = """
'use strict';
const post = chrome.webview.postMessage.bind(chrome.webview);
const stringify = JSON.stringify.bind(JSON);
try {
const L = NR.legado;
const legacy = NR.legacyJs;
const state = req.state || {};
const src = req.source.kind === 'legado' ? req.source : Object.assign({}, req.source, L.normalize(req.source));
src.__vars = Object.assign(Object.create(null), state.vars || {});
Object.keys(state.sourceStore || {}).forEach(function(key){
  const old = state.sourceStore[key];
  legacy.sourceStore[key] = {key:key, map:Object.assign(Object.create(null),old.map || {}),
    raw:old.raw || '',loginInfo:old.loginInfo || '',loginHeader:old.loginHeader || ''};
});
Object.keys(state.memory || {}).forEach(function(key){
  legacy.memoryStore[key] = state.memory[key];
});
function returnedState(){
  const store = Object.create(null);
  Object.keys(legacy.sourceStore).forEach(function(key){
    const s = legacy.sourceStore[key];
    store[key] = {map:s.map,raw:s.raw,loginInfo:s.loginInfo,loginHeader:s.loginHeader};
  });
  return {sourceStore:store,vars:src.__vars || {},memory:legacy.memoryStore};
}
  const a = req.args;
  let value;
  switch(req.operation){
    case 'search': value = await L.search(src,a[0],a[1]); break;
    case 'explore': value = await L.explore(src,a[0]); break;
    case 'detail': value = await L.detail(src,a[0]); break;
    case 'catalog': value = await L.catalog(src,a[0],a[1]); break;
    case 'content': value = await L.content(src,a[0],a[1]); break;
    case 'test': value = await L.test(src,a[0]); break;
    case 'fetchPage': value = await L.fetchPage(src,a[0],a[1],a[2]); break;
    case 'decodeImage': value = await L.decodeImageBytes(a[0],a[1]); break;
    default: throw Object.assign(new Error('RULE_REQUEST: operation denied'),{code:'RULE_REQUEST'});
  }
  // __diag is non-enumerable and would otherwise be lost at the process boundary.
  const result = {value:value === undefined ? null : value,state:returnedState(),diag:value && value.__diag || {}};
  post(JSON.parse(stringify({kind:'done',envelope:{ok:true,result:result}})));
} catch(e) {
  const data = Object.create(null);
  Object.getOwnPropertyNames(Object(e)).forEach(function(k){
    if (k !== 'message' && k !== 'stack' && k !== 'name') data[k] = e[k];
  });
  if (!data.code) data.code = 'RULE';
  post(JSON.parse(stringify({kind:'done',envelope:{ok:false,error:{message:String(e && e.message || e),data:data}}})));
}
""";

    public void Dispose()
    {
        stop.Cancel();
        view?.Dispose();
        form?.Dispose();
        http.Dispose();
        stop.Dispose();
    }
}
