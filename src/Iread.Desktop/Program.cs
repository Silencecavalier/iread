/* =========================================================================
 * Program.cs — WebView2 同步 XHR spike (多模式版 v2)
 *
 * 要回答的唯一问题：
 *   在 WebView2 里，页面能不能对「注册过的自定义 scheme」发**同步** XHR，
 *   并且拿到 WebResourceRequested 里**异步产生**的响应？
 *
 * 用法：
 *   Spike.exe <resultJsonPath> [mode]
 *
 * 模式：
 *   base  https 页面 + HasAuthority=true + Task.Run 后台线程直接设 args.Response（原版写法）
 *   A     同源：页面由 yedu-net://app/index.html 提供，同步 XHR 打同源 yedu-net://app/echo
 *   B     完全同步响应：handler 里直接 args.Response=...（无 deferral、无 Task.Run）
 *   C     无 authority：HasAuthorityComponent=false，URL 形如 yedu-net:net?u=...
 *   D     不加 CORS 头
 *   E     异步 + 正确编组：deferral + Task.Run(150ms) + BeginInvoke 回 UI 线程设 Response
 *   H     同 E，但延迟 1500ms
 *   I     同 E，但延迟 5000ms
 *   G     base + --disable-web-security
 *   J     同 E，但响应体 2 MB
 *
 *   ---- 第二轮新增（K–O，A–J 行为不变）----
 *   K     POST 同步 XHR：Content-Type: application/json + body，宿主读 method/headers/body
 *   L     自定义请求头 X-Test + Cookie（另加 cookie jar 与同源对照）
 *   M     同一页连续 5 个同步 XHR（宿主每个延迟 120ms）
 *   N     3 个 iframe 各发一个同步 XHR（宿主每个延迟 300ms）——测并行/串行
 *   O     同步 XHR 到 302->200 / 404 / 500，看 status / responseText / 是否抛异常
 *
 * 防挂死：harness 每完成一个观测点就 chrome.webview.postMessage 快照，宿主立刻落盘，
 *         即使后续同步 XHR 卡死 renderer，已有结果也不丢。
 * ========================================================================= */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal enum AsyncStyle
{
    OffThread,     // 原版：Task.Run + 后台线程直接碰 args.Response（COM 跨线程，会炸）
    Sync,          // 完全同步，无 deferral
    UiMarshaled    // deferral + 后台延迟 + BeginInvoke 回 UI 线程设 Response（正确写法）
}

internal sealed class Cfg
{
    public string Mode = "base";
    public string PageUrl = "https://app.local/index.html";
    public bool HasAuthority = true;
    public bool CorsHeader = true;
    public AsyncStyle Async = AsyncStyle.OffThread;
    public string AdditionalBrowserArguments = null;
    public string CustomSyncUrl = "yedu-net://net/?u=sync";
    public string CustomAsyncUrl = "yedu-net://net/?u=async";
    public int DelayMs = 150;
    public int PostNavWaitMs = 2000;
    public int BodyPadBytes = 0;      // 给 yedu-net 响应加填充，测试大 body
    public string ExtBase = "yedu-net://net";   // K/L 系列请求的 base URL
}

/// <summary>
/// 宿主侧对单个被拦截请求的观测记录（mode K/L 用来看 method / headers / body）。
/// </summary>
internal sealed class ReqRec
{
    public string uri = "";
    public string method = "";
    public long atMs;
    public readonly Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public string headerDump = "";
    public string headerErr;
    public readonly Dictionary<string, string> headerErrors = new Dictionary<string, string>();
    public string xTest;
    public string cookie;
    public string contentType;
    public string contentLength;
    public int bodyBytes = -1;
    public string bodyText;
    public string bodyErr;
    public long bodyReadMs = -1;

    public string Get(string name)
    {
        string v;
        return headers.TryGetValue(name, out v) ? v : null;
    }
}

internal static class Program
{
    private static string _outFile;
    private static string _hostFile;
    private static Cfg _cfg;
    private static readonly List<string> HostLog = new List<string>();
    private static readonly List<ReqRec> Requests = new List<ReqRec>();
    private static readonly object Lock = new object();
    private static string _lastSnapshot = null;
    private static bool _finalized;
    private static Form _form;
    private static readonly Stopwatch Sw = new Stopwatch();

    [STAThread]
    private static void Main(string[] args)
    {
        // Must precede all UI/data/log initialization; workers never enter IreadHost.
        if (args.Length > 0 && args[0] == "--rule-worker")
        {
            if (args.Length == 2) RuleWorkerHost.Run(args[1]);
            else Environment.ExitCode = 2;
            return;
        }
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        _outFile = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "result.json");
        var mode = args.Length > 1 ? args[1] : "iread";   // 转正：无参默认 iread 模式
        if (string.Equals(mode, "iread", StringComparison.OrdinalIgnoreCase))
        {
            IreadHost.Run(args);   // iread 换壳实验：完全独立的宿主流程
            return;
        }
        _cfg = BuildCfg(mode);
        _hostFile = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(_outFile)) ?? ".",
            "wv2-" + _cfg.Mode + ".host.json");

        Application.EnableVisualStyles();

        _form = new Form
        {
            Width = 900,
            Height = 700,
            ShowInTaskbar = false,
            StartPosition = FormStartPosition.Manual,
            Location = new System.Drawing.Point(-4000, -4000),   // 屏幕外，但保持渲染
            Text = "webview2 sync-xhr spike [" + _cfg.Mode + "]"
        };
        var wv = new WebView2 { Dock = DockStyle.Fill };
        _form.Controls.Add(wv);
        _form.Shown += async (s, e) => await RunAsync(wv);
        Application.Run(_form);
    }

    private static Cfg BuildCfg(string mode)
    {
        var c = new Cfg { Mode = mode };
        switch (mode)
        {
            case "A":
                c.PageUrl = "yedu-net://app/index.html";
                c.CustomSyncUrl = "yedu-net://app/echo?u=sync";
                c.CustomAsyncUrl = "yedu-net://app/echo?u=async";
                c.Async = AsyncStyle.UiMarshaled;
                break;
            case "B":
                c.Async = AsyncStyle.Sync;
                break;
            case "C":
                c.HasAuthority = false;
                c.CustomSyncUrl = "yedu-net:net?u=sync";
                c.CustomAsyncUrl = "yedu-net:net?u=async";
                c.Async = AsyncStyle.UiMarshaled;
                break;
            case "D":
                c.CorsHeader = false;
                c.Async = AsyncStyle.UiMarshaled;
                break;
            case "E":
                c.Async = AsyncStyle.UiMarshaled;
                break;
            case "H":
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 1500;
                break;
            case "I":
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 5000;
                break;
            case "G":
                c.AdditionalBrowserArguments = "--disable-web-security";
                c.Async = AsyncStyle.UiMarshaled;
                break;
            case "J":
                c.Async = AsyncStyle.UiMarshaled;
                c.BodyPadBytes = 2 * 1024 * 1024;   // 2 MB 响应体
                break;

            /* ---------------- 本轮新增：K / L / M / N / O ---------------- */
            case "K":   // POST 同步 XHR：body / method / Content-Type / 读请求体
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 150;
                c.PostNavWaitMs = 4000;
                break;
            case "L":   // 自定义请求头 X-Test / Cookie
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 150;
                c.PostNavWaitMs = 4000;
                break;
            case "M":   // 连续 5 个同步 XHR（同一页，串行）
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 120;
                c.PostNavWaitMs = 4000;
                break;
            case "N":   // 3 个 iframe 各发一个同步 XHR（并行 or 串行）
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 300;
                c.PostNavWaitMs = 5000;
                break;
            case "O":   // 302 -> 200 / 404 / 500
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 100;
                c.PostNavWaitMs = 4000;
                break;
            /* 同源对照：页面本身由 yedu-net://app 提供（真实换壳架构就是这个形态） */
            case "K2":
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 150;
                c.PostNavWaitMs = 4000;
                c.PageUrl = "yedu-net://app/index.html";
                c.ExtBase = "yedu-net://app";
                break;
            case "L2":
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 150;
                c.PostNavWaitMs = 4000;
                c.PageUrl = "yedu-net://app/index.html";
                c.ExtBase = "yedu-net://app";
                break;
            /* 旁支实验：把 yedu-net 页面当作 iframe 嵌进 https 页面，看它自己能不能发 XHR */
            case "P":
                c.Async = AsyncStyle.UiMarshaled;
                c.DelayMs = 150;
                c.PostNavWaitMs = 6000;
                break;
        }
        return c;
    }

    private static void Log(string line)
    {
        lock (Lock)
        {
            var s = "[" + Sw.ElapsedMilliseconds + "ms] " + line;
            HostLog.Add(s);
            Console.WriteLine(s);
            Console.Out.Flush();
        }
    }

    private static async Task RunAsync(WebView2 wv)
    {
        Sw.Start();
        try
        {
            var userData = Path.Combine(Path.GetTempPath(), "wv2spike-" + _cfg.Mode + "-" + Guid.NewGuid().ToString("N"));

            // 注意：默认构造的 CoreWebView2EnvironmentOptions.CustomSchemeRegistrations 为 null，
            //       必须用带 List<CoreWebView2CustomSchemeRegistration> 的构造函数。
            var reg = new CoreWebView2CustomSchemeRegistration("yedu-net")
            {
                TreatAsSecure = true,
                HasAuthorityComponent = _cfg.HasAuthority
            };
            reg.AllowedOrigins.Add("https://app.local");
            reg.AllowedOrigins.Add("yedu-net://app");
            var regs = new List<CoreWebView2CustomSchemeRegistration> { reg };
            var opts = new CoreWebView2EnvironmentOptions(
                _cfg.AdditionalBrowserArguments, null, null, false, regs);
            Log("mode=" + _cfg.Mode + " scheme=yedu-net hasAuthority=" + _cfg.HasAuthority
                + " cors=" + _cfg.CorsHeader + " async=" + _cfg.Async + " delayMs=" + _cfg.DelayMs
                + " args=" + (_cfg.AdditionalBrowserArguments ?? "(none)"));

            var env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
            await wv.EnsureCoreWebView2Async(env);
            Log("env ok, runtime=" + env.BrowserVersionString);

            var core = wv.CoreWebView2;
            core.AddWebResourceRequestedFilter("https://app.local/*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("yedu-net://*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("yedu-net:*", CoreWebView2WebResourceContext.All);

            // mode L：往 CookieManager 里塞一个 app.local 的 cookie，
            // 用来验证「浏览器真实 cookie jar 的 Cookie 会不会出现在 WRR 的请求头里」
            if (_cfg.Mode == "L")
            {
                try
                {
                    var cm = core.CookieManager;
                    var ck = cm.CreateCookie("lck", "1", "app.local", "/");
                    cm.AddOrUpdateCookie(ck);
                    Log("cookie added: lck=1 domain=app.local path=/");
                }
                catch (Exception ex) { Log("cookie add err: " + Err(ex)); }
            }

            core.WebMessageReceived += (s, a) =>
            {
                try
                {
                    var msg = a.TryGetWebMessageAsString();
                    lock (Lock)
                    {
                        _lastSnapshot = msg;
                        try { File.WriteAllText(_outFile, msg, new UTF8Encoding(false)); } catch { }
                    }
                    Log("snapshot <- renderer (" + (msg == null ? 0 : msg.Length) + " chars)");
                }
                catch (Exception ex) { Log("webmessage err: " + ex.Message); }
            };

            core.WebResourceRequested += (s, a) => Handle(core, a);

            var done = new TaskCompletionSource<bool>();
            core.NavigationCompleted += async (s, a) =>
            {
                Log("nav completed: success=" + a.IsSuccess + " status=" + a.WebErrorStatus);
                await Task.Delay(_cfg.PostNavWaitMs);
                await FinalizeAsync(core, "navCompleted");
                done.TrySetResult(true);
            };

            // 总看门狗：22s 强制收尾（同步 XHR 卡死时 ExecuteScriptAsync 永不返回）
            _ = Task.Run(async () =>
            {
                await Task.Delay(22000);
                try
                {
                    if (_form != null && _form.IsHandleCreated)
                        _form.BeginInvoke(new Action(async () =>
                        {
                            Log("WATCHDOG fired at 22s - renderer likely blocked");
                            await FinalizeAsync(core, "watchdog");
                            try { _form.Close(); } catch { }
                        }));
                }
                catch { }
            });

            Log("navigate -> " + _cfg.PageUrl);
            core.Navigate(_cfg.PageUrl);
            await done.Task;
            try { _form.Close(); } catch { }
        }
        catch (Exception ex)
        {
            Log("FATAL: " + ex);
            try
            {
                File.WriteAllText(_outFile,
                    "{\"fatal\":\"" + ex.Message.Replace("\\", "\\\\").Replace("\"", "'") + "\"}",
                    new UTF8Encoding(false));
            }
            catch { }
            try { _form.Close(); } catch { }
        }
        finally
        {
            WriteHostFile("end");
        }
    }

    private static async Task FinalizeAsync(CoreWebView2 core, string reason)
    {
        if (_finalized) return;
        _finalized = true;
        string finalRead = null;
        bool timedOut = false;
        try
        {
            var task = core.ExecuteScriptAsync("JSON.stringify(window.__result || {})");
            if (await Task.WhenAny(task, Task.Delay(3000)) == task)
            {
                var json = await task;
                finalRead = json;
                if (finalRead != null && finalRead.Length >= 2 && finalRead[0] == '"')
                    finalRead = JsonSerializer.Deserialize<string>(finalRead);
                Log("final read ok (" + (finalRead ?? "").Length + " chars)");
                lock (Lock)
                {
                    _lastSnapshot = finalRead;
                    try { File.WriteAllText(_outFile, finalRead, new UTF8Encoding(false)); } catch { }
                }
            }
            else
            {
                timedOut = true;
                Log("final read TIMED OUT after 3s (renderer main thread blocked) - using last snapshot");
            }
        }
        catch (Exception ex)
        {
            Log("final read err: " + ex.Message);
        }
        WriteHostFile(reason + " finalReadTimedOut=" + timedOut);
    }

    private static void WriteHostFile(string reason)
    {
        try
        {
            List<object> reqs;
            lock (Lock)
            {
                reqs = Requests.Select(r => (object)new
                {
                    atMs = r.atMs,
                    uri = r.uri,
                    method = r.method,
                    headerDump = r.headerDump,
                    headerErr = r.headerErr,
                    xTest = r.xTest,
                    cookie = r.cookie,
                    contentType = r.contentType,
                    contentLength = r.contentLength,
                    bodyBytes = r.bodyBytes,
                    bodyText = r.bodyText,
                    bodyErr = r.bodyErr,
                    bodyReadMs = r.bodyReadMs,
                    headerErrors = r.headerErrors
                }).ToList();
            }

            var obj = new
            {
                mode = _cfg.Mode,
                pageUrl = _cfg.PageUrl,
                hasAuthority = _cfg.HasAuthority,
                corsHeader = _cfg.CorsHeader,
                asyncStyle = _cfg.Async.ToString(),
                delayMs = _cfg.DelayMs,
                additionalBrowserArguments = _cfg.AdditionalBrowserArguments,
                customSyncUrl = _cfg.CustomSyncUrl,
                customAsyncUrl = _cfg.CustomAsyncUrl,
                reason,
                elapsedMs = Sw.ElapsedMilliseconds,
                lastSnapshot = _lastSnapshot,
                requests = reqs,
                hostLog = HostLog.ToArray()
            };
            File.WriteAllText(_hostFile, JsonSerializer.Serialize(obj, new JsonSerializerOptions { WriteIndented = true }),
                new UTF8Encoding(false));
        }
        catch { }
    }

    private static void Handle(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var uri = "";
        var method = "";
        try { uri = args.Request.Uri ?? ""; } catch { }
        try { method = args.Request.Method ?? ""; } catch { }
        Log("WRR uri=" + uri + " method=" + method);

        // 宿主侧观测：method / 全部请求头 / 请求体（K、L 需要）
        ReqRec rec;
        try { rec = CaptureRequest(args); }
        catch (Exception ex) { rec = new ReqRec { uri = uri, method = method, bodyErr = Err(ex) }; }
        lock (Lock) { Requests.Add(rec); }
        if (rec.headerDump != null && rec.headerDump.Length > 0)
            Log("  headers[" + Requests.Count + "]=" + rec.headerDump.Replace("\n", " | ").Replace("\r", ""));
        if (rec.bodyBytes >= 0)
            Log("  body[" + Requests.Count + "] bytes=" + rec.bodyBytes + " readMs=" + rec.bodyReadMs
                + " text=" + (rec.bodyText == null ? "(null)" : rec.bodyText));
        if (rec.bodyErr != null) Log("  body[" + Requests.Count + "] READ-ERR " + rec.bodyErr);

        if (_cfg.Async == AsyncStyle.Sync)
        {
            // 变体 B：完全同步，不拿 deferral
            try { RespondCore(core, args, uri, rec); }
            catch (Exception ex) { Log("handler(Sync) err: " + Err(ex)); }
            return;
        }

        // 预检 / iframe 文档：立即同步回，避免把延迟算进测量
        if (ShouldRespondImmediately(uri, method))
        {
            try { RespondCore(core, args, uri, rec); }
            catch (Exception ex) { Log("handler(Immediate) err: " + Err(ex)); }
            return;
        }

        if (_cfg.Async == AsyncStyle.UiMarshaled)
        {
            // 变体 E/H/I/K/L/M/N/O：真正异步产生响应，但编组回 UI 线程设置 Response + Complete deferral
            var deferral = args.GetDeferral();
            var delay = _cfg.DelayMs;
            Task.Run(async () =>
            {
                await Task.Delay(delay);
                try
                {
                    _form.BeginInvoke(new Action(() =>
                    {
                        try
                        {
                            Log("marshaled respond after " + delay + "ms -> " + uri);
                            RespondCore(core, args, uri, rec);
                        }
                        catch (Exception ex) { Log("handler(Marshaled) err: " + Err(ex)); }
                        finally
                        {
                            try { deferral.Complete(); }
                            catch (Exception ex) { Log("deferral.Complete err: " + Err(ex)); }
                        }
                    }));
                }
                catch (Exception ex) { Log("BeginInvoke err: " + Err(ex)); }
            });
            return;
        }

        // base/C/D/G：原版写法 —— 后台线程直接碰 args（预期会 COM 跨线程失败）
        var d2 = args.GetDeferral();
        Task.Run(async () =>
        {
            try
            {
                await Task.Delay(_cfg.DelayMs);
                RespondCore(core, args, uri, rec);
            }
            catch (Exception ex)
            {
                Log("handler(OffThread) err: " + Err(ex));
                try { Respond(core, args, 500, "Error", "text/plain", "handler error"); }
                catch (Exception ex2) { Log("handler(OffThread) fallback err: " + Err(ex2)); }
            }
            finally
            {
                try { d2.Complete(); }
                catch (Exception ex) { Log("deferral.Complete err: " + Err(ex)); }
            }
        });
    }

    private static string Err(Exception ex) => ex.GetType().Name + ": " + (ex.Message ?? "").Split('\n')[0];

    private static bool IsExtMode
    {
        get
        {
            var m = _cfg.Mode;
            return m == "K" || m == "L" || m == "M" || m == "N" || m == "O"
                || m == "K2" || m == "L2" || m == "P";
        }
    }

    private static bool ShouldRespondImmediately(string uri, string method)
    {
        // CORS 预检：立即回，不占延迟
        if (string.Equals(method, "OPTIONS", StringComparison.OrdinalIgnoreCase)) return true;
        if (!IsExtMode) return false;
        // iframe 文档 / 同源探针文档：立即回，否则会把宿主延迟叠加到整体耗时里
        return uri.IndexOf("/f1.html", StringComparison.OrdinalIgnoreCase) >= 0
            || uri.IndexOf("/f2.html", StringComparison.OrdinalIgnoreCase) >= 0
            || uri.IndexOf("/f3.html", StringComparison.OrdinalIgnoreCase) >= 0
            || uri.IndexOf("/ext.html", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    /// <summary>
    /// 在 UI 线程上（拿 deferral 之前）把请求的 method / headers / body 全部读出来。
    /// body 通过 args.Request.Content（Stream）读取；读不到就把原因写进 bodyErr。
    /// </summary>
    private static ReqRec CaptureRequest(CoreWebView2WebResourceRequestedEventArgs args)
    {
        var rec = new ReqRec { atMs = Sw.ElapsedMilliseconds };
        try { rec.uri = args.Request.Uri ?? ""; } catch (Exception ex) { rec.headerErr = "uri: " + Err(ex); }
        try { rec.method = args.Request.Method ?? ""; } catch (Exception ex) { rec.headerErr = "method: " + Err(ex); }

        try
        {
            var h = args.Request.Headers;
            var sb = new StringBuilder();
            foreach (var kv in h)   // CoreWebView2HttpRequestHeaders : IEnumerable<KeyValuePair<string,string>>
            {
                var n = kv.Key;
                var v = kv.Value;
                sb.Append(n).Append(": ").Append(v).Append('\n');
                if (n != null) rec.headers[n] = v;
            }
            rec.headerDump = sb.ToString();
        }
        catch (Exception ex) { rec.headerErr = "headers: " + Err(ex); }

        rec.xTest = TryHeader(args, rec, "X-Test");
        rec.cookie = TryHeader(args, rec, "Cookie");
        rec.contentType = TryHeader(args, rec, "Content-Type");
        rec.contentLength = TryHeader(args, rec, "Content-Length");

        // 只对非 GET/HEAD 读 body（避免给 A–J 的普通请求增加任何风险）
        var m = rec.method ?? "";
        var hasBody = !string.Equals(m, "GET", StringComparison.OrdinalIgnoreCase)
                   && !string.Equals(m, "HEAD", StringComparison.OrdinalIgnoreCase)
                   && !string.Equals(m, "OPTIONS", StringComparison.OrdinalIgnoreCase);
        if (hasBody)
        {
            var t0 = Sw.ElapsedMilliseconds;
            try
            {
                var s = args.Request.Content;
                if (s == null)
                {
                    rec.bodyErr = "args.Request.Content == null";
                }
                else
                {
                    using (var ms = new MemoryStream())
                    {
                        var buf = new byte[8192];
                        int n;
                        while ((n = s.Read(buf, 0, buf.Length)) > 0)
                        {
                            ms.Write(buf, 0, n);
                            if (ms.Length > 8 * 1024 * 1024) { rec.bodyErr = "truncated at 8MB"; break; }
                        }
                        var bytes = ms.ToArray();
                        rec.bodyBytes = bytes.Length;
                        rec.bodyText = Encoding.UTF8.GetString(bytes);
                    }
                }
            }
            catch (Exception ex) { rec.bodyErr = "content: " + Err(ex); }
            rec.bodyReadMs = Sw.ElapsedMilliseconds - t0;
        }
        return rec;
    }

    private static string TryHeader(CoreWebView2WebResourceRequestedEventArgs args, ReqRec rec, string name)
    {
        try
        {
            var v = args.Request.Headers.GetHeader(name);
            return v;
        }
        catch (Exception ex)
        {
            rec.headerErrors[name] = Err(ex);
            return null;
        }
    }

    private static void RespondCore(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs args, string uri, ReqRec rec)
    {
        if (IsExtMode && RespondExt(core, args, uri, rec)) return;

        var isPage = uri.IndexOf("/index.html", StringComparison.OrdinalIgnoreCase) >= 0;
        var isEcho = uri.IndexOf("/echo", StringComparison.OrdinalIgnoreCase) >= 0;

        if (isPage)
        {
            Log("respond page 200 -> " + uri);
            Respond(core, args, 200, "OK", "Content-Type: text/html; charset=utf-8",
                IsExtMode ? HarnessExt() : Harness());
        }
        else if (isEcho)
        {
            Log("respond echo 200 -> " + uri);
            Respond(core, args, 200, "OK",
                "Content-Type: application/json" + Cors(),
                "{\"via\":\"echo\",\"uri\":\"" + Esc(uri) + "\"}");
        }
        else if (uri.StartsWith("yedu-net", StringComparison.OrdinalIgnoreCase))
        {
            var body = "{\"via\":\"yedu-net\",\"uri\":\"" + Esc(uri) + "\"";
            if (_cfg.BodyPadBytes > 0)
                body += ",\"pad\":\"" + new string('x', _cfg.BodyPadBytes) + "\"";
            body += "}";
            Log("respond yedu-net 200 -> " + uri + " (body " + body.Length + " bytes)");
            Respond(core, args, 200, "OK", "Content-Type: application/json" + Cors(), body);
        }
        else
        {
            Log("respond 404 -> " + uri);
            Respond(core, args, 404, "Not Found", "Content-Type: text/plain", "not found");
        }
    }

    private static string Cors() => _cfg.CorsHeader ? "\r\nAccess-Control-Allow-Origin: *" : "";

    /* ===================== 本轮新增：K / L / M / N / O 的端点 ===================== */

    private static string PreflightHeaders()
    {
        return "Access-Control-Allow-Origin: *"
             + "\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS"
             + "\r\nAccess-Control-Allow-Headers: Content-Type, X-Test"
             + "\r\nAccess-Control-Max-Age: 600";
    }

    private static string EchoJson(string via, string uri, ReqRec rec)
    {
        var sb = new StringBuilder();
        sb.Append("{\"via\":\"").Append(Esc(via)).Append("\"");
        sb.Append(",\"uri\":\"").Append(Esc(uri)).Append("\"");
        sb.Append(",\"method\":\"").Append(Esc(rec.method ?? "")).Append("\"");
        sb.Append(",\"bodyBytes\":").Append(rec.bodyBytes);
        sb.Append(",\"body\":\"").Append(Esc(rec.bodyText ?? "")).Append("\"");
        sb.Append(",\"contentType\":\"").Append(Esc(rec.contentType ?? "")).Append("\"");
        sb.Append(",\"xTest\":\"").Append(Esc(rec.xTest ?? "")).Append("\"");
        sb.Append(",\"cookie\":\"").Append(Esc(rec.cookie ?? "")).Append("\"");
        sb.Append("}");
        return sb.ToString();
    }

    /// <summary>返回 true 表示这个 uri 已被新增模式处理。</summary>
    private static bool RespondExt(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs args,
        string uri, ReqRec rec)
    {
        var m = rec.method ?? "";
        var json = "Content-Type: application/json" + Cors();

        // CORS 预检：跨源 POST+JSON / 自定义头会先发 OPTIONS，必须在这里放行
        if (string.Equals(m, "OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            Log("respond PREFLIGHT 200 -> " + uri
                + " req-method=" + (rec.Get("Access-Control-Request-Method") ?? "-")
                + " req-headers=" + (rec.Get("Access-Control-Request-Headers") ?? "-"));
            Respond(core, args, 200, "OK", PreflightHeaders(), "");
            return true;
        }

        // 同源探针页：页面本身由 yedu-net://app 提供，打 yedu-net://app/... 就是同源
        if (uri.IndexOf("/ext.html", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Log("respond ext-probe page 200 -> " + uri);
            Respond(core, args, 200, "OK", "Content-Type: text/html; charset=utf-8", ExtSameOriginHarness());
            return true;
        }

        // mode N 的 iframe 文档
        if (uri.IndexOf("/f1.html", StringComparison.OrdinalIgnoreCase) >= 0
            || uri.IndexOf("/f2.html", StringComparison.OrdinalIgnoreCase) >= 0
            || uri.IndexOf("/f3.html", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Log("respond iframe doc 200 -> " + uri);
            Respond(core, args, 200, "OK", "Content-Type: text/html; charset=utf-8", IframeHarness());
            return true;
        }

        // mode O：302 -> 200 / 404 / 500
        if (uri.IndexOf("/o302-target", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Log("respond redirect-target 200 -> " + uri);
            Respond(core, args, 200, "OK", json,
                "{\"via\":\"redirect-target\",\"uri\":\"" + Esc(uri) + "\"}");
            return true;
        }
        if (uri.IndexOf("/o302", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Log("respond 302 Location=yedu-net://net/o302-target -> " + uri);
            Respond(core, args, 302, "Found",
                "Location: yedu-net://net/o302-target\r\nContent-Type: text/plain" + Cors(), "redirecting");
            return true;
        }
        if (uri.IndexOf("/o404", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Log("respond 404 -> " + uri);
            Respond(core, args, 404, "Not Found", "Content-Type: text/plain; charset=utf-8" + Cors(),
                "not-found-body-中文");
            return true;
        }
        if (uri.IndexOf("/o500", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Log("respond 500 -> " + uri);
            Respond(core, args, 500, "Internal Server Error", "Content-Type: text/plain; charset=utf-8" + Cors(),
                "boom-500-body-中文");
            return true;
        }

        // K / L / M / N 的 JSON 端点：把宿主看到的 method/headers/body 回显给渲染侧
        string via = null;
        if (uri.IndexOf("/k-post-json", StringComparison.OrdinalIgnoreCase) >= 0) via = "post-json";
        else if (uri.IndexOf("/k-post-text", StringComparison.OrdinalIgnoreCase) >= 0) via = "post-text";
        else if (uri.IndexOf("/k-post-nc", StringComparison.OrdinalIgnoreCase) >= 0) via = "post-no-ctype";
        else if (uri.IndexOf("/l-cookie-only", StringComparison.OrdinalIgnoreCase) >= 0) via = "cookie-only";
        else if (uri.IndexOf("/l-cookie-jar", StringComparison.OrdinalIgnoreCase) >= 0) via = "cookie-jar";
        else if (uri.IndexOf("/l-headers", StringComparison.OrdinalIgnoreCase) >= 0) via = "headers";
        else if (uri.IndexOf("/m/item", StringComparison.OrdinalIgnoreCase) >= 0) via = "m-item";
        else if (uri.IndexOf("/n/iframe", StringComparison.OrdinalIgnoreCase) >= 0) via = "n-iframe";

        if (via != null)
        {
            Log("respond " + via + " 200 -> " + uri);
            Respond(core, args, 200, "OK", json, EchoJson(via, uri, rec));
            return true;
        }

        return false;
    }

    private static void Respond(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs args,
        int status, string reason, string headers, string body)
    {
        var stream = new MemoryStream(Encoding.UTF8.GetBytes(body));
        args.Response = core.Environment.CreateWebResourceResponse(stream, status, reason, headers);
    }

    private static string Esc(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static string Harness()
    {
        var httpsEcho = "https://app.local/echo";
        var badScheme = "yedu-bad://x/y";
        var tpl = """
<!doctype html>
<html><head><meta charset="utf-8"><title>spike</title></head>
<body>
<div id="out">running</div>
<script>
window.__result = { mode: "__MODE__", href: String(location.href), origin: String(location.origin) };

function snap(tag) {
  window.__result.lastStep = tag;
  try { chrome.webview.postMessage(JSON.stringify(window.__result)); } catch (e) {}
  try { document.getElementById('out').textContent = JSON.stringify(window.__result); } catch (e) {}
}

function syncXhr(url) {
  var t0 = Date.now();
  var xhr = new XMLHttpRequest();
  try {
    xhr.open('GET', url, false);          // <- 同步
    xhr.send(null);
    return {
      ok: true, status: xhr.status, ms: Date.now() - t0,
      bodyLen: String(xhr.responseText || '').length,
      body: String(xhr.responseText || '').slice(0, 200),
      headers: String(xhr.getAllResponseHeaders() || '').slice(0, 300)
    };
  } catch (e) {
    return { ok: false, error: String(e.name) + ': ' + String(e.message), ms: Date.now() - t0,
             status: (function(){ try { return xhr.status; } catch (x) { return -1; } })() };
  }
}

function asyncXhr(url, cb) {
  var t0 = Date.now();
  var xhr = new XMLHttpRequest();
  try {
    xhr.open('GET', url, true);
    xhr.onload = function () { cb({ ok: true, status: xhr.status, ms: Date.now() - t0,
        bodyLen: String(xhr.responseText || '').length,
        body: String(xhr.responseText || '').slice(0, 200),
        headers: String(xhr.getAllResponseHeaders() || '').slice(0, 300) }); };
    xhr.onerror = function () { cb({ ok: false, error: 'onerror (network error)', ms: Date.now() - t0, status: xhr.status }); };
    xhr.send(null);
  } catch (e) { cb({ ok: false, error: String(e.name) + ': ' + String(e.message), ms: Date.now() - t0 }); }
}

snap('start');

// 先发异步请求，避免被后面的同步请求阻塞
asyncXhr('__CUSTOM_ASYNC__', function (r) { window.__result.asyncCustom = r; snap('asyncCustom'); });

window.__result.syncHttps = syncXhr('__HTTPS_ECHO__');       snap('syncHttps');
window.__result.syncCustom = syncXhr('__CUSTOM_SYNC__');     snap('syncCustom');
window.__result.syncBad = syncXhr('__BAD_SCHEME__');         snap('syncBad');
window.__result.done = true;                                  snap('done');
</script>
</body></html>
""";
        return tpl
            .Replace("__MODE__", _cfg.Mode)
            .Replace("__HTTPS_ECHO__", httpsEcho)
            .Replace("__CUSTOM_SYNC__", _cfg.CustomSyncUrl)
            .Replace("__CUSTOM_ASYNC__", _cfg.CustomAsyncUrl)
            .Replace("__BAD_SCHEME__", badScheme);
    }

    /* ================= 本轮新增：K / L / M / N / O 的 harness ================= */

    private static string HarnessExt()
    {
        var common = """
function snap(tag) {
  window.__result.lastStep = tag;
  try { chrome.webview.postMessage(JSON.stringify(window.__result)); } catch (e) {}
  try { document.getElementById('out').textContent = JSON.stringify(window.__result); } catch (e) {}
}
function req(method, url, headers, body) {
  var t0 = Date.now();
  var xhr = new XMLHttpRequest();
  var hdrs = headers || {};
  var hdrSet = {};
  try {
    xhr.open(method, url, false);
    for (var k in hdrs) {
      try { xhr.setRequestHeader(k, hdrs[k]); hdrSet[k] = 'ok'; }
      catch (se) { hdrSet[k] = String(se.name) + ': ' + String(se.message); }
    }
    xhr.send(body === undefined ? null : body);
    return { ok: true, status: xhr.status, ms: Date.now() - t0,
             bodyLen: String(xhr.responseText || '').length,
             body: String(xhr.responseText || '').slice(0, 500),
             headers: String(xhr.getAllResponseHeaders() || '').slice(0, 400),
             responseURL: String(xhr.responseURL || ''),
             setRequestHeaderResult: hdrSet };
  } catch (e) {
    return { ok: false, error: String(e.name) + ': ' + String(e.message), ms: Date.now() - t0,
             status: (function () { try { return xhr.status; } catch (x) { return -1; } })(),
             setRequestHeaderResult: hdrSet };
  }
}
function extProbe() {
  window.__result.sameOrigin = 'pending';
  window.addEventListener('message', function (ev) {
    try {
      if (ev.data && ev.data.__ext) { window.__result.sameOrigin = ev.data.out; snap('sameOrigin'); }
      else if (ev.data && ev.data.__extErr) { window.__result.sameOrigin = { error: ev.data.__extErr }; snap('sameOriginErr'); }
    } catch (e) {}
  });
  var f = document.createElement('iframe');
  f.src = 'yedu-net://app/ext.html';
  document.body.appendChild(f);
}
""";

        var body = "";
        switch (_cfg.Mode)
        {
            case "K":
            case "K2":
                body = """
window.__result.kPostJson = req('POST', '__BASE__/k-post-json', {'Content-Type': 'application/json'}, '{"q":"中文"}');
snap('kPostJson');
window.__result.kPostText = req('POST', '__BASE__/k-post-text', {'Content-Type': 'text/plain;charset=UTF-8'}, 'plain-body-中文');
snap('kPostText');
window.__result.kPostNoCtype = req('POST', '__BASE__/k-post-nc', {}, 'no-ctype-body');
snap('kPostNoCtype');
__EXTPROBE__
window.__result.done = true;
snap('kDone');
""";
                break;
            case "L":
            case "L2":
                body = """
window.__result.lHeaders = req('GET', '__BASE__/l-headers', {'X-Test': 'v1', 'Cookie': 'a=b'}, null);
snap('lHeaders');
window.__result.lCookieJar = req('GET', 'https://app.local/l-cookie-jar', {}, null);
snap('lCookieJar');
window.__result.lCookieOnly = req('GET', '__BASE__/l-cookie-only', {'Cookie': 'c=d'}, null);
snap('lCookieOnly');
__EXTPROBE__
window.__result.done = true;
snap('lDone');
""";
                break;
            case "M":
                body = """
var mItems = [];
var mT0 = Date.now();
for (var i = 0; i < 5; i++) {
  mItems.push(req('GET', 'yedu-net://net/m/item?i=' + i, {}, null));
  snap('mItem' + i);
}
window.__result.mItems = mItems;
window.__result.mTotalMs = Date.now() - mT0;
window.__result.mFails = 0;
for (var j = 0; j < mItems.length; j++) { if (!mItems[j].ok) window.__result.mFails++; }
window.__result.done = true;
snap('mDone');
""";
                break;
            case "N":
                body = """
window.__result.nStart = Date.now();
window.__result.nIframes = [];
window.addEventListener('message', function (ev) {
  try {
    var d = ev.data;
    if (!d || d.__n === undefined) return;
    d.arrivedAt = Date.now() - window.__result.nStart;
    window.__result.nIframes.push(d);
    snap('nFrame' + d.__n);
    if (window.__result.nIframes.length === 3) {
      window.__result.nTotalMs = Date.now() - window.__result.nStart;
      window.__result.done = true;
      snap('nDone');
    }
  } catch (e) {}
});
for (var i = 0; i < 3; i++) {
  var f = document.createElement('iframe');
  f.src = 'https://app.local/f' + (i + 1) + '.html?i=' + i;
  document.body.appendChild(f);
}
snap('nIframesCreated');
""";
                break;
            case "O":
                body = """
window.__result.o302 = req('GET', 'yedu-net://net/o302', {}, null);
snap('o302');
window.__result.o404 = req('GET', 'yedu-net://net/o404', {}, null);
snap('o404');
window.__result.o500 = req('GET', 'yedu-net://net/o500', {}, null);
snap('o500');
var r = req('GET', 'yedu-net://net/o404', {}, null);
var threw = false, tmsg = '';
try { if (r.ok && r.status >= 400) { throw new Error('HTTP ' + r.status); } } catch (e) { threw = true; tmsg = String(e.message); }
window.__result.o404IreadStyle = { status: r.status, sendThrew: !r.ok, ireadWouldThrow: threw, ireadMessage: tmsg, body: r.body };
window.__result.done = true;
snap('oDone');
""";
                break;
            case "P":
                body = """
extProbe();
window.__result.done = true;
snap('pDone');
""";
                break;
            default:
                body = "snap('no-op');";
                break;
        }

        var head = """
<!doctype html>
<html><head><meta charset="utf-8"><title>spike-ext</title></head>
<body>
<div id="out">running</div>
<script>
window.__result = { mode: "__MODE__", href: String(location.href), origin: String(location.origin) };
""";
        var tail = """
</script>
</body></html>
""";
        var probe = (_cfg.Mode == "P") ? "extProbe();" : "";
        return (head.Replace("__MODE__", _cfg.Mode) + common + body + tail)
            .Replace("__BASE__", _cfg.ExtBase)
            .Replace("__EXTPROBE__", probe);
    }

    /// <summary>mode N 的 iframe：各自发一个同步 XHR，完成后 postMessage 给 parent。</summary>
    private static string IframeHarness()
    {
        return """
<!doctype html>
<html><head><meta charset="utf-8"><title>iframe</title></head>
<body>
<script>
var q = new URLSearchParams(location.search);
var idx = q.get('i') || '0';
var startedAt = Date.now();
var res;
try {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'yedu-net://net/n/iframe?i=' + idx, false);
  xhr.send(null);
  res = { ok: true, status: xhr.status, ms: Date.now() - startedAt,
          body: String(xhr.responseText || '').slice(0, 200) };
} catch (e) {
  res = { ok: false, error: String(e.name) + ': ' + String(e.message), ms: Date.now() - startedAt,
          status: (function () { try { return xhr.status; } catch (x) { return -1; } })() };
}
try {
  parent.postMessage({ __n: idx, xhr: res, startedAt: startedAt, finishedAt: Date.now(),
                       href: String(location.href), origin: String(location.origin) }, '*');
} catch (e) {}
</script>
</body></html>
""";
    }

    /// <summary>K/L 的同源探针页：页面本身来自 yedu-net://app，打 yedu-net://app/... = 同源，无 CORS/预检。</summary>
    private static string ExtSameOriginHarness()
    {
        return """
<!doctype html>
<html><head><meta charset="utf-8"><title>ext-same-origin</title></head>
<body>
<script>
function req(method, url, headers, body) {
  var t0 = Date.now();
  var xhr = new XMLHttpRequest();
  var hdrs = headers || {};
  var hdrSet = {};
  try {
    xhr.open(method, url, false);
    for (var k in hdrs) {
      try { xhr.setRequestHeader(k, hdrs[k]); hdrSet[k] = 'ok'; }
      catch (se) { hdrSet[k] = String(se.name) + ': ' + String(se.message); }
    }
    xhr.send(body === undefined ? null : body);
    return { ok: true, status: xhr.status, ms: Date.now() - t0,
             bodyLen: String(xhr.responseText || '').length,
             body: String(xhr.responseText || '').slice(0, 500),
             headers: String(xhr.getAllResponseHeaders() || '').slice(0, 400),
             setRequestHeaderResult: hdrSet };
  } catch (e) {
    return { ok: false, error: String(e.name) + ': ' + String(e.message), ms: Date.now() - t0,
             status: (function () { try { return xhr.status; } catch (x) { return -1; } })(),
             setRequestHeaderResult: hdrSet };
  }
}
var out = { origin: String(location.origin), href: String(location.href) };
out.echoSameOrigin = req('GET', 'yedu-net://app/echo?u=sync', {}, null);
out.httpsEcho = req('GET', 'https://app.local/echo', {}, null);
out.postJson = req('POST', 'yedu-net://app/k-post-json', {'Content-Type': 'application/json'}, '{"q":"中文"}');
out.headers = req('GET', 'yedu-net://app/l-headers', {'X-Test': 'v1', 'Cookie': 'a=b'}, null);
try { parent.postMessage({ __ext: true, out: out }, '*'); }
catch (e) { try { parent.postMessage({ __extErr: String(e) }, '*'); } catch (e2) {} }
</script>
</body></html>
""";
    }
}
