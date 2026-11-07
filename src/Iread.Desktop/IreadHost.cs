/* =========================================================================
 * IreadHost.cs — iread 换壳实验宿主（WebView2 / .NET 8 WinForms）
 *
 * 用法：Spike.exe <resultJsonPath> iread [fixturePort]
 *
 * 步骤1：iread:// 自定义 scheme 静态文件映射（wwwroot）
 * 步骤2：ConsoleMessageReceived 收集渲染层全部报错
 * 步骤3：AddScriptToExecuteOnDocumentCreated 注入 window.yedu shim
 *        （PostWebMessageAsJson/WebMessageReceived 桥），宿主侧实现：
 *        pickBooks/readFile/fetchText/fetchImage/runRuleJs/info/winControls…
 * 步骤4：核心链路 —— IndexedDB 持久化 / eval / 导入 txt / 在线搜索（fixture）
 *
 * 对外（供外部 CDP/脚本驱动）：
 *   #app:<base64(js)>   → location.hash 携带脚本，宿主在 NavigationCompleted 后执行
 *   window.__host.cmd({op:...})  → 宿主命令端口
 *   chrome.webview.postMessage(...)  → 快照落盘
 * ========================================================================= */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class IreadHost
{
    private static string _outFile;
    private static WebView2 _wv;
    private static Form _form;
    private static CoreWebView2 _core;
    private static readonly Stopwatch Sw = new Stopwatch();
    private static readonly List<string> HostLog = new List<string>();
    private static readonly List<Dictionary<string, object>> ConsoleMsgs = new List<Dictionary<string, object>>();
    private static readonly object Lock = new object();
    private static string _lastSnapshot;
    private static readonly List<string> Snapshots = new List<string>();
    private static bool _finalized;
    private static string _wwwRoot;
    private static string _fixtureBase = "";   // e.g. http://127.0.0.1:8123
    private static string _userDataDir = "";   // P：真实数据目录（info 上报给隐私政策/关于页）
    private static string _isolatedDataDir;
    private static int _debugPort;
    private static long _consoleSeq;
    // 请求观测（前 200 条）
    private static readonly List<Dictionary<string, object>> ReqLog = new List<Dictionary<string, object>>();
    private static System.Net.Http.HttpClient _http = new System.Net.Http.HttpClient();
    // 内置播放器（mpv 子进程，嵌入 Form 内的黑色面板）：首次用到时下载，播放时隐藏 WebView2
    private static Panel _mpvPanel;
    private static Process _mpvProc;
    private static string _mpvState = "idle";
    private static int _mpvBarH = 0;
    private static Panel _mpvTop;          // mpv 模式下的原生标题条（窗口按钮，当前不使用）
    private static Color _mpvPrevBg = Color.Empty;   // 进 mpv 前的窗体底色
    private static Panel _mpvBack;                   // （已废弃）子控件版返回键
    private static FormWindowState? _mpvPrevState;   // 全屏前的窗口状态
    private static Form _mpvBackForm;                 // 顶层小窗版返回键（真半透明）
    private static Label _mpvTopTitle;   // >0 表示「视频区 + 控制条」分栏（控制条用 WebView2 渲染）

    private static void Log(string line)
    {
        lock (Lock)
        {
            var s = "[" + Sw.ElapsedMilliseconds + "ms] " + line;
            HostLog.Add(s);
            Console.WriteLine(s);
            try { Console.Out.Flush(); } catch { }
        }
    }

    /// <summary>由 Program.Main 在 STA 主线程上调（mode=iread），arg0=result.json, arg2=fixtureBase</summary>
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, IntPtr value, int size);

    /* ---- P：无边框窗口缩放修复 —— FormBorderStyle=None 会剥掉 WS_THICKFRAME，
     * WebView2 NC region support 只处理 app-region:drag（HTCAPTION），边缘缩放
     * 仍需要窗口自身有 WS_THICKFRAME。Shown 时用 SetWindowLong 把它加回
     * （不加 WS_CAPTION），再用 WM_NCCALCSIZE=0 裁掉引出的非客户区边框线。 ---- */
    private const int GWL_STYLE = -16;
    private const uint WS_THICKFRAME = 0x00040000;
    private const uint WS_MINIMIZEBOX = 0x00020000;
    private const uint WS_MAXIMIZEBOX = 0x00010000;
    private const uint WS_CAPTION = 0x00C00000;
    private const int WM_NCCALCSIZE = 0x0083;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004;

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int x, int y, int cx, int cy, uint uFlags);

    /// <summary>挂到 _form.Handle 上拦 WM_NCCALCSIZE：wParam=1 时返回 0（整个窗口都是客户区，
    /// 无非客户区边框线），其余消息走默认流程。</summary>
    private sealed class NcCalcHook : NativeWindow
    {
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero) { m.Result = IntPtr.Zero; return; }
            base.WndProc(ref m);
        }
    }
    private static NcCalcHook _ncHook;

    /* ---- P：8 方向热区缩放（Bug1 最终修复，对齐 Electron main.js tickResize）----
     * 前两轮方案都是死路：Form 挂 WM_NCHITTEST hook 时，WebView2 子窗口覆盖整个
     * 客户区，Form 根本收不到鼠标命中消息（compact 记录里早验证过）。
     * 唯一可靠链路 = 渲染层自带的 #winResize 8 条 .rz 热区（z-index 9989，
     * app-region:no-drag，JS 能收到 mousedown）→ shim winResize(dir) →
     * 宿主 Timer 跟随鼠标改 Bounds（与 e 版 main.js 完全同款算法），
     * mouseup/blur → winResizeEnd 停表。顶栏拖动仍走 NC region support
     * 的 app-region:drag（已验证生效），两者互不干扰。 */
    private static System.Windows.Forms.Timer _rzTimer;
    private static string _rzDir;
    private static Rectangle _rzBase;
    private static System.Drawing.Point _rzStart;
    private const int MIN_W = 860, MIN_H = 560;

    private static void StartResize(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return;
        if (_form == null || _form.WindowState != FormWindowState.Normal) return;
        _rzDir = dir;
        _rzBase = _form.Bounds;
        _rzStart = Cursor.Position;
        if (_rzTimer == null)
        {
            _rzTimer = new System.Windows.Forms.Timer { Interval = 16 };
            _rzTimer.Tick += (s, e) => TickResize();
        }
        _rzTimer.Start();
        Log("resize: start dir=" + dir + " base=" + _rzBase);
    }

    private static void TickResize()
    {
        try
        {
            if (_rzDir == null || _form == null || _form.IsDisposed) { StopResize(); return; }
            var p = Cursor.Position;
            int dx = p.X - _rzStart.X, dy = p.Y - _rzStart.Y;
            var b = _rzBase;
            int x = b.X, y = b.Y, w = b.Width, h = b.Height;
            var d = _rzDir;
            if (d.IndexOf('e') >= 0) w = b.Width + dx;
            if (d.IndexOf('s') >= 0) h = b.Height + dy;
            if (d.IndexOf('w') >= 0) { w = b.Width - dx; x = b.X + dx; }
            if (d.IndexOf('n') >= 0) { h = b.Height - dy; y = b.Y + dy; }
            if (w < MIN_W) { if (d.IndexOf('w') >= 0) x = b.X + b.Width - MIN_W; w = MIN_W; }
            if (h < MIN_H) { if (d.IndexOf('n') >= 0) y = b.Y + b.Height - MIN_H; h = MIN_H; }
            _form.SetBounds(x, y, w, h);
        }
        catch { StopResize(); }
    }

    private static void StopResize()
    {
        _rzDir = null;
        if (_rzTimer != null) _rzTimer.Stop();
    }

    private static void ApplyBorderlessResize()
    {
        try
        {
            var hwnd = _form.Handle;
            int style = GetWindowLong(hwnd, GWL_STYLE);
            int old = style;
            style |= (int)(WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
            style &= ~(int)WS_CAPTION;   // 只加可缩放框，不加标题栏
            int hr = SetWindowLong(hwnd, GWL_STYLE, style);
            Log(string.Format("borderless-resize: style 0x{0:X8} -> 0x{1:X8} SetWindowLong hr={2} (readback=0x{3:X8})",
                old, style, hr, GetWindowLong(hwnd, GWL_STYLE)));
            // SWP_FRAMECHANGED 让非客户区按新样式重算（配合 WM_NCCALCSIZE=0 裁掉边框线）
            bool ok = SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
            Log("borderless-resize: SetWindowPos(FRAMECHANGED) ok=" + ok);
            if (_ncHook == null) _ncHook = new NcCalcHook();
            _ncHook.AssignHandle(hwnd);
            Log("borderless-resize: WM_NCCALCSIZE hook attached");
            // P：不再挂 Form 级 NCHITTEST hook——WebView2 子窗口覆盖客户区时 Form 收不到
            // 命中消息（死路）。缩放改走渲染层热区 + 宿主 Timer（StartResize/TickResize）。
        }
        catch (Exception exB) { Log("borderless-resize EX: " + exB.Message); }
    }

    /* ---- P：托盘模式（winTray）---- */
    private static NotifyIcon _trayIcon;
    private static bool _trayMode;
    private static bool _isQuitting;
    private static System.Threading.Mutex _singleInstanceMutex;
    /// <summary>后台线程等待的「唤出窗口」信号；首次启动时创建。</summary>
    private static System.Threading.EventWaitHandle _wakeEvent;

    private static void SetTrayMode(bool on)
    {
        try
        {
            if (on)
            {
                if (_trayIcon == null)
                {
                    var menu = new ContextMenuStrip();
                    menu.Items.Add("显示", null, (s, e) => RestoreFromTray());
                    menu.Items.Add("退出", null, (s, e) =>
                    {
                        _isQuitting = true; _allowClose = true; _trayMode = false;
                        DisposeTrayIcon();
                        try { _form.Close(); } catch { }
                    });
                    _trayIcon = new NotifyIcon
                    {
                        Text = "iread 插件测试版",
                        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath),
                        ContextMenuStrip = menu,
                        Visible = false
                    };
                    // 单击/双击恢复窗口（对齐常见托盘交互）
                    _trayIcon.Click += (s, e) => RestoreFromTray();
                    _trayIcon.DoubleClick += (s, e) => RestoreFromTray();
                    Log("tray: NotifyIcon created");
                }
                _trayIcon.Visible = true;
                _trayMode = true;
            }
            else
            {
                _trayMode = false;
                DisposeTrayIcon();
            }
            Log("tray: setTrayMode(" + on + ") -> _trayMode=" + _trayMode);
        }
        catch (Exception exT) { Log("tray EX: " + exT.Message); }
    }

    private static void DisposeTrayIcon()
    {
        if (_trayIcon != null)
        {
            try { _trayIcon.Visible = false; _trayIcon.Dispose(); } catch { }
            _trayIcon = null;
            Log("tray: NotifyIcon disposed");
        }
    }

    private static void RestoreFromTray()
    {
        try
        {
            _form.Show();
            if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
            _form.Activate();
        }
        catch (Exception exR) { Log("tray restore EX: " + exR.Message); }
    }

    private static void HideToTray()
    {
        try
        {
            _form.Hide();
            Log("tray: window hidden to tray");
        }
        catch (Exception exH) { Log("tray hide EX: " + exH.Message); }
    }

    /* ---- 关闭确认（2026-10-29 用户需求）：点标题栏关闭 / Alt+F4 时先问「最小化至托盘 还是 退出」，
     * 勾「记住我的选择」写盘，下次直接按记住的走。---- */
    private static bool _allowClose;
    private static string _closeChoice;
    private static bool _closeChoiceLoaded;

    private static string ClosePrefFile()
    {
        try
        {
            var root = Path.GetDirectoryName(Path.GetFullPath(_userDataDir ?? ""));
            return string.IsNullOrEmpty(root) ? null : Path.Combine(root, "close-pref.txt");
        }
        catch { return null; }
    }

    private static string CloseChoice()
    {
        if (_closeChoiceLoaded) return _closeChoice;
        _closeChoiceLoaded = true;
        try
        {
            var file = ClosePrefFile();
            if (file != null && File.Exists(file))
            {
                var text = File.ReadAllText(file).Trim().ToLowerInvariant();
                if (text == "tray" || text == "quit") _closeChoice = text;
            }
        }
        catch (Exception exC) { Log("close: load pref EX: " + exC.Message); }
        return _closeChoice;
    }

    private static void SaveCloseChoice(string choice)
    {
        _closeChoice = choice;
        _closeChoiceLoaded = true;
        try
        {
            var file = ClosePrefFile();
            if (file != null) File.WriteAllText(file, choice + Environment.NewLine);
            Log("close: remembered " + choice);
        }
        catch (Exception exC) { Log("close: save pref EX: " + exC.Message); }
    }

    private static void ForceClose()
    {
        _allowClose = true;
        _isQuitting = true;
        try { DisposeTrayIcon(); } catch { }
        try { if (_form != null) _form.Close(); } catch { }
    }

    private static void ApplyCloseChoice(string choice)
    {
        if (choice == "quit") { ForceClose(); return; }
        if (_form == null) return;
        if (_form.InvokeRequired) _form.Invoke(new Action(() => { SetTrayMode(true); HideToTray(); }));
        else { SetTrayMode(true); HideToTray(); }
    }

    /// <summary>统一关闭入口：有记住的选择就照做，否则让渲染层弹「最小化至托盘 / 退出」。</summary>
    private static void RequestClose()
    {
        if (_allowClose || _isQuitting) { ForceClose(); return; }
        var remembered = CloseChoice();
        if (remembered == "quit") { ForceClose(); return; }
        if (remembered == "tray") { ApplyCloseChoice("tray"); return; }
        var core = _core;
        if (core == null) { ForceClose(); return; }
        try { core.ExecuteScriptAsync("window.__ireadAskClose && window.__ireadAskClose();"); }
        catch (Exception exQ) { Log("close: ask EX: " + exQ.Message); ForceClose(); }
    }

    internal static void Run(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        // ---- 单实例（2026-10-28 用户需求：只能开一个客户端；二次启动唤出已有窗口）----
        // Mutex 判重：已有实例 → 置唤醒事件、把它的窗口带到前台，然后本进程直接退出。
        // EventWaitHandle 兜轮询：第一实例后台线程 WaitOne，收到信号在 UI 线程 RestoreFromTray。
        // 命名带 "Local\" 前缀限定本会话；不含版本号，升级覆盖安装后仍互斥同一实例。
        foreach (var argument in args)
        {
            if (argument.StartsWith("--data-dir=", StringComparison.Ordinal))
                _isolatedDataDir = Path.GetFullPath(argument.Substring("--data-dir=".Length));
            if (argument.StartsWith("--devtools-port=", StringComparison.Ordinal) &&
                int.TryParse(argument.Substring("--devtools-port=".Length), out var port) && port >= 1024 && port <= 65535)
                _debugPort = port;
        }
        if (_debugPort != 0 && _isolatedDataDir == null)
            throw new ArgumentException("调试端口仅允许用于显式隔离的数据目录");
        var instanceKey = _isolatedDataDir == null ? "" : "-" + Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(_isolatedDataDir.ToUpperInvariant())));
        var wakeName = @"Local\iread-plugin-wake" + instanceKey;
        bool createdNew;
        _singleInstanceMutex = new System.Threading.Mutex(true, @"Local\iread-plugin-singleton" + instanceKey, out createdNew);
        if (!createdNew)
        {
            try
            {
                var wake = System.Threading.EventWaitHandle.OpenExisting(wakeName);
                wake.Set();
            }
            catch { /* 唤醒失败就让第二个实例直接退出，不弹双开 */ }
            Log("single-instance: already running, wake signal sent, exit");
            return;
        }
        // 持有互斥体直到进程退出（不要 GC 回收）
        GC.KeepAlive(_singleInstanceMutex);
        _outFile = args.Length > 0 && !args[0].StartsWith("--", StringComparison.Ordinal) ? args[0] : null;
        if (args.Length > 2 && !args[2].StartsWith("--", StringComparison.Ordinal)) _fixtureBase = args[2].TrimEnd('/');
        _wwwRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "wwwroot"));
        if (!Directory.Exists(_wwwRoot)) _wwwRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "wwwroot"));
        if (!Directory.Exists(_wwwRoot))
        {
            Console.WriteLine("FATAL: wwwroot not found");
            return;
        }
        Log("iread mode wwwRoot=" + _wwwRoot + " fixture=" + (_fixtureBase == "" ? "(none)" : _fixtureBase));

        Application.EnableVisualStyles();
        _form = new Form
        {
            Width = 1100,
            Height = 800,
            // P：无边框窗口（WinForms 原生方案，对齐 e 版的无边框形态）——
            // 用 FormBorderStyle=None 去掉系统标题栏；保留任务栏入口和 Alt+F4。
            // 渲染层自带窗口按钮（最小化/最大化/关闭），经 winControls shim 转发到宿主
            FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = true,
            // 窗体底色＝顶栏色，避免孩子控件没铺满时在顶部/边缘漏出系统灰白条
            BackColor = Color.FromArgb(0x0e, 0x10, 0x13),
            StartPosition = FormStartPosition.CenterScreen,
            Text = "iread 插件测试版",
            // P：圆角恢复——DWM 圆角窗口 + 底色透明化：让 Win11 的系统圆角透出桌面。
            // 窗体/WebView2 底色改 Transparent；渲染层 .desktop 方案（#app 圆角 14px、
            // 最大化时归零）自动接管视觉。DwmSetWindowAttribute 圆角策略在 Shown 里挂。
            // P：WinForms 不接受 Color.Transparent（ArgumentException）——圆角透明靠 DWM 裁剪+渲染层自绘，窗体底色用顶栏黑即可
        };
        _wv = new WebView2
        {
            Dock = DockStyle.Fill,
            // 透明背景：渲染层 .desktop 的 body{background:transparent} 才能生效，
            // 圆角外的四角由 DWM 裁掉（露出桌面）
            DefaultBackgroundColor = Color.FromArgb(0x0e, 0x10, 0x13)   // 顶栏色，圆角内自绘
        };
        _form.Controls.Add(_wv);
        // P：圆角正解（Win10 通吃）——Form.Region 按圆角矩形裁窗口形状，
        // 四角像素真正不属于窗口（透出桌面）。渲染层 .desktop 的 14px 圆角与裁剪半径对齐。
        // 最大化时恢复直角（.desktop.window-maxed 的 CSS 同步归零）。
        EventHandler applyRegion = (s, e) =>
        {
            try
            {
                if (_form.WindowState == FormWindowState.Maximized) { _form.Region = null; return; }
                int w = _form.Width, h = _form.Height, r = 14 * 2;   // DPI 未缩放时 14px；粗略按逻辑像素 2 倍兜底
                using (var gp = new System.Drawing.Drawing2D.GraphicsPath())
                {
                    gp.AddArc(0, 0, r, r, 180, 90);
                    gp.AddArc(w - r, 0, r, r, 270, 90);
                    gp.AddArc(w - r, h - r, r, r, 0, 90);
                    gp.AddArc(0, h - r, r, r, 90, 90);
                    gp.CloseFigure();
                    _form.Region = new Region(gp);
                }
            }
            catch (Exception exR) { Log("region EX: " + exR.Message); }
        };
        _form.Shown += async (s, e) =>
        {
            applyRegion(null, EventArgs.Empty);
            _form.Resize += applyRegion;
            // P：Bug1 修复——FormBorderStyle=None 剥掉了 WS_THICKFRAME，无边框缩放需在
            // 句柄就绪后把样式加回（+WM_NCCALCSIZE=0 裁掉边框线）
            ApplyBorderlessResize();
            await RunAsync();
        };
        // 关闭先问一句：记住过选择就直接照做，否则取消这次关闭、让渲染层弹对话框
        _form.FormClosing += (s, e) =>
        {
            if (_allowClose || _isQuitting) return;
            if (CloseChoice() == "quit") return;
            e.Cancel = true;
            RequestClose();
        };
        // P：应用真正退出时释放托盘图标（防托盘残尸）
        _form.FormClosed += (s, e) => { DisposeTrayIcon(); RuleProcess.Shutdown(); try { MpvStop(); } catch { } };
        _form.Move += (s, e) => { try { MpvPlaceBack(); } catch { } };
        _form.Resize += (s, e) => { try { if (_mpvTop != null && _mpvTop.Visible) { MpvLayoutTop(true); ApplyMpvLayout(_mpvBarH); } else if (_mpvBarH > 0 && _mpvPanel != null && _mpvPanel.Visible) ApplyMpvLayout(_mpvBarH); MpvPlaceBack(); } catch { } };
        // ---- 单实例唤醒监听（2026-10-28）：后台线程等信号，收到后切回 UI 线程唤出窗口 ----
        // EventWaitHandle(false, ManualReset) + 每次处理完 Reset，支持多次触发；
        // 托盘隐藏态 RestoreFromTray 会 Show()，最小化态会还原 + SetForegroundWindow 语义（Activate）。
        try
        {
            _wakeEvent = new System.Threading.EventWaitHandle(false,
                System.Threading.EventResetMode.ManualReset, wakeName);
            var wake = _wakeEvent;
            System.Threading.ThreadPool.RegisterWaitForSingleObject(wake,
                (state, timedOut) =>
                {
                    if (timedOut) return;
                    wake.Reset();
                    try
                    {
                        _form.BeginInvoke(new Action(() =>
                        {
                            RestoreFromTray();
                            // 托盘态 Hide 过的窗口 Show 后可能不抢焦点；再顶一次前台
                            try { _form.Activate(); } catch { }
                        }));
                    }
                    catch (Exception exW) { Log("wake dispatch EX: " + exW.Message); }
                }, null, System.Threading.Timeout.Infinite, false);
        }
        catch (Exception exW0) { Log("wake listener EX: " + exW0.Message); }
        Application.Run(_form);
    }



    private static async Task RunAsync()
    {
        Sw.Start();
        try
        {
            var userData = AppDataLocation.PrepareProfile(AppContext.BaseDirectory,
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), _isolatedDataDir);
            _userDataDir = userData;
            var reg = new CoreWebView2CustomSchemeRegistration("iread")
            {
                TreatAsSecure = true,
                HasAuthorityComponent = true
            };
            reg.AllowedOrigins.Add("iread://app");
            var regs = new List<CoreWebView2CustomSchemeRegistration> { reg };
            // yedu-net：书源渲染层 legacy-js.js 的同步 XHR 代理（java.ajax 走它）
            var reg2 = new CoreWebView2CustomSchemeRegistration("yedu-net")
            {
                TreatAsSecure = true,
                HasAuthorityComponent = true
            };
            reg2.AllowedOrigins.Add("yedu-net://net");
            reg2.AllowedOrigins.Add("iread://app");
            regs.Add(reg2);

            var browserArguments = _debugPort == 0 ? null : "--remote-debugging-port=" + _debugPort + " --remote-debugging-address=127.0.0.1";
            var opts = new CoreWebView2EnvironmentOptions(browserArguments, null, null, false, regs);
            var env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
            await _wv.EnsureCoreWebView2Async(env);
            Log("env ok, runtime=" + env.BrowserVersionString);
            _core = _wv.CoreWebView2;

            // —— 插件目录映射为 https://plugins.local（CSP 里显式放行该源；eval 仍禁用） ——
            try
            {
                var pdir = PluginsDir();
                Directory.CreateDirectory(pdir);
                _core.SetVirtualHostNameToFolderMapping("plugins.local", pdir, CoreWebView2HostResourceAccessKind.DenyCors);
                Log("plugins host mapped -> " + pdir);
            }
            catch (Exception pex) { Log("plugins host map failed: " + pex.Message); }

            var settings = _core.Settings;
            settings.AreDevToolsEnabled = true;
            settings.IsWebMessageEnabled = true;
            settings.AreDefaultScriptDialogsEnabled = true;
            settings.IsZoomControlEnabled = false;
            // P：Bug1 最终修复——NC region support 必须开着：顶栏 app-region:drag 拖动
            // 靠它（已实测生效）。缩放不走 Form NCHITTEST（WebView2 子窗口覆盖客户区，
            // Form 收不到命中消息=死路），走渲染层 .rz 热区 → winResize → 宿主 Timer。
            try { settings.IsNonClientRegionSupportEnabled = true; Log("NC region support: on (caption drag)"); }
            catch (Exception ex2) { Log("NC region support: 不可用（运行时版本过旧）" + ex2.Message); }
            // HostObjectAllowAdditionalSettings 不需要；AreBrowserAcceleratorKeysEnabled 默认即可
            Log("settings: devtools=" + settings.AreDevToolsEnabled
                + " statusBar=" + settings.IsStatusBarEnabled);

            // —— 拦截 iread://（静态文件）与 yedu-net://（fetchText 代理） ——
            _core.AddWebResourceRequestedFilter("iread://*", CoreWebView2WebResourceContext.All);
            _core.AddWebResourceRequestedFilter("yedu-net://*", CoreWebView2WebResourceContext.All);
            _core.WebResourceRequested += OnWebResourceRequested;

            // —— 步骤2/3：注入必须在导航前**注册完成**（不然首文档拿不到 yedu shim，
            //    渲染层走浏览器降级 → boot 初始化异常）。之前 Wait(10000) 卡 10s 的真因
            //    是两个 Wait 串行各卡满超时——改为单个 await（正常 <100ms）+ 失败兜底：
            //    若注册真超时，导航后由 NavigationCompleted 的重注入逻辑补
            var injectTask = _core.AddScriptToExecuteOnDocumentCreatedAsync(ErrorCollectorScript());
            var injectTask2 = _core.AddScriptToExecuteOnDocumentCreatedAsync(ShimScript());
            try { await Task.WhenAll(injectTask, injectTask2); }
            catch (Exception iex) { Log("shim register err: " + iex.Message); }
            Log("shim registered");

            _core.WebMessageReceived += OnWebMessageReceived;

            // 每页加载完成：把之前排队的命令 flush
            _core.NavigationCompleted += async (s, a) =>
            {
                Log("nav completed: success=" + a.IsSuccess + " url=" + SafeUri());
                if (a.IsSuccess)
                {
                    // 界面就绪后预热一个书源 worker：首次搜索/发现不必再等 WebView2 冷启动
                    try { RuleProcess.Prime(2); } catch (Exception pex) { Log("warm prime err: " + pex.Message); }
                    // 通知页面：host ready（yedu.info 等可以开始用了）
                    try { await _core.ExecuteScriptAsync(
                        "try{document.dispatchEvent(new CustomEvent('yedu-host-ready'));}catch(e){}" +
                        "try{window.__hostReady=true;}catch(e){}"); } catch { }
                    // P：用户模式——不再自动注入 driver.js 实验脚本；
                    // driver.js 只在外部显式传 fixturePort 参数（自测模式）时注入
                    var drv = Path.Combine(_wwwRoot, "driver.js");
                    if (File.Exists(drv) && !string.IsNullOrEmpty(_fixtureBase))
                    {
                        await Task.Delay(5000);
                        try
                        {
                            var js = File.ReadAllText(drv);
                            await _core.ExecuteScriptAsync(js);
                            Log("driver.js injected (" + js.Length + " chars)");
                        }
                        catch (Exception dex) { Log("driver inject err: " + dex.Message); }
                    }
                }
            };

            // 看门狗：仅自测模式（有 fixturePort）启用——用户模式常开不退出
            if (!string.IsNullOrEmpty(_fixtureBase))
            _ = Task.Run(async () =>
            {
                await Task.Delay(150000);
                try
                {
                    if (_form != null && _form.IsHandleCreated)
                        _form.BeginInvoke(new Action(async () =>
                        {
                            Log("WATCHDOG 150s");
                            await FinalizeAsync("watchdog");
                            try { _form.Close(); } catch { }
                        }));
                }
                catch { }
            });

            Log("navigate -> iread://app/index.html");
            _core.Navigate("iread://app/index.html");
        }
        catch (Exception ex)
        {
            Log("FATAL: " + ex);
            WriteResult("fatal: " + ex.Message);
            MessageBox.Show(_form, ex.Message + "\n未切换到空白数据目录，原数据仍保留。", "iread 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            try { _form.Close(); } catch { }
        }
    }

    private static string SafeUri()
    {
        try { return _core.Source; } catch { return "?"; }
    }

    /* ================================================================
     * WebResourceRequested：iread:// 静态文件 + yedu-net 代理
     * ================================================================ */
    /* 视频/媒体请求头注入：<video> 与 hls.js 的 XHR 都改不了 Referer/UA（浏览器禁设头），
       只能在这一层用 WebResourceRequested 补上。key = 主机名（小写，不含端口）。 */
    private static readonly Dictionary<string, Dictionary<string, string>> MediaHeaderMap =
        new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
    private static readonly object MediaHeaderLock = new object();
    private static bool _mediaFilterAdded = false;

    private static object SetMediaHeaders(JsonElement arg)
    {
        var count = 0;
        lock (MediaHeaderLock)
        {
            MediaHeaderMap.Clear();
            if (arg.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in arg.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    if (!item.TryGetProperty("host", out var h) || h.ValueKind != JsonValueKind.String) continue;
                    var host = (h.GetString() ?? "").Trim().ToLowerInvariant();
                    if (host.Length == 0) continue;
                    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    if (item.TryGetProperty("headers", out var hd) && hd.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var p in hd.EnumerateObject())
                        {
                            if (p.Value.ValueKind != JsonValueKind.String) continue;
                            map[p.Name] = p.Value.GetString() ?? "";
                        }
                    }
                    if (map.Count == 0) continue;
                    MediaHeaderMap[host] = map;
                    count++;
                }
            }
        }
        if (count > 0 && !_mediaFilterAdded)
        {
            try
            {
                _core.AddWebResourceRequestedFilter("https://*", CoreWebView2WebResourceContext.All);
                _core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All);
                _mediaFilterAdded = true;
            }
            catch (Exception ex) { Log("media filter err: " + ex.Message); }
        }
        Log("mediaHeaders: " + count + " host(s), filter=" + _mediaFilterAdded);
        return new Dictionary<string, object> { { "ok", true }, { "count", count } };
    }

    private static void ApplyMediaHeaders(string uri, CoreWebView2WebResourceRequestedEventArgs args)
    {
        string host;
        try { host = new Uri(uri).Host.ToLowerInvariant(); } catch { return; }
        Dictionary<string, string> map = null;
        lock (MediaHeaderLock)
        {
            if (MediaHeaderMap.Count > 0) MediaHeaderMap.TryGetValue(host, out map);
        }
        if (map == null) return;
        foreach (var kv in map)
        {
            try { args.Request.Headers.SetHeader(kv.Key, kv.Value); }
            catch (Exception) { }
        }
    }

    private static void OnWebResourceRequested(object s, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var uri = "";
        try { uri = args.Request.Uri ?? ""; } catch { }
        var method = "";
        try { method = args.Request.Method ?? ""; } catch { }
        var t0 = Sw.ElapsedMilliseconds;

        try
        {
            if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                ApplyMediaHeaders(uri, args);
                return;               // 不设 Response = 放行走网络
            }
            if (uri.StartsWith("iread://", StringComparison.OrdinalIgnoreCase))
            {
                ServeStatic(args, uri, method);
                RecordReq(uri, method, 0, Sw.ElapsedMilliseconds - t0);
                return;
            }
            if (uri.StartsWith("yedu-net://", StringComparison.OrdinalIgnoreCase))
            {
                // 书源同步 XHR 代理：yedu-net://net/?u=<enc>&m=&body=&cs=&h=
                ServeNetProxy(args, uri);
                RecordReq(uri, method, 0, Sw.ElapsedMilliseconds - t0);
                return;
            }
        }
        catch (Exception ex)
        {
            Log("WRR err " + uri + " : " + ex.Message);
            try { Respond(args, 500, "text/plain; charset=utf-8", "host error: " + ex.Message); } catch { }
        }
    }

    private static void RecordReq(string uri, string method, int status, long ms)
    {
        lock (Lock)
        {
            if (ReqLog.Count < 400)
                ReqLog.Add(new Dictionary<string, object> {
                    { "uri", uri }, { "method", method }, { "status", status }, { "ms", ms } });
        }
    }

    private static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".htm", "text/html; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" },
        { ".js", "application/javascript; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" },
        { ".png", "image/png" },
        { ".jpg", "image/jpeg" },
        { ".jpeg", "image/jpeg" },
        { ".gif", "image/gif" },
        { ".svg", "image/svg+xml" },
        { ".ico", "image/x-icon" },
        { ".woff", "font/woff" },
        { ".woff2", "font/woff2" },
        { ".ttf", "font/ttf" },
        { ".map", "application/json" }
    };

    private static void ServeStatic(CoreWebView2WebResourceRequestedEventArgs args, string uri, string method)
    {
        // iread://app/<path> → wwwroot\<path>
        var rest = uri.Substring("iread://app".Length);
        int q = rest.IndexOf('?');
        if (q >= 0) rest = rest.Substring(0, q);
        if (rest.StartsWith("/")) rest = rest.Substring(1);
        if (rest.Length == 0) rest = "index.html";
        var path = Path.GetFullPath(Path.Combine(_wwwRoot, rest.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(_wwwRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
        {
            Log("static 404 -> " + uri + " (" + path + ")");
            Respond(args, 404, "text/plain; charset=utf-8", "not found: " + rest);
            return;
        }
        var ext = Path.GetExtension(path);
        Mime.TryGetValue(ext, out var mime);
        if (mime == null) mime = "application/octet-stream";
        var bytes = File.ReadAllBytes(path);
        // 静态文件同步回，最简单也最快
        args.Response = _core.Environment.CreateWebResourceResponse(
            new MemoryStream(bytes), 200, "OK", "Content-Type: " + mime);
        if (reqCounter < 8) Log("static 200 -> " + rest + " (" + bytes.Length + "B " + mime + ")");
        System.Threading.Interlocked.Increment(ref reqCounter);
    }
    private static int reqCounter;

    private static void Respond(CoreWebView2WebResourceRequestedEventArgs args,
        int status, string contentType, string body, string extraHeaders = null)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        args.Response = _core.Environment.CreateWebResourceResponse(
            new MemoryStream(bytes), status, status == 200 ? "OK" : (status == 404 ? "Not Found" : "Error"),
            "Content-Type: " + contentType + "\r\nAccess-Control-Allow-Origin: *"
            + (extraHeaders == null ? "" : "\r\n" + extraHeaders));
    }

    /// <summary>把宿主 fetchText 的结果 JSON 编码成字符串。</summary>
    private static string JStr(string s) => s == null ? "null" : JsonSerializer.Serialize(s);

    private static void ServeNetProxy(CoreWebView2WebResourceRequestedEventArgs args, string uri)
    {
        // 解析参数（ iread 的 legacy-js.js proxyUrl：u/m/body/cs/h ）
        var u = GetQ(uri, "u");
        var m = GetQ(uri, "m");
        var body = GetQ(uri, "body");
        var cs = GetQ(uri, "cs");
        var hs = GetQ(uri, "h");

        if (string.IsNullOrWhiteSpace(u) || !u.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            Log("netproxy 400 -> " + uri);
            Respond(args, 400, "text/plain; charset=utf-8", "ERR 只支持 http/https");
            return;
        }

        // 后台线程请求 + BeginInvoke 回 UI 线程设置 Response（WebView2 COM 编组规则）
        var deferral = args.GetDeferral();
        var coreRef = _core;
        Task.Run(async () =>
        {
            string text = null; int status = 502; string charset = "utf-8"; string err = null; string finalUrl = u;
            try
            {
                using (var req = new System.Net.Http.HttpRequestMessage(
                    new System.Net.Http.HttpMethod(string.IsNullOrWhiteSpace(m) ? "GET" : m.ToUpperInvariant()), u))
                {
                    req.Headers.TryAddWithoutValidation("User-Agent",
                        "Mozilla/5.0 (Linux; U; Android 8.1.0; zh-CN; MI 8 Lite Build/OPM1.171019.019) " +
                        "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.2.0.1100 Mobile Safari/537.36");
                    req.Headers.TryAddWithoutValidation("Accept",
                        "text/html,application/xhtml+xml,application/json,text/plain,*/*");
                    req.Headers.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
                    if (!string.IsNullOrEmpty(hs))
                    {
                        try
                        {
                            var dict = JsonSerializer.Deserialize<Dictionary<string, string>>(hs);
                            if (dict != null)
                                foreach (var kv in dict)
                                    if (!string.IsNullOrEmpty(kv.Key) && !string.IsNullOrEmpty(kv.Value))
                                        req.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                        }
                        catch { }
                    }
                    if (!string.IsNullOrEmpty(body))
                    {
                        var content = new System.Net.Http.StringContent(body, Encoding.UTF8,
                            "application/x-www-form-urlencoded");
                        req.Content = content;
                    }
                    var resp = await _http.SendAsync(req);
                    finalUrl = resp.RequestMessage.RequestUri != null ? resp.RequestMessage.RequestUri.ToString() : u;
                    var raw = await resp.Content.ReadAsByteArrayAsync();
                    status = (int)resp.StatusCode;
                    // charset：优先显式 cs，其次 content-type，其次 BOM / meta 嗅探（对齐 net.js）
                    var ct = string.Join(" ", resp.Content.Headers.GetValues("Content-Type"));
                    var decoded = DecodeBody(raw, ct, cs);
                    text = decoded.text; charset = decoded.charset;
                }
            }
            catch (Exception ex) { err = ex.Message; }
            try
            {
                _form.BeginInvoke(new Action(() =>
                {
                    try
                    {
                        if (err != null)
                        {
                            Log("netproxy 502 -> " + u + " err=" + err);
                            Respond(args, 502, "text/plain; charset=utf-8", "ERR " + err + "：" + u);
                        }
                        else
                        {
                            if (reqCounter < 40) Log("netproxy " + status + " -> " + u + " (" + (text ?? "").Length + " chars, cs=" + charset + ")");
                            // 语义对齐 iread main.js：主进程把 HTTP 错误码也包成 200，
                            // "ERR" 前缀交给渲染层判（netproxy 把 status>=400 的失败显示出来）
                            var respBody = status >= 400
                                ? "ERR HTTP " + status + "：" + StrExt.Slice2(text ?? "", 120)
                                : text;
                            Respond(args, 200, "text/plain; charset=utf-8",
                                respBody ?? "", "X-Yedu-Url: " + Uri.EscapeDataString(finalUrl));
                        }
                    }
                    catch (Exception ex) { Log("netproxy respond err " + ex.Message); }
                    finally
                    {
                        try { deferral.Complete(); } catch (Exception ex) { Log("netproxy deferral err " + ex.Message); }
                    }
                }));
            }
            catch (Exception ex) { Log("netproxy BeginInvoke err " + ex.Message); }
        });
    }

    private static (string text, string charset) DecodeBody(byte[] buf, string contentType, string asked)
    {
        string cs = null;
        if (!string.IsNullOrEmpty(asked)) cs = asked.Trim();
        else
        {
            var m = System.Text.RegularExpressions.Regex.Match(contentType ?? "", @"charset\s*=\s*[""']?([\w-]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (m.Success) cs = m.Groups[1].Value;
            else if (buf.Length >= 3 && buf[0] == 0xef && buf[1] == 0xbb && buf[2] == 0xbf) cs = "utf-8";
            else
            {
                var head = Encoding.Latin1.GetString(buf, 0, Math.Min(buf.Length, 4096));
                var m2 = System.Text.RegularExpressions.Regex.Match(head, @"<meta[^>]+charset\s*=\s*[""']?\s*([\w-]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (m2.Success) cs = m2.Groups[1].Value;
                else cs = "utf-8";
            }
        }
        cs = cs.ToLowerInvariant();
        var alias = new Dictionary<string, string> {
            { "gb2312", "gbk" }, { "gbk", "gbk" }, { "gb18030", "gb18030" },
            { "utf8", "utf-8" }, { "utf", "utf-8" }, { "big5", "big5" },
            { "big5hkscs", "big5" }, { "iso88591", "windows-1252" },
            { "iso-8859-1", "windows-1252" }, { "latin1", "windows-1252" }
        };
        if (alias.ContainsKey(cs)) cs = alias[cs];
        try { return (Encoding.GetEncoding(cs).GetString(buf), cs); }
        catch { return (Encoding.UTF8.GetString(buf), "utf-8"); }
    }

    private static string GetQ(string uri, string key)
    {
        int q = uri.IndexOf('?');
        if (q < 0) return null;
        var query = uri.Substring(q + 1);
        foreach (var pair in query.Split('&'))
        {
            var eq = pair.IndexOf('=');
            if (eq < 0) { if (pair == key) return ""; continue; }
            if (pair.Substring(0, eq) == key)
                return Uri.UnescapeDataString(pair.Substring(eq + 1).Replace("+", "%20"));
        }
        return null;
    }

    /* ================================================================
     * 步骤2：console / 未捕获异常收集脚本（注入到每个文档创建时，先于页面脚本）
     * ================================================================ */
    private static string ErrorCollectorScript()
    {
        return """
(function () {
  'use strict';
  var seq = 0;
  function send(level, msg, src) {
    seq++;
    if (seq > 500) return;
    try { chrome.webview.postMessage({ __type: 'console', level: level, message: String(msg).slice(0, 2000), source: String(src || '') }); } catch (e) { }
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
    var orig = console[m];
    if (!orig) return;
    console[m] = function () {
      var args = Array.prototype.slice.call(arguments);
      var text = args.map(function (a) {
        try { return (typeof a === 'string') ? a : JSON.stringify(a); }
        catch (e) { return String(a); }
      }).join(' ');
      send(m, text, '');
      try { orig.apply(console, args); } catch (e) { }
    };
  });
  window.addEventListener('error', function (ev) {
    send('pageerror', (ev.message || 'error') + ' @ ' + (ev.filename || '') + ':' + (ev.lineno || 0),
         (ev.error && ev.error.stack) ? String(ev.error.stack).slice(0, 800) : '');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    var msg = (r && r.stack) ? String(r.stack).slice(0, 800) : String(r);
    send('unhandledrejection', msg, '');
  });
})();
""";
    }

    /* ================================================================
     * window.yedu shim（AddScriptToExecuteOnDocumentCreated）
     * ================================================================ */
    private static string ShimScript()
    {
        return """
/* yedu shim：把 preload 的 contextBridge API 换成 PostWebMessage 桥 */
(function () {
  'use strict';
  var seq = 0, pending = Object.create(null);
  var handlers = Object.create(null);

  function call(method, args) {
    return new Promise(function (res, rej) {
      var id = ++seq;
      pending[id] = { res: res, rej: rej, method: method };
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; rej(new Error('host timeout: ' + method)); }
      }, method === 'fetchText' || method === 'fetchImage' ? (args[0].timeout || 15000) + 1000 :
        method === 'runSourceTask' || method === 'saveRecoveryBackup' ? 120000 :
        method === 'mpvEnsure' ? 600000 : 30000);
      try {
        chrome.webview.postMessage({ __yedu: 1, id: id, method: method, args: args });
      } catch (e) { delete pending[id]; rej(e); }
    });
  }

  function networkCall(method, opts) {
    opts = opts || {};
    if (Object.prototype.hasOwnProperty.call(opts, 'timeout') &&
        (typeof opts.timeout !== 'number' || !Number.isInteger(opts.timeout) || opts.timeout < 1 || opts.timeout > 120000)) {
      var invalid = new Error('timeout must be 1..120000ms'); invalid.code = 'RULE_REQUEST';
      return Promise.reject(invalid);
    }
    function invoke(task) {
      var plain = {};
      ['url', 'method', 'body', 'charset', 'requestCharset', 'referer', 'headers', 'lenientDecode'].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(opts, key)) plain[key] = opts[key];
      });
      plain.taskId = task.taskId; plain.timeout = task.timeout;
      return call(method, [JSON.parse(JSON.stringify(plain))]);
    }
    // platform.js loads after document-created scripts: resolve the task runner at CALL TIME.
    if (window.NR && window.NR.tasks && typeof window.NR.tasks.run === 'function')
      return window.NR.tasks.run(invoke, opts);
    // Only legacy, cancellation-free early boot calls may bypass the not-yet-loaded runner.
    if (opts.signal != null || opts.deadline != null) {
      var missing = new Error('Task runner not ready'); missing.code = 'UNSUPPORTED';
      return Promise.reject(missing);
    }
    return invoke({ taskId: opts.taskId, timeout: opts.timeout === undefined ? 15000 : opts.timeout });
  }

  var shim = {
    isDesktop: true,
    __shim: true,
    pickBooks: function () {
      return call('pickBooks', []).then(function (list) {
        (list || []).forEach(function (it) {
          if (it && it.dataB64) {
            var bin = atob(it.dataB64), u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            it.data = u8;   // 平台层 toFile 期待 Uint8Array
          }
        });
        return list;
      });
    },
    readFile: function (p) {
      return call('readFile', [p]).then(function (it) {
        if (it && it.dataB64) {
          var bin = atob(it.dataB64), u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          it.data = u8;
        }
        return it;
      });
    },
    pathForFile: function (f) { return null; },   // 无 Node：拖拽路径拿不到
    saveJSON: function (name, text) { return call('saveJSON', [name, text]); },
    saveRecoveryBackup: function (text) { return call('saveRecoveryBackup', [text]); },
    runSourceTask: function (request) { return call('runSourceTask', [request]); },
    cancelTask: function (taskId) { return call('cancelTask', [taskId]); },
    appendLog: function (name, text) { return call('appendLog', [String(name == null ? '' : name), String(text == null ? '' : text)]); },
    logsDir: function () { return call('logsDir', []); },
    openLogsDir: function () { return call('openLogsDir', []); },
    openUserData: function () { return call('openUserData', []); },
    // 内置播放器（mpv）：ensure = 首次用时下载，play = 隐藏 WebView2 并把 mpv 画进面板
    mpvEnsure: function () { return call('mpvEnsure', []); },
    mpvPlay: function (opts) { return call('mpvPlay', [opts || {}]); },
    mpvStop: function () { return call('mpvStop', []); },
    mpvState: function () { return call('mpvState', []); },
    mpvCmd: function (json) { return call('mpvCmd', [String(json || '')]); },
    // 控制条分栏：height>0 = WebView2 缩成底部条带；0 = 铺满窗口；<0 = 全隐藏
    mpvLayout: function (opts) { return call('mpvLayout', [opts || { height: 0 }]); },
    mpvBack: function (show) { return call('mpvBack', [!!show]); },
    mpvFull: function (on) { return call('mpvFull', [on === undefined ? null : !!on]); },
    info: function () { return call('info', []); },
    setTrayMode: function (on) { return call('winTray', [!!on]); },
    setLoginItem: function (on) { return Promise.resolve(false); },
    getLoginItem: function () { return Promise.resolve(false); },
    pickSources: function () { return call('pickSources', []); },
    cacheDir: function () { return call('cacheDir', []); },
    plugins: function () { return call('plugins', []); },
    importPlugin: function (path) { return call('importPlugin', [String(path == null ? '' : path)]); },
    pluginFs: function (opts) { return call('pluginFs', [opts || {}]); },
    decodeImage: function (opts) { return call('decodeImage', [opts || {}]); },
    sniffVideo: function (opts) { return call('sniffVideo', [opts || {}]); },
        mediaHeaders: function (list) { return call('mediaHeaders', [list || []]); },
    setCacheDir: function (dir) { return call('setCacheDir', [String(dir == null ? '' : dir)]); },
    pickFolder: function (title) { return call('pickFolder', [String(title == null ? '' : title)]); },
    openFolder: function (dir) { return call('openFolder', [String(dir == null ? '' : dir)]); },
    clearCache: function () { return call('clearCache', []); },
    fetchText: function (opts) { return networkCall('fetchText', opts); },
    fetchImage: function (opts) { return networkCall('fetchImage', opts); },
    runRuleJs: function (code, ctx) { return call('runRuleJs', [code, ctx]); },
    winControls: {
      minimize: function () { return call('winMinimize', []); },
      toggleMaximize: function () { return call('winToggleMax', []); },
      close: function () { return call('winClose', []); },
      exit: function () { return call('winExit', []); },
      confirmClose: function (kind, remember) { return call('closeChoice', [String(kind || ''), remember ? '1' : '0']); },
      isMaximized: function () { return call('winIsMax', []); },
      startResize: function (dir) { return call('winResize', [dir]); },
      endResize: function () { return call('winResizeEnd', []); },
      onState: function (cb) {
        try { window.addEventListener('message', function (ev) {
          if (ev.data && ev.data.__winState) cb(ev.data.__winState);
        }); } catch (e) { }
      }
    },
    onYueduLink: function (cb) {
      try { window.addEventListener('message', function (ev) {
        if (ev.data && ev.data.__yeduLink) cb(ev.data.__yeduLink);
      }); } catch (e) { }
    },
    onMenuImport: function (cb) {
      try { document.addEventListener('yedu-menu-import', function () { cb(); }); } catch (e) { }
    }
  };
  try { Object.freeze(shim.winControls); } catch (e) { }
  window.yedu = shim;

  chrome.webview.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__type !== 'yeduReply') return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.ok) p.res(d.value); else {
      var e = new Error(d.error || 'host error');
      ['code', 'http', 'url', 'timeout', 'cancelled', 'charset', 'contentType', 'taskId', 'maxBytes'].forEach(function (key) {
        if (d.errorInfo && Object.prototype.hasOwnProperty.call(d.errorInfo, key)) e[key] = d.errorInfo[key];
      });
      p.rej(e);
    }
  });

  /* 平台观测口：外部驱动用 */
  window.__host = {
    cmd: function (o) { return call('__cmd', [o]); },
    snapshot: function (o) {
      try { chrome.webview.postMessage({ __type: 'snapshot', data: o }); } catch (e) { }
    }
  };

  /* P：无边框窗口拖动热区——给所有 [data-win-drag] 元素挂 hover 上报，
   * 宿主据此把该区域的鼠标拖动当标题栏拖动（WM_NCHITTEST → HTCAPTION） */
  try {
    var reportDrag = function (on) {
      try { chrome.webview.postMessage({ __winDrag: on ? 1 : 0 }); } catch (e) { }
    };
    var bindDrag = function (el) {
      if (el.__dragBound) return; el.__dragBound = 1;
      el.addEventListener('mouseenter', function () { reportDrag(true); });
      el.addEventListener('mouseleave', function () { reportDrag(false); });
    };
    document.addEventListener('DOMContentLoaded', function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-win-drag]'), bindDrag);
    });
    // DOM 后到的（抽屉/顶栏动态渲染）也要覆盖
    try {
      new MutationObserver(function (muts) {
        Array.prototype.forEach.call(document.querySelectorAll('[data-win-drag]'), bindDrag);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e2) { }
  } catch (e3) { }
})();
""";
    }

    /* ================================================================
     * WebMessageReceived：yedu RPC + 快照落盘
     * ================================================================ */
    private static async void OnWebMessageReceived(object s, CoreWebView2WebMessageReceivedEventArgs a)
    {
        string raw = null;
        try { raw = a.WebMessageAsJson; } catch { try { raw = a.TryGetWebMessageAsString(); } catch { } }
        if (raw == null) return;
        JsonDocument doc = null;
        try { doc = JsonDocument.Parse(raw); } catch { return; }        using (doc)
        {
            var root = doc.RootElement;
            // 旧协议：字符串快照（兼容）
            if (root.ValueKind == JsonValueKind.String)
            {
                lock (Lock) { _lastSnapshot = root.GetString(); Snapshots.Add(_lastSnapshot); WriteSnapshot(); }
                Log("snapshot <- renderer (" + _lastSnapshot.Length + " chars)");
                return;
            }
            // yedu RPC：优先识别（别落到快照分支）
            if (root.TryGetProperty("__yedu", out var y) && y.GetInt32() == 1)
            {
                long id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt64() : 0;
                string method = root.TryGetProperty("method", out var mEl) ? mEl.GetString() : "";
                JsonElement argsEl = default;
                root.TryGetProperty("args", out argsEl);
                _ = HandleYeduCall(id, method, argsEl.Clone());
                return;
            }
            // P：无边框窗口拖动热区上报（渲染层 data-win-drag 元素 hover 时发）
            // ——NC 模式下拖拽由 WebView2 原生处理（app-region CSS），此消息废弃
            if (root.TryGetProperty("__winDrag", out var wd))
            {
                return;
            }
            if (!root.TryGetProperty("__type", out var tEl)) return;   // 其它消息不当快照
            var type = tEl.GetString();
            if (type == "console")
            {
                long seq;
                lock (Lock) seq = ++_consoleSeq;
                var rec = new Dictionary<string, object> {
                    { "seq", seq },
                    { "level", root.TryGetProperty("level", out var lv) ? lv.GetString() : "" },
                    { "message", root.TryGetProperty("message", out var ms) ? ms.GetString() : "" },
                    { "source", root.TryGetProperty("source", out var sr) ? sr.GetString() : "" }
                };
                lock (Lock) ConsoleMsgs.Add(rec);
                var msg1 = (rec["message"] as string ?? "").Split('\n')[0];
                if (msg1.Length > 160) msg1 = msg1.Substring(0, 160) + "…";
                Log("console[" + rec["level"] + "] " + msg1);
                return;
            }
            if (type == "snapshot")
            {
                lock (Lock)
                {
                    _lastSnapshot = root.TryGetProperty("data", out var d) ? d.GetRawText() : raw;
                    Snapshots.Add(_lastSnapshot);
                    WriteSnapshot();
                }
                Log("snapshot <- renderer");
                return;
            }
            if (type == "yeduReply") return;   // shim 自己发的

            // 兜底：未知对象消息直接当快照存
            lock (Lock) { _lastSnapshot = raw; Snapshots.Add(raw); WriteSnapshot(); }
        }
    }

    private static void WriteSnapshot()
    {
        try { File.WriteAllText(_outFile, JsonSerializer.Serialize(Snapshots, new JsonSerializerOptions { WriteIndented = false }), new UTF8Encoding(false)); } catch { }
    }

    /* P：Win32 文件对话框（替代实验 mock）——readText=true 返回 [{name,text}]（书源），
     * false 返回 [{name,path,size,dataB64}]（书，按 ReadBookFile 语义） */
    private static List<object> PickFilesDialog(string filter, bool multi, bool readText)
    {
        var list = new List<object>();
        using (var dlg = new OpenFileDialog())
        {
            dlg.Filter = filter;
            dlg.Multiselect = multi;
            dlg.Title = readText ? "选择书源文件" : "选择书籍文件";
            if (dlg.ShowDialog() != DialogResult.OK) return list;   // 取消 → 空数组（渲染层按未选择处理）
            foreach (var p in dlg.FileNames)
            {
                try
                {
                    if (readText)
                        list.Add(new Dictionary<string, object> {
                            { "name", Path.GetFileName(p) }, { "text", File.ReadAllText(p) } });
                    else
                        list.Add(ReadBookFile(p));
                }
                catch (Exception rex) { Log("pick file err: " + p + " " + rex.Message); }
            }
        }
        return list;
    }

    private static async Task HandleYeduCall(long id, string method, JsonElement args)
    {
        object value = null; string error = null;
        var errorInfo = new Dictionary<string, object>();
        try
        {
            switch (method)
            {
                case "info":
                    {
                        // P：版本号读程序集（csproj <Version>），不再硬编码 spike 版号；
                        // 若程序集带 InformationalVersion（插件测试版用它标 1.0.0-plugin.N），优先显示它；
                        // userData 返回真实数据目录，供隐私政策/关于页展示准确路径
                        string ver = "1.0.0";
                        try { ver = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? ver; } catch { }
                        try
                        {
                            foreach (object attr in System.Reflection.Assembly.GetExecutingAssembly()
                                .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false))
                            {
                                var infoVer = attr as System.Reflection.AssemblyInformationalVersionAttribute;
                                if (infoVer != null && !string.IsNullOrWhiteSpace(infoVer.InformationalVersion))
                                    ver = infoVer.InformationalVersion.Trim();
                            }
                        }
                        catch { }
                        value = new Dictionary<string, object> {
                            { "name", "iread" }, { "version", ver },
                            { "electron", "none (WebView2 shell)" },
                            { "chrome", _core.Environment.BrowserVersionString },
                            { "userData", _userDataDir }
                        };
                    }
                    break;
                case "pickBooks":
                    {
                        // P：真文件对话框（多选 txt/epub）——替换 mock
                        value = PickFilesDialog("书籍文件 (txt;epub;cbz)|*.txt;*.epub;*.cbz|全部文件 (*.*)|*.*", multi: true,
                            readText: false);
                        break;
                    }
                case "readFile":
                    {
                        var p = args.EnumerateArray().First().GetString();
                        value = ReadBookFile(p);
                        break;
                    }
                case "pickSources":
                    {
                        // P：真文件对话框（多选 .json/.txt）——替换实验 mock（固定返回 fixture，
                        // _mockSourcePath 为空时返回 []，表现即「按钮失效」）
                        value = PickFilesDialog("书源文件 (json;txt)|*.json;*.txt|全部文件 (*.*)|*.*", multi: true,
                            readText: true);
                        break;
                    }
                case "importPlugin":
                    {
                        value = ImportPluginZip(args.GetArrayLength() > 0 ? new[] { args[0].GetString() ?? "" } : Array.Empty<string>());
                        break;
                    }
                case "pluginFs":
                    {
                        value = PluginFs(args.EnumerateArray().First());
                        break;
                    }
                case "decodeImage":
                    {
                        value = await DecodeImage(args.EnumerateArray().First());
                        break;
                    }
                case "mediaHeaders":
                    {
                        value = SetMediaHeaders(args.GetArrayLength() > 0 ? args[0] : default(JsonElement));
                        break;
                    }
                case "sniffVideo":
                    {
                        value = await SniffVideo(args.EnumerateArray().First());
                        break;
                    }
                case "plugins":
                    {
                        value = PluginsList();
                        break;
                    }
                case "cacheDir":
                    {
                        value = CoverCacheInfo();
                        break;
                    }
                case "setCacheDir":
                    {
                        var dir = args.GetArrayLength() > 0 ? (args[0].GetString() ?? "") : "";
                        dir = dir.Trim();
                        if (dir.Length == 0)
                        {
                            try { File.Delete(CoverCachePrefFile()); } catch (Exception) { }
                            _coverCacheOverride = null;
                            _coverCacheLoaded = true;
                        }
                        else
                        {
                            var full = Path.GetFullPath(dir);
                            Directory.CreateDirectory(full);
                            var probe = Path.Combine(full, ".iread-write-test");
                            File.WriteAllText(probe, "1");
                            File.Delete(probe);
                            File.WriteAllText(CoverCachePrefFile(), full, new UTF8Encoding(false));
                            _coverCacheOverride = full;
                            _coverCacheLoaded = true;
                        }
                        value = CoverCacheInfo();
                        break;
                    }
                case "clearCache":
                    {
                        var dir = CoverCacheDir();
                        int removed = 0;
                        try
                        {
                            if (Directory.Exists(dir))
                            {
                                foreach (var file in new DirectoryInfo(dir).GetFiles())
                                {
                                    try { file.Delete(); removed++; } catch (Exception) { }
                                }
                            }
                        }
                        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
                        Log("cover-cache cleared: " + removed + " files");
                        var info = CoverCacheInfo();
                        info["removed"] = removed;
                        value = info;
                        break;
                    }
                case "pickFolder":                    {
                        var title = args.GetArrayLength() > 0 ? (args[0].GetString() ?? "") : "";
                        using (var dlg = new FolderBrowserDialog())
                        {
                            dlg.Description = string.IsNullOrEmpty(title) ? "选择文件夹" : title;
                            dlg.UseDescriptionForTitle = true;
                            var current = CoverCacheDir();
                            if (Directory.Exists(current)) dlg.SelectedPath = current;
                            value = dlg.ShowDialog() == DialogResult.OK ? (object)dlg.SelectedPath : "";
                        }
                        break;
                    }
                case "openFolder":
                    {
                        var dir = args.GetArrayLength() > 0 ? (args[0].GetString() ?? "") : "";
                        if (!string.IsNullOrEmpty(dir))
                        {
                            Directory.CreateDirectory(dir);
                            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
                        }
                        value = true;
                        break;
                    }
                case "saveJSON":
                    {                        // P：真另存为对话框（对齐 Electron 的 dialog:save-json 语义）——
                        // 之前静默写 %TEMP%\ireadspike-exports\，用户以为「导出失效」。
                        var arr = args.EnumerateArray().ToList();
                        var name = arr.Count > 0 ? arr[0].GetString() : "export.json";
                        var text = arr.Count > 1 ? arr[1].GetString() : "";
                        using (var dlg = new SaveFileDialog())
                        {
                            dlg.Filter = "JSON 文件 (*.json)|*.json|全部文件 (*.*)|*.*";
                            dlg.FileName = name;
                            dlg.Title = "导出";
                            if (dlg.ShowDialog() != DialogResult.OK)
                            {
                                value = new Dictionary<string, object> { { "canceled", true } };
                            }
                            else
                            {
                                File.WriteAllText(dlg.FileName, text ?? "", new UTF8Encoding(false));
                                value = new Dictionary<string, object> { { "canceled", false }, { "path", dlg.FileName } };
                            }
                        }
                        break;
                    }
                case "saveRecoveryBackup":
                    {
                        var text = args.EnumerateArray().Single().GetString();
                        var path = await Task.Run(() => AppDataLocation.SaveRecoveryBackup(_userDataDir, text));
                        value = new Dictionary<string, object> { { "ok", true }, { "path", path } };
                        break;
                    }
                case "runSourceTask":
                    value = await RuleProcess.ExecuteAsync(args.EnumerateArray().Single());
                    break;
                case "cancelTask":
                    {
                        var taskId = args.EnumerateArray().Single();
                        if (taskId.ValueKind != JsonValueKind.String)
                            throw RuleProcess.Error("RULE_REQUEST", "taskId must be a string");
                        value = HostTaskScope.Cancel(taskId.GetString());
                        break;
                    }
                case "openUserData":
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + Path.GetDirectoryName(_userDataDir) + "\"") { UseShellExecute = true });
                    value = true;
                    break;
                /* ---- 筛选报错日志：静默追加写 <安装目录>\logs\screen\<name>（不弹对话框）---- */
                case "appendLog":
                    {
                        var arr = args.ValueKind == JsonValueKind.Array ? args.EnumerateArray().ToList() : new List<JsonElement>();
                        var name = arr.Count > 0 && arr[0].ValueKind == JsonValueKind.String ? arr[0].GetString() : "";
                        var text = arr.Count > 1 && arr[1].ValueKind == JsonValueKind.String ? arr[1].GetString() : "";
                        value = AppendScreenLog(name, text);
                        break;
                    }
                case "logsDir":
                    value = ScreenLogsDir();
                    break;
                case "openLogsDir":
                    {
                        try
                        {
                            var dir = ScreenLogsDir();
                            Directory.CreateDirectory(dir);
                            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
                            value = new Dictionary<string, object> { { "ok", true }, { "path", dir } };
                        }
                        catch (Exception oex)
                        {
                            value = new Dictionary<string, object> { { "ok", false }, { "error", oex.Message } };
                        }
                        break;
                    }
                /* ---- P：无边框窗口控制（渲染层 winControls shim 的宿主侧）---- */
                case "winMinimize":
                    _form.Invoke(new Action(() => _form.WindowState = FormWindowState.Minimized));
                    value = true;
                    break;
                case "winToggleMax":
                    _form.Invoke(new Action(() =>
                    {
                        _form.WindowState = _form.WindowState == FormWindowState.Maximized
                            ? FormWindowState.Normal : FormWindowState.Maximized;
                    }));
                    value = true;
                    break;
                case "winClose":
                    // P：Bug2 修复——托盘模式开启时关闭=隐藏到托盘，不走真 Close。
                    // 窗口已隐藏（托盘态）时再收到 close 视为真退出（防二次隐藏死循环）
                    _form.Invoke(new Action(() =>
                    {
                        // 托盘态（窗口已隐藏）再点关闭 = 真退出；否则走「最小化至托盘 / 退出」询问
                        if (!_form.Visible) { ForceClose(); return; }
                        RequestClose();
                    }));
                    value = true;
                    break;
                case "winExit":
                    // P：Bug4 修复——「不同意」语义必须真退出：托盘模式开启时 winClose
                    // 会 Hide 而不是退出（用户看起来「点了不同意没退出」）。winExit
                    // 强制真关闭，绕过托盘拦截。Electron 侧无 exit，渲染层走兼容降级。
                    _isQuitting = true;
                    _allowClose = true;
                    _trayMode = false;
                    _form.Invoke(new Action(() =>
                    {
                        DisposeTrayIcon();
                        try { _form.Close(); } catch { }
                    }));
                    value = true;
                    break;
                case "closeChoice":
                    {
                        string kind = "", remembered = "";
                        try { kind = args.EnumerateArray().First().GetString() ?? ""; } catch { }
                        try { remembered = args.EnumerateArray().Skip(1).First().GetString() ?? ""; } catch { }
                        bool remember = remembered == "1" || remembered == "true";
                        Log("close: choice=" + kind + " remember=" + remember);
                        if (remember) SaveCloseChoice(kind == "quit" ? "quit" : "tray");
                        ApplyCloseChoice(kind == "quit" ? "quit" : "tray");
                        value = true;
                        break;
                    }
                case "winTray":
                    {
                        bool on = false;
                        try { on = args.EnumerateArray().First().GetBoolean(); } catch { }
                        _form.Invoke(new Action(() => SetTrayMode(on)));
                        value = true;
                        break;
                    }
                case "winIsMax":
                    value = _form.WindowState == FormWindowState.Maximized;
                    break;
                case "winResize":
                    {
                        // P：Bug1 最终修复——渲染层 8 条 .rz 热区 mousedown 上报方向，
                        // 宿主 Timer 跟随鼠标改 Bounds（对齐 e 版 main.js tickResize）
                        string dir = "";
                        try { dir = args.EnumerateArray().First().GetString(); } catch { }
                        _form.Invoke(new Action(() => StartResize(dir)));
                        value = true;
                        break;
                    }
                case "winResizeEnd":
                    _form.Invoke(new Action(() => StopResize()));
                    value = true;
                    break;
                case "fetchText":
                    {
                        var opts = args.EnumerateArray().First();
                        value = await HostFetchText(opts);
                        break;
                    }
                case "fetchImage":
                    {
                        // P：对齐 Electron preload 语义——fetchImage 返回 data URL **字符串**，
                        // 不是 {dataUrl} 对象（covers.js 拿返回值直接当字符串用）
                        var optsI = args.EnumerateArray().First();
                        var imgDict = await HostFetchImage(optsI);
                        value = imgDict["dataUrl"];
                        break;
                    }
                /* ---- 内置播放器（mpv）：渲染层 NR.mpv 的宿主侧 ---- */
                case "mpvEnsure":
                    value = await MpvEnsure();
                    break;
                case "mpvPlay":
                    {
                        var mpvOpts = args.EnumerateArray().First();
                        value = MpvPlay(mpvOpts);
                        break;
                    }
                case "mpvStop":
                    value = MpvStop();
                    break;
                case "mpvCmd":
                    {
                        string cmdJson = "";
                        try { cmdJson = args.EnumerateArray().First().GetString() ?? ""; } catch { }
                        value = await MpvCmd(cmdJson);
                        break;
                    }
                case "mpvFull":
                    {
                        bool? want = null;
                        if (args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > 0)
                        {
                            var a0 = args[0];
                            if (a0.ValueKind == JsonValueKind.True) want = true;
                            else if (a0.ValueKind == JsonValueKind.False) want = false;
                        }
                        value = MpvSetFull(want);
                        break;
                    }
                case "mpvBack":
                    {
                        var showArg = args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > 0
                            ? args[0].ValueKind == JsonValueKind.True
                            : false;
                        MpvShowBack(showArg);
                        value = new { ok = true, show = showArg };
                        break;
                    }
                case "mpvLayout":
                    {
                        int bh = 0;
                        try
                        {
                            var layOpts = args.EnumerateArray().First();
                            if (layOpts.TryGetProperty("height", out var hh)) bh = (int)Math.Round(hh.GetDouble());
                        }
                        catch { }
                        value = MpvLayoutCmd(bh);
                        break;
                    }
                case "mpvState":
                    value = new Dictionary<string, object>
                    {
                        { "state", _mpvState },
                        { "installed", File.Exists(MpvExe()) },
                        { "dir", MpvDir() }
                    };
                    break;
                case "runRuleJs":
                    {
                        error = "不支持任意脚本执行，请使用独立书源任务";
                        break;
                    }
                case "__cmd":
                    {
                        var cmd = args.EnumerateArray().First();
                        value = await HandleCmd(cmd);
                        break;
                    }
                default:
                    error = "no such yedu method: " + method;
                    break;
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
            foreach (System.Collections.DictionaryEntry entry in ex.Data)
                if (entry.Key is string key) errorInfo[key] = entry.Value;
            Log("yedu." + method + " ERR " + ex.Message);
        }
        // 回复
        try
        {
            var reply = new Dictionary<string, object> {
                { "__type", "yeduReply" }, { "id", id }, { "ok", error == null } };
            if (error != null) { reply["error"] = error; reply["errorInfo"] = errorInfo; }
            else reply["value"] = value;
            _core.PostWebMessageAsJson(JsonSerializer.Serialize(reply));
        }
        catch (Exception ex) { Log("reply err " + ex.Message); }
    }

    /* ================================================================
     * 内置播放器（mpv）
     *   背景：WebView2 没有 HEVC/H.265 解码器（实测 canPlayType hvc1 为空、
     *   <video> 只有声音 videoWidth=0），mpv 走 FFmpeg + d3d11va 硬解能放。
     *   做法：首次用到时从 GitHub releases 下 mpv（约 45MB zip）解到 <数据根>\mpv；
     *   播放时在 Form 里铺一个黑色 Panel，用 --wid=<Panel.Handle> 让 mpv 画进去，
     *   同时隐藏 WebView2（两者都是子 HWND，叠放会互相盖住）。
     *   mpv 退出后恢复 WebView2，并回调渲染层 NR.mpv._ended()。
     * ================================================================ */
    private const string MpvZipUrl = "https://gh-proxy.com/https://github.com/Silencecavalier/iread-mpv/releases/download/mpv-v0.42.0/mpv-x86_64.zip";
    private const string MpvZipUrlDirect = "https://github.com/Silencecavalier/iread-mpv/releases/download/mpv-v0.42.0/mpv-x86_64.zip";

    private static string MpvDir()
    {
        var root = string.IsNullOrEmpty(_userDataDir) ? null : Path.GetDirectoryName(Path.GetFullPath(_userDataDir));
        if (string.IsNullOrEmpty(root)) root = AppContext.BaseDirectory;
        return Path.Combine(root, "mpv");
    }

    private static string MpvExe() { return Path.Combine(MpvDir(), "mpv.exe"); }

    private static string MpvPipe { get { return @"\\.\pipe\iread-mpv"; } }

    private static async Task<Dictionary<string, object>> MpvEnsure()
    {
        var exe = MpvExe();
        if (File.Exists(exe))
            return new Dictionary<string, object> { { "ok", true }, { "path", exe }, { "cached", true } };
        Exception last = null;
        try
        {
            Directory.CreateDirectory(MpvDir());
            var zip = Path.Combine(Path.GetTempPath(), "iread-mpv-" + Guid.NewGuid().ToString("N") + ".zip");
            using (var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromMinutes(10) })
            {
                foreach (var url in new[] { MpvZipUrl, MpvZipUrlDirect })
                {
                    try
                    {
                        Log("mpv: downloading " + url);
                        using (var resp = await http.GetAsync(url, System.Net.Http.HttpCompletionOption.ResponseHeadersRead))
                        {
                            resp.EnsureSuccessStatusCode();
                            using (var fs = File.Create(zip)) await resp.Content.CopyToAsync(fs);
                        }
                        System.IO.Compression.ZipFile.ExtractToDirectory(zip, MpvDir(), true);
                        var pack = Path.Combine(MpvDir(), "pack");
                        if (Directory.Exists(pack))
                        {
                            foreach (var f in Directory.GetFiles(pack))
                                File.Copy(f, Path.Combine(MpvDir(), Path.GetFileName(f)), true);
                            Directory.Delete(pack, true);
                        }
                        try { File.Delete(zip); } catch { }
                        break;
                    }
                    catch (Exception ex) { last = ex; Log("mpv: download failed " + ex.Message); }
                }
            }
        }
        catch (Exception ex) { last = ex; }
        if (!File.Exists(exe))
            return new Dictionary<string, object> { { "ok", false }, { "error", last == null ? "播放器下载失败" : last.Message } };
        Log("mpv: ready " + exe);
        return new Dictionary<string, object> { { "ok", true }, { "path", exe }, { "cached", false } };
    }

    /* mpv 模式下窗口是无边框的，渲染层的自绘标题栏又随 WebView2 一起缩小了，
       所以这里放一条原生的标题条（标题 + 最小化/最大化/关闭），避免「没有窗口按钮」。
       布局：[原生标题条][mpv 视频区][WebView2 控制条]。 */
    private static int MpvTopHeight() { return (int)Math.Round(40 * (_form.DeviceDpi / 96.0)); }

    private static void MpvBuildTop(string title)
    {
        if (_mpvTop == null)
        {
            int h = MpvTopHeight();
            _mpvTop = new Panel { Dock = DockStyle.None, BackColor = Color.FromArgb(11, 13, 17), Visible = false };
            _mpvTopTitle = new Label
            {
                AutoSize = false,
                Dock = DockStyle.None,
                ForeColor = Color.FromArgb(230, 234, 240),
                BackColor = Color.Transparent,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font("Microsoft YaHei UI", 9f),
                AutoEllipsis = true
            };
            _mpvTop.Controls.Add(_mpvTopTitle);

            /* 三个按钮画成和网页里一模一样的红黄绿圆点，不用系统中式标题栏按钮。 */
            Color[] dots = { Color.FromArgb(255, 95, 87), Color.FromArgb(254, 188, 46), Color.FromArgb(40, 200, 64) };
            for (int k = 0; k < 3; k++)
            {
                int idx = k;
                var hit = new Panel { BackColor = Color.Transparent, Cursor = Cursors.Hand };
                bool hot = false;
                hit.Paint += (s3, e3) =>
                {
                    var g = e3.Graphics;
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    int d = (int)Math.Round(12 * (_form.DeviceDpi / 96.0));
                    int cx = (hit.Width - d) / 2;
                    int cy = (hit.Height - d) / 2;
                    using (var br = new SolidBrush(dots[idx]))
                        g.FillEllipse(br, cx, cy, d, d);
                    if (!hot) return;
                    using (var pen = new Pen(Color.FromArgb(158, 60, 30, 10), 1.3f))
                    {
                        if (idx == 0)
                        {
                            g.DrawLine(pen, cx + d / 4f, cy + d / 2f, cx + d * 3 / 4f, cy + d / 2f);
                            g.DrawLine(pen, cx + d / 2f, cy + d / 4f, cx + d / 2f, cy + d * 3 / 4f);
                        }
                        else if (idx == 1)
                        {
                            g.DrawLine(pen, cx + d / 4f, cy + d / 2f, cx + d * 3 / 4f, cy + d / 2f);
                        }
                        else
                        {
                            int q = d / 4;
                            g.DrawLine(pen, cx + q, cy + q, cx + d - q, cy + d - q);
                            g.DrawLine(pen, cx + d - q, cy + q, cx + q, cy + d - q);
                        }
                    }
                };
                hit.MouseEnter += (s3, e3) => { hot = true; hit.Invalidate(); };
                hit.MouseLeave += (s3, e3) => { hot = false; hit.Invalidate(); };
                hit.Click += (s3, e3) =>
                {
                    try
                    {
                        if (idx == 0) _form.WindowState = FormWindowState.Minimized;
                        else if (idx == 1) _form.WindowState = _form.WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                        else ForceClose();
                    }
                    catch { }
                };
                _mpvTop.Controls.Add(hit);
            }
            _form.Controls.Add(_mpvTop);
            _mpvTop.BringToFront();
            Log("mpv: top built");
        }
        if (_mpvTopTitle != null) _mpvTopTitle.Text = string.IsNullOrEmpty(title) ? "iread" : title;
    }

    /* mpv 画面由 mpv 自己画，网页点不到。左上角放一个极小的无边框顶层窗口当返回键，
       用 Form.Opacity 做真半透明（子控件设 WS_EX_LAYERED 在 Win11 上不混合，实测仍是实色）。 */
    private static void MpvBuildBack()
    {
        if (_mpvBackForm != null) return;
        int d = (int)Math.Round(44 * (_form.DeviceDpi / 96.0));
        var f = new Form
        {
            FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false,
            StartPosition = FormStartPosition.Manual,
            BackColor = Color.Black,
            Opacity = 0.6,
            Size = new Size(d, d),
            Text = "back",
            MinimizeBox = false,
            MaximizeBox = false
        };
        var lb = new Label
        {
            Dock = DockStyle.Fill,
            Text = "\u2039",
            ForeColor = Color.White,
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 17f, FontStyle.Regular),
            AutoSize = false,
            Cursor = Cursors.Hand
        };
        f.AutoSize = false;
        f.Controls.Add(lb);
        f.ClientSize = new Size(d, d);
        f.MinimumSize = new Size(d, d);
        f.MaximumSize = new Size(d, d);
        EventHandler go = (s2, e2) =>
        {
            try
            {
                var core = _core;
                if (core != null) core.ExecuteScriptAsync("window.NR&&NR.video&&NR.video.close&&NR.video.close();");
                // 页面那边万一没接住（脚本没加载/异常），800ms 后宿主兜底收摊
                var t = new System.Windows.Forms.Timer { Interval = 800 };
                t.Tick += (s3, e3) =>
                {
                    t.Stop(); t.Dispose();
                    if (_mpvState == "playing")
                    {
                        Log("mpv: back fallback stop");
                        try { MpvStop(); } catch { }
                    }
                };
                t.Start();
            }
            catch (Exception ex) { Log("mpv: back EX " + ex.Message); }
        };
        lb.Click += go;
        f.Click += go;
        try
        {
            using (var gp = new System.Drawing.Drawing2D.GraphicsPath())
            {
                int r = (int)Math.Round(11 * (_form.DeviceDpi / 96.0));
                gp.AddArc(0, 0, r * 2, r * 2, 180, 90);
                gp.AddArc(d - r * 2, 0, r * 2, r * 2, 270, 90);
                gp.AddArc(d - r * 2, d - r * 2, r * 2, r * 2, 0, 90);
                gp.AddArc(0, d - r * 2, r * 2, r * 2, 90, 90);
                gp.CloseFigure();
                f.Region = new Region(gp);
            }
        }
        catch { }
        _mpvBackForm = f;
        Log("mpv: back built");
    }

    private static void MpvPlaceBack()
    {
        try
        {
            if (_mpvBackForm == null || !_mpvBackForm.Visible) return;
            int pad = (int)Math.Round(14 * (_form.DeviceDpi / 96.0));
            _mpvBackForm.Location = new Point(_form.Left + pad, _form.Top + pad);
            _mpvBackForm.BringToFront();
        }
        catch (Exception ex) { Log("mpv: placeback EX " + ex.Message); }
    }

    // mpv 模式下 WebView2 只剩底部一条，网页那套「铺满窗口」的全屏对它没意义，
    // 全屏就是让宿主窗口无边框最大化 / 还原。
    private static object MpvSetFull(bool? want)
    {
        try
        {
            _form.BeginInvoke((Action)(() =>
            {
                bool on = want ?? !(_form.WindowState == FormWindowState.Maximized);
                if (on)
                {
                    if (_mpvPrevState == null) _mpvPrevState = _form.WindowState;
                    _form.WindowState = FormWindowState.Maximized;
                }
                else
                {
                    _form.WindowState = _mpvPrevState ?? FormWindowState.Normal;
                    _mpvPrevState = null;
                }
                _form.Activate();
                try { _wv.Focus(); } catch { }
            }));
            return new { ok = true };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private static void MpvShowBack(bool show)
    {
        try
        {
            if (show) MpvBuildBack();
            if (_mpvBackForm == null) return;
            if (show)
            {
                if (!_mpvBackForm.Visible) _mpvBackForm.Show(_form);
                MpvPlaceBack();
            }
            else if (_mpvBackForm.Visible) _mpvBackForm.Hide();
        }
        catch (Exception ex) { Log("mpv: showback EX " + ex.Message); }
    }

    private static void MpvLayoutTop(bool show)
    {
        if (_mpvTop == null) return;
        try
        {
            int h = MpvTopHeight();
            var cs = _form.ClientRectangle;
            _mpvTop.Bounds = new Rectangle(0, 0, cs.Width, h);
            _mpvTop.Visible = show;
            if (!show) return;
            /* 右侧三个按钮从右往左排；标题占剩下的宽度 */
            int bw = (int)Math.Round(44 * (_form.DeviceDpi / 96.0));
            int x = cs.Width - bw;
            for (int k = _mpvTop.Controls.Count - 1; k >= 1; k--)
            {
                var c = _mpvTop.Controls[k];
                if (c == _mpvTopTitle) continue;
                c.Bounds = new Rectangle(x, 0, bw, h);
                x -= bw;
            }
            if (_mpvTopTitle != null) _mpvTopTitle.Bounds = new Rectangle((int)Math.Round(14 * (_form.DeviceDpi / 96.0)), 0, Math.Max(60, x - 14), h);
            _mpvTop.BringToFront();
        }
        catch (Exception ex) { Log("mpv: top EX " + ex.Message); }
    }

    /* 分栏：[原生标题条][mpv 视频区][WebView2 控制条]。
       barH < 0：WebView2 全隐藏；barH == 0：WebView2 铺满（选集抽屉）。 */
    private static void ApplyMpvLayout(int barH)
    {
        if (_mpvPanel == null || _wv == null) return;
        try
        {
            var cs = _form.ClientRectangle;
            int top = (_mpvTop != null && _mpvTop.Visible) ? MpvTopHeight() : 0;
            int bodyH = Math.Max(80, cs.Height - top);
            _mpvPanel.Dock = DockStyle.None;
            if (barH < 0)
            {
                _mpvPanel.Bounds = new Rectangle(0, top, cs.Width, bodyH);
                _wv.Visible = false;
                return;
            }
            if (barH == 0)
            {
                _mpvPanel.Bounds = new Rectangle(0, top, cs.Width, bodyH);
                _wv.Dock = DockStyle.None;
                _wv.Bounds = new Rectangle(0, top, cs.Width, bodyH);
                _wv.Visible = true;
                _wv.BringToFront();
                return;
            }
            int px = (int)Math.Round(barH * (_form.DeviceDpi / 96.0));
            px = Math.Max(40, Math.Min(bodyH - 80, px));
            _mpvPanel.Bounds = new Rectangle(0, top, cs.Width, Math.Max(80, bodyH - px));
            _wv.Dock = DockStyle.None;
            _wv.Bounds = new Rectangle(0, cs.Height - px, cs.Width, px);
            _wv.Visible = true;
            _wv.BringToFront();
        }
        catch (Exception ex) { Log("mpv: layout EX " + ex.Message); }
    }

    private static object MpvLayoutCmd(int barH)
    {
        try
        {
            _form.Invoke(new Action(() => { _mpvBarH = Math.Max(0, barH); ApplyMpvLayout(_mpvBarH); }));
            return new Dictionary<string, object> { { "ok", true }, { "bar", barH } };
        }
        catch (Exception ex) { return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } }; }
    }
    private static Dictionary<string, object> MpvPlay(JsonElement opts)
    {
        string url = "", title = "", headers = "";
        double start = 0;
        try { if (opts.TryGetProperty("url", out var a)) url = a.GetString() ?? ""; } catch { }
        try { if (opts.TryGetProperty("title", out var b)) title = b.GetString() ?? ""; } catch { }
        try { if (opts.TryGetProperty("headers", out var c)) headers = c.GetString() ?? ""; } catch { }
        try { if (opts.TryGetProperty("start", out var d)) start = d.GetDouble(); } catch { }
        int barH = 0;
        try { if (opts.TryGetProperty("barHeight", out var bh)) barH = (int)Math.Round(bh.GetDouble()); } catch { }
        if (url.Length == 0) return new Dictionary<string, object> { { "ok", false }, { "error", "url required" } };
        if (!File.Exists(MpvExe())) return new Dictionary<string, object> { { "ok", false }, { "error", "player-missing" } };
        if (_mpvProc != null && !_mpvProc.HasExited) MpvStop();

        var done = new TaskCompletionSource<Dictionary<string, object>>();
        _form.Invoke(new Action(() =>
        {
            try
            {
                if (_mpvPanel == null)
                {
                    _mpvPanel = new Panel { Dock = DockStyle.Fill, BackColor = Color.Black, Visible = false };
                    _form.Controls.Add(_mpvPanel);
                }
                var handle = _mpvPanel.Handle;    // 强制创建 HWND
                var psi = new ProcessStartInfo(MpvExe())
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = MpvDir()
                };
                void arg(string a) { psi.ArgumentList.Add(a); }
                arg("--wid=" + handle.ToInt64());
                arg("--force-window=yes");
                arg("--no-border");
                arg("--keep-open=no");
                arg("--hwdec=auto");
                arg("--osc=no");
                arg("--osd-level=1");
                arg("--input-default-bindings=yes");
                arg("--input-vo-keyboard=yes");
                arg("--msg-level=all=error");
                arg("--input-ipc-server=" + MpvPipe);
                arg("--no-ytdl");
                arg("--title=" + (title.Length == 0 ? "iread" : title));
                if (headers.Length > 0) arg("--http-header-fields=" + headers);
                if (start > 1) arg("--start=" + start.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
                arg(url);

                _mpvProc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                _mpvProc.Exited += (s2, e2) =>
                {
                    try { _form.BeginInvoke(new Action(() => MpvTeardown())); } catch { }
                };
                _mpvPanel.Visible = true;
                _mpvPanel.BringToFront();
                /* 播放时不要任何标题条/窗口按钮：网页那组红黄绿已在 body.mpv-mode 里隐藏，
                   窗体底色刷黑，避免 mpv 画面没盖满时露出浅色边。 */
                MpvBuildBack();
                MpvShowBack(true);
                if (_mpvPrevBg == Color.Empty) _mpvPrevBg = _form.BackColor;
                _form.BackColor = Color.Black;
                _mpvBarH = barH > 0 ? barH : 0;
                ApplyMpvLayout(_mpvBarH);
                _mpvProc.Start();
                _mpvState = "playing";
                Log("mpv: playing " + title);
                done.SetResult(new Dictionary<string, object> { { "ok", true }, { "pid", _mpvProc.Id }, { "wid", handle.ToInt64() } });
            }
            catch (Exception ex)
            {
                MpvTeardown();
                done.SetResult(new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
            }
        }));
        return done.Task.Wait(5000) ? done.Task.Result
            : new Dictionary<string, object> { { "ok", false }, { "error", "启动超时" } };
    }

    /* 通过 mpv 的 JSON IPC 发一条命令（get_property / set_property / seek …），
       返回原始回复行；主要用于探针验证「是否真的在解码」以及后续自绘控件。 */
    private static async Task<object> MpvCmd(string json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            using (var pipe = new System.IO.Pipes.NamedPipeClientStream(".", "iread-mpv", System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous))
            {
                await pipe.ConnectAsync(1500);
                var bytes = System.Text.Encoding.UTF8.GetBytes(json.Trim() + "\n");
                await pipe.WriteAsync(bytes, 0, bytes.Length);
                await pipe.FlushAsync();
                /* mpv 在同一个 pipe 上也会推 event（start-file/end-file/…），
                   一次读取可能只拿到 event、拿不到我们的回包 —— 逐行读，跳过 event 行，
                   直到出现带 data/error 的响应行（最多 3s / 40 行）。 */
                var sb = new System.Text.StringBuilder();
                var buf = new byte[4096];
                var deadline = DateTime.UtcNow.AddMilliseconds(3000);
                int lines = 0;
                while (DateTime.UtcNow < deadline && lines < 40)
                {
                    var left = (int)Math.Max(50, (deadline - DateTime.UtcNow).TotalMilliseconds);
                    string line = null;
                    using (var cts = new System.Threading.CancellationTokenSource(left))
                    {
                        int n;
                        try { n = await pipe.ReadAsync(buf, 0, buf.Length, cts.Token); }
                        catch (OperationCanceledException) { break; }
                        if (n <= 0) break;
                        sb.Append(System.Text.Encoding.UTF8.GetString(buf, 0, n));
                    }
                    string all = sb.ToString();
                    int nl;
                    while ((nl = all.IndexOf('\n')) >= 0)
                    {
                        line = all.Substring(0, nl).Trim();
                        all = all.Substring(nl + 1);
                        sb.Clear();
                        sb.Append(all);
                        lines++;
                        if (line.Length == 0) continue;
                        if (line.IndexOf("\"event\"", StringComparison.Ordinal) >= 0) continue;
                        return line;
                    }
                }
                var tail = sb.ToString().Trim();
                return tail.Length == 0 ? null : tail;
            }
        }
        catch (Exception ex) { return "ERR: " + ex.Message; }
    }

    private static object MpvStop()
    {
        try
        {
            if (_mpvProc != null && !_mpvProc.HasExited)
            {
                try { _mpvProc.Kill(true); } catch { }
                _mpvProc.WaitForExit(1500);
            }
        }
        catch (Exception ex) { Log("mpv: stop err " + ex.Message); }
        try { _form.Invoke(new Action(() => MpvTeardown())); } catch { }
        return true;
    }

    private static void MpvTeardown()
    {
        _mpvState = "idle";
        try { if (_mpvPanel != null) _mpvPanel.Visible = false; } catch { }
        _mpvBarH = 0;
        try { MpvLayoutTop(false); } catch { }
        try { MpvShowBack(false); } catch { }
        try { _form.Activate(); } catch { }
        try { if (_mpvPrevBg != Color.Empty) { _form.BackColor = _mpvPrevBg; _mpvPrevBg = Color.Empty; } } catch { }
        try { _wv.Dock = DockStyle.Fill; } catch { }
        try { _wv.Bounds = _form.ClientRectangle; } catch { }
        try { _wv.Visible = true; _wv.Focus(); } catch { }
        try { _core?.ExecuteScriptAsync("window.NR&&window.NR.mpv&&window.NR.mpv._ended&&window.NR.mpv._ended();"); } catch { }
    }

    /* ================================================================
     * 筛选报错日志（appendLog / logsDir / openLogsDir）
     *   根目录：AppContext.BaseDirectory\logs\screen（安装在 %LOCALAPPDATA%\iread-webview2，可写）；
     *   不可写时退回 _userDataDir\..\logs\screen。首次探测后缓存。
     * ================================================================ */
    private const int LogMaxBytes = 2 * 1024 * 1024;
    private static readonly object LogLock = new object();
    private static string _screenLogsDir;

    private static bool IsSafeLogName(string n)
    {
        if (string.IsNullOrEmpty(n) || n.Length > 100) return false;
        bool allDots = true;
        foreach (var c in n)
        {
            bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                      || c == '.' || c == '_' || c == '-';
            if (!ok) return false;
            if (c != '.') allDots = false;
        }
        return !allDots;
    }

    private static bool TryPrepareWritableDir(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, ".write-probe-" + Environment.ProcessId);
            File.WriteAllText(probe, "", new UTF8Encoding(false));
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }

    private static string ScreenLogsDir()
    {
        lock (LogLock)
        {
            if (_screenLogsDir != null) return _screenLogsDir;
            var primary = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "logs", "screen"));
            if (TryPrepareWritableDir(primary)) return _screenLogsDir = primary;
            var baseUd = string.IsNullOrEmpty(_userDataDir) ? Path.Combine(Path.GetTempPath(), "ireadspike-udata") : _userDataDir;
            var fallback = Path.GetFullPath(Path.Combine(baseUd, "..", "logs", "screen"));
            if (TryPrepareWritableDir(fallback)) return _screenLogsDir = fallback;
            Log("screen logs dir: neither writable: " + primary + " | " + fallback);
            return primary;   // 都不可写：不缓存，下次再探测；写入时会返回 {ok:false,error}
        }
    }

    private static Dictionary<string, object> AppendScreenLog(string name, string text)
    {
        try
        {
            name = name ?? "";
            if (!IsSafeLogName(name))
                return new Dictionary<string, object> { { "ok", false }, { "error", "日志文件名非法：" + (name.Length > 120 ? name.Substring(0, 120) : name) } };
            text = text ?? "";
            var enc = new UTF8Encoding(false);
            if (enc.GetByteCount(text) > LogMaxBytes)
                return new Dictionary<string, object> { { "ok", false }, { "error", "单次日志超过 2MB 上限" } };
            var dir = ScreenLogsDir();
            Directory.CreateDirectory(dir);
            var p = Path.Combine(dir, name);
            lock (LogLock) File.AppendAllText(p, text, enc);
            return new Dictionary<string, object> { { "ok", true }, { "path", p } };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
        }
    }

    private static string _mockBookPath;
    private static string _mockSourcePath;

    private static Dictionary<string, object> ReadBookFile(string p)
    {
        if (!File.Exists(p)) throw new Error_( "文件不存在：" + p);
        var bytes = File.ReadAllBytes(p);
        return new Dictionary<string, object> {
            { "name", Path.GetFileName(p) },
            { "path", p },
            { "size", bytes.Length },
            { "mtime", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() },
            { "type", "text/plain" },
            { "dataB64", Convert.ToBase64String(bytes) }   // base64 跨 WebMessage 安全，shim 转回 Uint8Array
        };
    }
    private class Error_ : Exception { public Error_(string m) : base(m) { } }

    private const int NetworkMaxBytes = 8 * 1024 * 1024;
    // Generic text/image calls share cookies, but not the legacy proxy's independent 100s timer.
    private static readonly System.Net.Http.HttpClient NetworkHttp = new System.Net.Http.HttpClient
    {
        Timeout = System.Threading.Timeout.InfiniteTimeSpan
    };

    private static Task<Dictionary<string, object>> HostFetchText(JsonElement opts) => HostFetch(opts, false);
    private static Task<Dictionary<string, object>> HostFetchImage(JsonElement opts) => HostFetch(opts, true);

    private static string NetworkString(JsonElement opts, string name)
    {
        if (!opts.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String)
            throw RuleProcess.Error("RULE_REQUEST", name + " must be a string");
        return value.GetString();
    }

    private static Dictionary<string, string> NetworkHeaders(JsonElement opts)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!opts.TryGetProperty("headers", out var value) || value.ValueKind == JsonValueKind.Null) return headers;
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var header in value.EnumerateObject())
                headers[header.Name] = header.Value.ValueKind == JsonValueKind.String ? header.Value.GetString() : header.Value.GetRawText();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var header in value.EnumerateArray())
            {
                if (header.ValueKind != JsonValueKind.Object || !header.TryGetProperty("name", out var name) ||
                    name.ValueKind != JsonValueKind.String || !header.TryGetProperty("value", out var item) || item.ValueKind != JsonValueKind.String)
                    throw RuleProcess.Error("RULE_REQUEST", "headers entries must have string name/value");
                headers[name.GetString()] = item.GetString();
            }
        }
        else throw RuleProcess.Error("RULE_REQUEST", "headers must be an object or array");
        return headers;
    }

    /* ================================================================
     * 封面磁盘缓存
     * ---------------------------------------------------------------
     * 宿主抓图后在本地存一份（<data 根>\cover-cache\<sha256>.<ext>），
     * 下次同一个 URL 直接读盘、不再联网。总量超上限时按最久未用淘汰。
     * 只缓存图片（image:true），文本页永不缓存，避免缓存到临时错误页。
     * ================================================================ */
    private const long CoverCacheMaxBytes = 200L * 1024 * 1024;
    private static readonly TimeSpan CoverCacheTtl = TimeSpan.FromDays(14);
    private static readonly string[] CoverCacheExts = new[] { ".jpg", ".png", ".webp", ".gif", ".bmp", ".avif", ".bin" };

    /* ================================================================
     * 插件目录（v1）：用户插件放 <数据根>\plugins，内置示例插件放 <程序目录>\wwwroot\plugins。
     * 两者都只读 manifest.json + 用 <script> 加载入口；用户插件经 https://plugins.local 提供。
     * ================================================================ */
    /* 插件私有文件目录：<数据根>\plugin-data\<插件 id>\。
     * 只允许普通文件名（拒绝路径分隔符与 ..），每个插件互相看不到对方目录。 */
    private static string PluginDataRoot()
    {
        var root = string.IsNullOrEmpty(_userDataDir) ? null : Path.GetDirectoryName(Path.GetFullPath(_userDataDir));
        if (string.IsNullOrEmpty(root)) root = Path.Combine(Path.GetTempPath(), "iread-plugins-home");
        return Path.Combine(root, "plugin-data");
    }

    private static object PluginFs(JsonElement opts)
    {
        try
        {
            var id = opts.TryGetProperty("id", out var idv) ? (idv.GetString() ?? "") : "";
            if (id.Length == 0 || id.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || id.Contains(".."))
                return new Dictionary<string, object> { { "ok", false }, { "error", "插件 id 不合法" } };
            var dir = Path.Combine(PluginDataRoot(), id);
            Directory.CreateDirectory(dir);
            var op = opts.TryGetProperty("op", out var opv) ? (opv.GetString() ?? "") : "list";
            var name = opts.TryGetProperty("name", out var nv) ? (nv.GetString() ?? "") : "";
            if (name.Length > 0 && (name.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || name.Contains("..")))
                return new Dictionary<string, object> { { "ok", false }, { "error", "文件名不合法" } };
            var path = name.Length == 0 ? dir : Path.Combine(dir, name);
            switch (op)
            {
                case "dir":
                case "list":
                    {
                        var files = new List<object>();
                        foreach (var f in Directory.EnumerateFiles(dir))
                            files.Add(new Dictionary<string, object>
                            {
                                { "name", Path.GetFileName(f) },
                                { "size", new FileInfo(f).Length },
                                { "at", File.GetLastWriteTimeUtc(f).ToString("o") }
                            });
                        return new Dictionary<string, object> { { "ok", true }, { "dir", dir }, { "files", files } };
                    }
                case "read":
                    return File.Exists(path)
                        ? new Dictionary<string, object> { { "ok", true }, { "name", name }, { "text", File.ReadAllText(path) } }
                        : new Dictionary<string, object> { { "ok", false }, { "error", "文件不存在：" + name } };
                case "write":
                    {
                        var text = opts.TryGetProperty("text", out var tv) ? (tv.GetString() ?? "") : "";
                        File.WriteAllText(path, text);
                        return new Dictionary<string, object> { { "ok", true }, { "name", name }, { "size", new FileInfo(path).Length } };
                    }
                case "append":
                    {
                        var text2 = opts.TryGetProperty("text", out var tv2) ? (tv2.GetString() ?? "") : "";
                        File.AppendAllText(path, text2);
                        return new Dictionary<string, object> { { "ok", true }, { "name", name }, { "size", new FileInfo(path).Length } };
                    }
                case "remove":
                    if (File.Exists(path)) File.Delete(path);
                    return new Dictionary<string, object> { { "ok", true } };
                default:
                    return new Dictionary<string, object> { { "ok", false }, { "error", "未知操作：" + op } };
            }
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
        }
    }

    private static string PluginsDir()
    {
        var root = string.IsNullOrEmpty(_userDataDir) ? null : Path.GetDirectoryName(Path.GetFullPath(_userDataDir));
        if (string.IsNullOrEmpty(root)) root = Path.Combine(Path.GetTempPath(), "iread-plugins-home");
        return Path.Combine(root, "plugins");
    }

    /* 载入插件压缩包：选一个 zip → 解到 <数据根>\plugins\<目录名>。
     * 一个 zip 里可以有多个插件（每个顶层目录各带 manifest.json）；manifest.json 直接在
     * zip 根时用 zip 文件名当目录名。解压对路径做前缀校验，拒绝 .. 之类的越界项。 */
    private static object ImportPluginZip(string[] args)
    {
        string zipPath = (args != null && args.Length > 0) ? (args[0] ?? "") : "";
        if (!string.IsNullOrWhiteSpace(zipPath))
        {
            if (!File.Exists(zipPath)) return new Dictionary<string, object> { { "ok", false }, { "error", "压缩包不存在" } };
        }
        else
        using (var dlg = new OpenFileDialog())
        {
            dlg.Filter = "插件压缩包 (*.zip)|*.zip|全部文件 (*.*)|*.*";
            dlg.Title = "载入插件（压缩包）";
            dlg.CheckFileExists = true;
            if (dlg.ShowDialog() != DialogResult.OK) return new Dictionary<string, object> { { "canceled", true } };
            zipPath = dlg.FileName;
        }

        var root = PluginsDir();
        Directory.CreateDirectory(root);
        var rootFull = Path.GetFullPath(root);
        var done = new List<object>();
        try
        {
            using (var zip = System.IO.Compression.ZipFile.OpenRead(zipPath))
            {
                var entries = zip.Entries
                    .Select(e => new { Entry = e, Name = e.FullName.Replace('\\', '/').TrimStart('/') })
                    .Where(x => x.Name.Length > 0 && !x.Name.EndsWith("/"))
                    .ToList();
                if (entries.Count == 0) return new Dictionary<string, object> { { "ok", false }, { "error", "压缩包是空的" } };

                // 每个 manifest.json 所在目录 = 一个插件
                var dirs = entries
                    .Where(x => Path.GetFileName(x.Name).Equals("manifest.json", StringComparison.OrdinalIgnoreCase))
                    .Select(x => { var d = Path.GetDirectoryName(x.Name) ?? ""; return d.Replace('\\', '/').Trim('/'); })
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                if (dirs.Count == 0) return new Dictionary<string, object> { { "ok", false }, { "error", "压缩包里没有 manifest.json" } };

                foreach (var manifestDir in dirs)
                {
                    var id = manifestDir.Length == 0 ? Path.GetFileNameWithoutExtension(zipPath) : manifestDir.Split('/').Last();
                    if (string.IsNullOrWhiteSpace(id)) id = "plugin";
                    var target = Path.GetFullPath(Path.Combine(root, id));
                    if (!target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) continue;
                    var prefix = manifestDir.Length == 0 ? "" : manifestDir + "/";
                    foreach (var x in entries)
                    {
                        if (prefix.Length > 0 && !x.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                        var rel = prefix.Length > 0 ? x.Name.Substring(prefix.Length) : x.Name;
                        if (rel.Length == 0) continue;
                        var dest = Path.GetFullPath(Path.Combine(target, rel));
                        if (!dest.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        using (var src = x.Entry.Open())
                        using (var dst = File.Create(dest)) src.CopyTo(dst);
                    }
                    var mp = Path.Combine(target, "manifest.json");
                    if (!File.Exists(mp)) continue;
                    string nm = id;
                    try
                    {
                        using (var doc = JsonDocument.Parse(File.ReadAllText(mp)))
                            if (doc.RootElement.TryGetProperty("name", out var e2)) nm = e2.GetString() ?? id;
                    }
                    catch (Exception) { }
                    done.Add(new Dictionary<string, object> { { "id", id }, { "name", nm }, { "dir", target } });
                    Log("plugin imported: " + id + " <- " + zipPath);
                }
            }
        }
        catch (Exception ex)
        {
            Log("plugin import failed: " + ex.Message);
            return new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
        }

        if (done.Count == 0) return new Dictionary<string, object> { { "ok", false }, { "error", "没有可载入的插件" } };
        var first = done[0] as Dictionary<string, object>;
        return new Dictionary<string, object>
        {
            { "ok", true },
            { "count", done.Count },
            { "id", first != null ? first["id"] : "" },
            { "name", first != null ? first["name"] : "" },
            { "plugins", done }
        };
    }

    private static string BuiltinPluginsDir()
    {
        return Path.Combine(AppContext.BaseDirectory, "wwwroot", "plugins");
    }

    private static object PluginsList()
    {
        var entries = new List<object>();
        foreach (var pair in new[] { Tuple.Create("builtin", BuiltinPluginsDir()), Tuple.Create("user", PluginsDir()) })
        {
            var dir = pair.Item2;
            if (!Directory.Exists(dir)) continue;
            foreach (var sub in Directory.EnumerateDirectories(dir))
            {
                var manifest = Path.Combine(sub, "manifest.json");
                if (!File.Exists(manifest)) continue;
                try
                {
                    entries.Add(new Dictionary<string, object>
                    {
                        { "id", Path.GetFileName(sub) },
                        { "source", pair.Item1 },
                        { "manifest", File.ReadAllText(manifest) }
                    });
                }
                catch (Exception ex) { Log("plugin manifest read failed: " + sub + " " + ex.Message); }
            }
        }
        return new Dictionary<string, object>
        {
            { "dir", PluginsDir() },
            { "builtin", BuiltinPluginsDir() },
            { "entries", entries }
        };
    }

    private static string CoverCacheDir()
    {
        var custom = CoverCacheOverride();
        if (!string.IsNullOrEmpty(custom)) return custom;
        var root = string.IsNullOrEmpty(_userDataDir) ? null : Path.GetDirectoryName(Path.GetFullPath(_userDataDir));
        if (string.IsNullOrEmpty(root)) root = Path.Combine(Path.GetTempPath(), "iread-covers");
        return Path.Combine(root, "cover-cache");
    }

    /* 用户可在「数据 → 缓存」里改封面缓存目录；空 = 默认（数据目录下的 cover-cache）。
     * 存一个纯文本文件，宿主每次启动读一次。 */
    private static string _coverCacheOverride;
    private static bool _coverCacheLoaded;

    private static string CoverCachePrefFile()
    {
        var root = string.IsNullOrEmpty(_userDataDir) ? Path.GetTempPath() : Path.GetDirectoryName(Path.GetFullPath(_userDataDir));
        return Path.Combine(root ?? Path.GetTempPath(), "cover-cache-dir.txt");
    }

    private static string CoverCacheOverride()
    {
        if (_coverCacheLoaded) return _coverCacheOverride;
        _coverCacheLoaded = true;
        try
        {
            var file = CoverCachePrefFile();
            if (!File.Exists(file)) return null;
            var text = File.ReadAllText(file).Trim();
            if (text.Length > 0) _coverCacheOverride = text;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException) { }
        return _coverCacheOverride;
    }

    private static Dictionary<string, object> CoverCacheInfo()
    {
        var dir = CoverCacheDir();
        long size = 0; int count = 0;
        try
        {
            if (Directory.Exists(dir))
            {
                foreach (var file in new DirectoryInfo(dir).GetFiles()) { size += file.Length; count++; }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        return new Dictionary<string, object> {
            { "dir", dir }, { "custom", !string.IsNullOrEmpty(CoverCacheOverride()) },
            { "size", size }, { "count", count },
            { "max", CoverCacheMaxBytes }, { "ttlDays", (int)CoverCacheTtl.TotalDays }
        };
    }

    private static string CoverCacheKey(string url)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(url ?? ""));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string CoverCacheMime(string ext)
    {
        switch (ext)
        {
            case ".png": return "image/png";
            case ".webp": return "image/webp";
            case ".gif": return "image/gif";
            case ".bmp": return "image/bmp";
            case ".avif": return "image/avif";
            case ".jpg": return "image/jpeg";
            default: return "image/jpeg";
        }
    }

    private static string CoverCacheExt(string type)
    {
        switch ((type ?? "").ToLowerInvariant())
        {
            case "image/png": return ".png";
            case "image/webp": return ".webp";
            case "image/gif": return ".gif";
            case "image/bmp": return ".bmp";
            case "image/avif": return ".avif";
            default: return ".jpg";
        }
    }

    private static string CoverCacheTryRead(string url)
    {
        try
        {
            if (string.IsNullOrEmpty(url)) return null;
            var dir = CoverCacheDir();
            if (!Directory.Exists(dir)) return null;
            var key = CoverCacheKey(url);
            foreach (var ext in CoverCacheExts)
            {
                var file = Path.Combine(dir, key + ext);
                if (!File.Exists(file)) continue;
                if (DateTime.UtcNow - File.GetLastWriteTimeUtc(file) > CoverCacheTtl)
                {
                    try { File.Delete(file); } catch (Exception) { }
                    return null;
                }
                var bytes = File.ReadAllBytes(file);
                if (bytes.Length == 0) return null;
                try { File.SetLastWriteTimeUtc(file, DateTime.UtcNow); } catch (Exception) { }
                return "data:" + CoverCacheMime(ext) + ";base64," + Convert.ToBase64String(bytes);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            Log("cover-cache read skip: " + e.Message);
        }
        return null;
    }

    private static void CoverCacheWrite(string url, string type, byte[] bytes)
    {
        if (string.IsNullOrEmpty(url) || bytes == null || bytes.Length == 0) return;
        try
        {
            var dir = CoverCacheDir();
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, CoverCacheKey(url) + CoverCacheExt(type)), bytes);
            CoverCachePrune(dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            Log("cover-cache write skip: " + e.Message);
        }
    }

    /* 超过上限就按最后访问时间从旧到新删，删到 80% 为止 */
    private static void CoverCachePrune(string dir)
    {
        try
        {
            var files = new DirectoryInfo(dir).GetFiles();
            long total = 0;
            foreach (var file in files) total += file.Length;
            if (total <= CoverCacheMaxBytes) return;
            Array.Sort(files, (a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
            var target = (long)(CoverCacheMaxBytes * 0.8);
            foreach (var file in files)
            {
                if (total <= target) break;
                total -= file.Length;
                try { file.Delete(); } catch (Exception) { }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log("cover-cache prune skip: " + e.Message);
        }
    }

    /* 漫画图片解密：下载密文图片字节 → 交给规则 worker 跑书源自带的 ruleContent.imageDecode
       → 返回可以直接放到 <img src> 的 data URL。解密脚本跑在 worker 里，因为 UI 页面不加载 legacy-js.js。 */
    private static async Task<string> DecodeImage(JsonElement opts)
    {
        if (opts.ValueKind != JsonValueKind.Object)
            throw RuleProcess.Error("RULE_REQUEST", "decodeImage options must be an object");
        string url = NetworkString(opts, "url");
        string code = NetworkString(opts, "code");
        if (string.IsNullOrWhiteSpace(code)) return "";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw RuleProcess.Error("NET", "Only http/https URLs are supported");
        int timeout = 30000;
        if (opts.TryGetProperty("timeout", out var budget) && budget.ValueKind == JsonValueKind.Number &&
            budget.TryGetInt32(out var budgetMs) && budgetMs > 0 && budgetMs <= 120000) timeout = budgetMs;
        byte[] bytes;
        // 页面自己抓下来的字节（优先）；没有才自己下。
        string inlineB64 = NetworkString(opts, "b64");
        if (!string.IsNullOrEmpty(inlineB64))
        {
            try { bytes = Convert.FromBase64String(inlineB64); }
            catch (FormatException) { throw RuleProcess.Error("RULE_REQUEST", "decodeImage b64 is not valid base64"); }
        }
        else
        {
            // 有些图床会随机重置 TLS 握手（ECONNRESET），重试几轮基本能过。
            bytes = null;
            Exception lastError = null;
            for (int attempt = 0; attempt < 4 && bytes == null; attempt++)
            {
                if (attempt > 0) await Task.Delay(300 * attempt).ConfigureAwait(false);
                try
                {
                    using var request = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, uri);
                    request.Headers.TryAddWithoutValidation("User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
                    request.Headers.TryAddWithoutValidation("Accept", "image/avif,image/webp,image/png,image/*,*/*;q=0.8");
                    var referer = NetworkString(opts, "referer");
                    if (!string.IsNullOrEmpty(referer)) request.Headers.TryAddWithoutValidation("Referer", referer);
                    using var cts = new CancellationTokenSource(timeout);
                    using var response = await NetworkHttp.SendAsync(request, System.Net.Http.HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
                    int status = (int)response.StatusCode;
                    if (status >= 400) throw RuleProcess.Error("HTTP", "HTTP " + status + ": " + url);
                    bytes = await response.Content.ReadAsByteArrayAsync(cts.Token).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is System.Net.Http.HttpRequestException || ex is System.IO.IOException)
                {
                    lastError = ex;
                }
            }
            if (bytes == null) throw lastError ?? RuleProcess.Error("NET", "download failed: " + url);
        }
            if (bytes.Length == 0) return "";
            JsonElement source = opts.TryGetProperty("source", out var src) && src.ValueKind == JsonValueKind.Object
                ? src.Clone() : JsonSerializer.SerializeToElement(new Dictionary<string, object>());
            var payload = JsonSerializer.SerializeToElement(new Dictionary<string, object>
            {
                ["operation"] = "decodeImage",
                ["source"] = source,
                ["args"] = new object[] { Convert.ToBase64String(bytes), code },
                ["timeout"] = 60000
            });
            var outcome = await RuleProcess.ExecuteAsync(payload).ConfigureAwait(false);
            string outB64 = null;
            if (outcome is JsonElement doc && doc.ValueKind == JsonValueKind.Object &&
                doc.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.String)
                outB64 = value.GetString();
            if (string.IsNullOrEmpty(outB64)) return "";
            byte[] plain;
            try { plain = Convert.FromBase64String(outB64); }
            catch (FormatException) { return ""; }
            return "data:" + SniffImageMime(plain) + ";base64," + outB64;
        }
    
        private static string SniffImageMime(byte[] b)
        {
            if (b.Length >= 4 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46) return "image/webp";
            if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xD8) return "image/jpeg";
            if (b.Length >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
            if (b.Length >= 3 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46) return "image/gif";
            return "image/jpeg";
        }
    
        private static bool IsTransientNet(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is not (System.Net.Http.HttpRequestException or System.IO.IOException or System.Net.Sockets.SocketException)) continue;
            var m = ((e.Message ?? "") + " " + (e.InnerException?.Message ?? "")).ToLowerInvariant();
            if (m.Contains("ssl") || m.Contains("socket") || m.Contains("reset") || m.Contains("prematurely") ||
                m.Contains("connection") || m.Contains("forcibly")) return true;
        }
        return false;
    }

    /* ================================================================
     * 视频地址嗅探 sniffVideo
     *   页面：NR.platform.sniffVideo({ url, sourceRegex, notSourceRegex,
     *                                webviewJs, webviewJsDelay, timeout, referer })
     *   宿主：在屏外开一个隐藏的第二 WebView2（独立 profile EBWebView-sniff），
     *        挂 WebResourceResponseReceived / WebResourceRequested 监听网络请求，
     *        命中 sourceRegex 且不命中 notSourceRegex 的地址就是结果；也支持
     *        页面加载后跑 webviewJs 把返回值当地址（部分站点地址在 JS 变量里）。
     *   视频嗅探本身就慢，用 SniffGate 串行，避免多个隐藏窗口互相抢资源。
     * ================================================================ */
    private static readonly SemaphoreSlim SniffGate = new SemaphoreSlim(1, 1);
    private const int SniffMaxCandidates = 10;

    private static async Task<string> SniffVideo(JsonElement opts)
    {
        if (opts.ValueKind != JsonValueKind.Object)
            throw RuleProcess.Error("RULE_REQUEST", "sniffVideo options must be an object");
        string url = NetworkString(opts, "url");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw RuleProcess.Error("NET", "sniffVideo 只支持 http/https 页面地址");
        string sourcePattern = NetworkString(opts, "sourceRegex");
        if (string.IsNullOrWhiteSpace(sourcePattern)) sourcePattern = @"(\.m3u8|\.mp4)";
        string notSourcePattern = NetworkString(opts, "notSourceRegex");
        string webviewJs = NetworkString(opts, "webviewJs");
        string referer = NetworkString(opts, "referer");
        int jsDelay = 1000;
        if (opts.TryGetProperty("webviewJsDelay", out var delayValue) && delayValue.ValueKind == JsonValueKind.Number &&
            delayValue.TryGetInt32(out var delayMs) && delayMs >= 0 && delayMs <= 60000) jsDelay = delayMs;
        int timeout = 20000;
        if (opts.TryGetProperty("timeout", out var budget) && budget.ValueKind == JsonValueKind.Number &&
            budget.TryGetInt32(out var timeoutMs) && timeoutMs > 0) timeout = Math.Min(timeoutMs, 60000);
        Regex source, notSource = null;
        try
        {
            source = new Regex(sourcePattern, RegexOptions.IgnoreCase);
            if (!string.IsNullOrWhiteSpace(notSourcePattern))
                notSource = new Regex(notSourcePattern, RegexOptions.IgnoreCase);
        }
        catch (ArgumentException ex)
        {
            throw RuleProcess.Error("RULE_REQUEST", "sniffVideo 正则无效: " + ex.Message);
        }
        Log("sniffVideo <- " + uri + "  re=" + sourcePattern + (notSourcePattern == null ? "" : "  not=" + notSourcePattern));
        await SniffGate.WaitAsync().ConfigureAwait(true);
        try
        {
            // 隐藏窗口/WebView2 必须在 UI 线程创建（本方法由 WebMessageReceived 在 UI 线程调起）
            return await RunOnUi(() => SniffVideoCore(uri.ToString(), source, notSource, webviewJs, jsDelay, timeout, referer));
        }
        finally
        {
            SniffGate.Release();
        }
    }

    /* 宿主命令可能在 UI 线程之外的 __cmd 通道被调起；统一切回 UI 线程再碰窗口。 */
    private static Task<string> RunOnUi(Func<Task<string>> work)
    {
        if (_form == null || !_form.InvokeRequired) return work();
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            _form.BeginInvoke(new Action(async () =>
            {
                try { tcs.TrySetResult(await work().ConfigureAwait(true)); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            }));
        }
        catch (Exception ex) { tcs.TrySetException(ex); }
        return tcs.Task;
    }

    private static async Task<string> SniffVideoCore(string pageUrl, Regex source, Regex notSource,
        string webviewJs, int jsDelay, int timeout, string referer)
    {
        var elapsed = Stopwatch.StartNew();
        // RunContinuationsAsynchronously：绝不在 WebView2 事件回调里跑后续逻辑
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var candidates = new List<string>();
        var guard = new object();
        var errorText = new StringBuilder();
        Form win = null;
        WebView2 wv = null;
        CoreWebView2 sniffCore = null;
        EventHandler<CoreWebView2NavigationCompletedEventArgs> navHandler = null;
        int jsRuns = 0;

        // 命中判定：先 sourceRegex，再排除 notSourceRegex；命中的前 N 条进 candidates 便于排错
        void Consider(string rawUrl, string via)
        {
            if (string.IsNullOrEmpty(rawUrl)) return;
            if (!source.IsMatch(rawUrl)) return;
            lock (guard)
            {
                if (candidates.Count < SniffMaxCandidates && !candidates.Contains(rawUrl)) candidates.Add(rawUrl);
            }
            if (notSource != null && notSource.IsMatch(rawUrl)) return;
            if (!tcs.Task.IsCompleted)
                Log("sniffVideo 命中(" + via + ") " + rawUrl);
            tcs.TrySetResult(SniffResultJson(true, rawUrl, via, elapsed.ElapsedMilliseconds, null, null));
        }
        void OnResponse(object s, CoreWebView2WebResourceResponseReceivedEventArgs e)
        {
            try { Consider(e.Request != null ? e.Request.Uri : null, "network"); }
            catch (Exception) { }   // 回调里绝不抛
        }
        void OnRequest(object s, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try { Consider(e.Request != null ? e.Request.Uri : null, "network"); }
            catch (Exception) { }
        }

        try
        {
            win = new Form
            {
                Text = "iread sniff",
                ShowInTaskbar = false,
                Opacity = 0,
                Size = new Size(480, 320),
                StartPosition = FormStartPosition.Manual,
                Location = new Point(-4000, -4000),
                FormBorderStyle = FormBorderStyle.None,
                ShowIcon = false
            };
            wv = new WebView2 { Dock = DockStyle.Fill };
            win.Controls.Add(wv);
            win.Show();   // 必须 Show 才会真正创建浏览器并开始加载

            string baseDir = string.IsNullOrEmpty(_userDataDir)
                ? Path.Combine(Path.GetTempPath(), "ireadspike-udata") : _userDataDir;
            string profilePath = Path.Combine(baseDir, "EBWebView-sniff");   // 绝不复用主 profile
            Directory.CreateDirectory(profilePath);
            // --mute-audio：隐窗不许出声；--disable-background-timer-throttling：离屏窗口
            // 会被 Chromium 判成隐藏页、定时器降到 1 次/分，webviewJs 等待/轮询会失效。
            var envOptions = new CoreWebView2EnvironmentOptions("--mute-audio --disable-background-timer-throttling");
            var env = await CoreWebView2Environment.CreateAsync(null, profilePath, envOptions);
            await wv.EnsureCoreWebView2Async(env);
            sniffCore = wv.CoreWebView2;
            try
            {
                sniffCore.Settings.AreDefaultScriptDialogsEnabled = false; // 页面 alert 不许卡住隐窗
            }
            catch (Exception) { }

            sniffCore.WebResourceResponseReceived += OnResponse;
            // Requested 是补充：有些地址在 Response 事件里看不到（被缓存/被拦截），靠它兜
            sniffCore.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            sniffCore.WebResourceRequested += OnRequest;

            if (!string.IsNullOrWhiteSpace(webviewJs))
            {
                navHandler = async (s, e) =>
                {
                    try
                    {
                        if (Interlocked.Increment(ref jsRuns) > 2) return;   // 多次跳转不重复跑
                        if (!e.IsSuccess)
                            lock (guard) errorText.Append("导航失败(" + e.WebErrorStatus + ")；");
                        await Task.Delay(jsDelay);
                        if (tcs.Task.IsCompleted || sniffCore == null) return;
                        string raw = await sniffCore.ExecuteScriptAsync(webviewJs);
                        if (tcs.Task.IsCompleted) return;
                        string picked = SniffPickJsUrl(raw, source, notSource);
                        if (!string.IsNullOrEmpty(picked))
                        {
                            Log("sniffVideo 命中(js) " + picked);
                            tcs.TrySetResult(SniffResultJson(true, picked, "js", elapsed.ElapsedMilliseconds, null, null));
                        }
                        else lock (guard) errorText.Append("webviewJs 未取到视频地址；");
                    }
                    catch (Exception ex)
                    {
                        lock (guard) errorText.Append("webviewJs 执行失败: " + ex.Message + "；");
                    }
                };
                sniffCore.NavigationCompleted += navHandler;
            }

            try
            {
                if (!string.IsNullOrWhiteSpace(referer))
                {
                    var request = sniffCore.Environment.CreateWebResourceRequest(
                        pageUrl, "GET", null, "Referer: " + referer + "\r\n");
                    sniffCore.NavigateWithWebResourceRequest(request);
                }
                else sniffCore.Navigate(pageUrl);
            }
            catch (Exception ex)
            {
                lock (guard) errorText.Append("导航启动失败: " + ex.Message + "；");
            }

            var finished = await Task.WhenAny(tcs.Task, Task.Delay(timeout));
            if (finished == tcs.Task) return await tcs.Task;
            List<string> seen;
            string extra;
            lock (guard)
            {
                seen = new List<string>(candidates);
                extra = errorText.ToString().Trim();
            }
            string message = "超时（" + timeout + "ms）未嗅探到视频地址";
            if (extra.Length > 0) message += "；" + extra;
            Log("sniffVideo 超时, candidates=" + seen.Count);
            return SniffResultJson(false, null, null, elapsed.ElapsedMilliseconds, message, seen);
        }
        catch (Exception ex)
        {
            List<string> seen;
            lock (guard) seen = new List<string>(candidates);
            Log("sniffVideo ERR " + ex.Message);
            return SniffResultJson(false, null, null, elapsed.ElapsedMilliseconds,
                "嗅探失败: " + ex.Message, seen);
        }
        finally
        {
            // 不管成功失败都要退订事件、关窗、放掉隐窗，绝不泄漏
            if (sniffCore != null)
            {
                try { sniffCore.WebResourceResponseReceived -= OnResponse; } catch (Exception) { }
                try { sniffCore.WebResourceRequested -= OnRequest; } catch (Exception) { }
                try { sniffCore.RemoveWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All); } catch (Exception) { }
                if (navHandler != null) { try { sniffCore.NavigationCompleted -= navHandler; } catch (Exception) { } }
                try { sniffCore.Stop(); } catch (Exception) { }
            }
            try { if (wv != null) wv.Dispose(); } catch (Exception) { }
            try { if (win != null) { win.Close(); win.Dispose(); } } catch (Exception) { }
            await Task.Delay(200);   // 留一点时间让浏览器子进程回收
        }
    }

    /* webviewJs 的返回值可能是字符串、也可能是 JSON；从中挑一个像视频地址的 URL。 */
    private static string SniffPickJsUrl(string raw, Regex source, Regex notSource)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        string text = raw;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.ValueKind == JsonValueKind.String) text = doc.RootElement.GetString() ?? "";
        }
        catch (JsonException) { }
        if (text.IndexOf("http", StringComparison.OrdinalIgnoreCase) < 0) return null;
        string firstAny = null;
        foreach (Match m in Regex.Matches(text, @"https?://[^\s""'\\<>]+", RegexOptions.IgnoreCase))
        {
            string picked = m.Value;
            if (picked.Length == 0) continue;
            if (source.IsMatch(picked) && (notSource == null || !notSource.IsMatch(picked))) return picked;
            if (firstAny == null) firstAny = picked;
        }
        return firstAny;
    }

    private static string SniffResultJson(bool ok, string url, string via, long elapsed,
        string error, List<string> candidates)
    {
        var payload = new Dictionary<string, object> { { "ok", ok } };
        if (ok)
        {
            payload["url"] = url;
            payload["via"] = via;
            payload["elapsed"] = elapsed;
        }
        else
        {
            payload["error"] = string.IsNullOrEmpty(error) ? "未嗅探到视频地址" : error;
            payload["candidates"] = candidates != null ? new List<string>(candidates) : new List<string>();
        }
        return JsonSerializer.Serialize(payload);
    }

    private static async Task<Dictionary<string, object>> HostFetch(JsonElement opts, bool image)
        {
            if (opts.ValueKind != JsonValueKind.Object) throw RuleProcess.Error("RULE_REQUEST", "network options must be an object");
            int timeout = 15000;
            if (opts.TryGetProperty("timeout", out var budget) &&
                (budget.ValueKind != JsonValueKind.Number || !budget.TryGetInt32(out timeout) || timeout < 1 || timeout > 120000))
                throw RuleProcess.Error("RULE_REQUEST", "timeout must be 1..120000ms");
            string taskId = null;
            if (opts.TryGetProperty("taskId", out var id))
            {
                if (id.ValueKind != JsonValueKind.String) throw RuleProcess.Error("RULE_REQUEST", "taskId must be a string");
                taskId = id.GetString();
            }
            using var scope = HostTaskScope.Open(taskId, timeout);
            string url = null, contentType = null;
            int? status = null;
            try
            {
                scope.Token.ThrowIfCancellationRequested();
                url = NetworkString(opts, "url");
                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                    (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                    throw RuleProcess.Error("NET", "Only http/https URLs are supported");
                if (image)
                {
                    var hit = CoverCacheTryRead(url);
                    if (hit != null)
                    {
                        scope.Token.ThrowIfCancellationRequested();
                        return new Dictionary<string, object> { { "dataUrl", hit } };
                    }
                }
                var headers = NetworkHeaders(opts);
                string method = image ? "GET" : NetworkString(opts, "method") ?? "GET";
                string body = !image && opts.TryGetProperty("body", out var bodyValue) && bodyValue.ValueKind != JsonValueKind.Null
                    ? (bodyValue.ValueKind == JsonValueKind.String ? bodyValue.GetString() : bodyValue.GetRawText()) : null;
                bool lenient = false;
                if (opts.TryGetProperty("lenientDecode", out var decode))
                {
                    if (decode.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        throw RuleProcess.Error("RULE_REQUEST", "lenientDecode must be a boolean");
                    lenient = decode.GetBoolean();
                }
                System.Net.Http.HttpRequestMessage NewRequest()
                {
                    var request = new System.Net.Http.HttpRequestMessage(new System.Net.Http.HttpMethod(method.ToUpperInvariant()), uri);
                if (body != null && !string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
                {
                    headers.TryGetValue("Content-Type", out var requestType);
                    request.Content = NetworkEncoding.CreateContent(body, requestType, NetworkString(opts, "requestCharset"));
                }
                request.Headers.TryAddWithoutValidation("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
                request.Headers.TryAddWithoutValidation("Accept", image ? "image/avif,image/webp,image/png,image/*,*/*;q=0.8" :
                    "text/html,application/xhtml+xml,application/json,text/plain,*/*");
                if (!image) request.Headers.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
                var referer = NetworkString(opts, "referer");
                if (!string.IsNullOrEmpty(referer)) request.Headers.TryAddWithoutValidation("Referer", referer);
                foreach (var header in headers)
                {
                    if (string.IsNullOrEmpty(header.Value)) continue;
                    if (header.Key.StartsWith("Content-", StringComparison.OrdinalIgnoreCase) ||
                        header.Key.Equals("Allow", StringComparison.OrdinalIgnoreCase) ||
                        header.Key.Equals("Expires", StringComparison.OrdinalIgnoreCase) ||
                        header.Key.Equals("Last-Modified", StringComparison.OrdinalIgnoreCase))
                    {
                        // Content-Type already agrees with CreateContent's actual request bytes.
                        if (request.Content != null && !header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
                        {
                            request.Content.Headers.Remove(header.Key);
                            request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
                        }
                    }
                    else
                    {
                        request.Headers.Remove(header.Key);
                        request.Headers.TryAddWithoutValidation(header.Key, header.Value);
                    }
                }
                    return request;
            }

            System.Net.Http.HttpResponseMessage response = null;
            // 图床/站点偶尔会随机重置 TLS 握手（curl、node、.NET 都会），重试几轮就能过。
            for (int attempt = 0; response == null; attempt++)
            {
                try
                {
                    using var attemptRequest = NewRequest();
                    response = await NetworkHttp.SendAsync(attemptRequest, System.Net.Http.HttpCompletionOption.ResponseHeadersRead,
                        scope.Token).ConfigureAwait(false);
                }
                catch (Exception ex) when (attempt < 3 && IsTransientNet(ex) && !scope.Token.IsCancellationRequested)
                {
                    await Task.Delay(300 * (attempt + 1), scope.Token).ConfigureAwait(false);
                }
            }
            using var _resp = response;
            status = (int)response.StatusCode;
            url = response.RequestMessage?.RequestUri?.ToString() ?? url;
            contentType = response.Content.Headers.TryGetValues("Content-Type", out var types) ? string.Join(" ", types) : "";
            scope.Token.ThrowIfCancellationRequested();
            if (status >= 400) throw RuleProcess.Error("HTTP", "HTTP " + status + ": " + url);
            var bytes = await ReadNetworkBody(response.Content, scope.Token).ConfigureAwait(false);
            scope.Token.ThrowIfCancellationRequested();
            if (image)
            {
                var type = contentType.Split(';')[0].Trim();
                if (!type.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) type = "image/jpeg";
                CoverCacheWrite(url, type, bytes);
                var result = new Dictionary<string, object> { { "dataUrl", "data:" + type + ";base64," + Convert.ToBase64String(bytes) } };
                scope.Token.ThrowIfCancellationRequested();
                return result;
            }
            var decoded = NetworkEncoding.Decode(bytes, contentType, NetworkString(opts, "charset"), lenient);
            scope.Token.ThrowIfCancellationRequested();
            Log("fetchText " + status + " " + url + " (" + decoded.text.Length + " chars, cs=" + decoded.charset + ")");
            return new Dictionary<string, object> {
                { "ok", response.IsSuccessStatusCode }, { "status", status.Value }, { "url", url },
                { "charset", decoded.charset }, { "contentType", contentType }, { "text", decoded.text }
            };
        }
        catch (Exception error)
        {
            // HttpClient/streams can throw IOException as well as OCE on cancellation.
            if (scope.Token.IsCancellationRequested)
            {
                error = new Exception(scope.Cancelled ? "CANCELLED: network task cancelled" : "TIMEOUT: network deadline exceeded", error);
                error.Data["code"] = scope.Cancelled ? "CANCELLED" : "TIMEOUT";
                error.Data[scope.Cancelled ? "cancelled" : "timeout"] = true;
            }
            else if (!error.Data.Contains("code")) error.Data["code"] = "NET";
            if (url != null) error.Data["url"] = url;
            if (status.HasValue) error.Data["http"] = status.Value;
            if (contentType != null) error.Data["contentType"] = contentType;
            if (taskId != null) error.Data["taskId"] = taskId;
            throw error;
        }
    }

    private static async Task<byte[]> ReadNetworkBody(System.Net.Http.HttpContent content, System.Threading.CancellationToken token)
    {
        if (content.Headers.ContentLength is long length && length > NetworkMaxBytes)
            throw RuleProcess.Error("NET", "Response exceeds 8MiB limit");
        using var stream = await content.ReadAsStreamAsync(token).ConfigureAwait(false);
        using var output = new MemoryStream();
        var buffer = new byte[64 * 1024];
        while (true)
        {
            token.ThrowIfCancellationRequested();
            int count = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, NetworkMaxBytes - output.Length + 1)), token)
                .ConfigureAwait(false);
            if (count == 0) break;
            if (output.Length + count > NetworkMaxBytes) throw RuleProcess.Error("NET", "Response exceeds 8MiB limit");
            output.Write(buffer, 0, count);
        }
        token.ThrowIfCancellationRequested();
        return output.ToArray();
    }

    /* ================================================================
     * __cmd：外部驱动端口（用 CDP / hash 传入）
     * ================================================================ */
    private static async Task<Dictionary<string, object>> HandleCmd(JsonElement cmd)
    {
        string op = null;
        if (cmd.ValueKind == JsonValueKind.Object && cmd.TryGetProperty("op", out var o))
            op = o.GetString();
        Log("cmd: " + (cmd.GetRawText().Length < 200 ? cmd.GetRawText() : cmd.GetRawText().Substring(0, 200)));
        switch (op)
        {
            case "eval":
                {
                    var code = cmd.GetProperty("code").GetString();
                    try
                    {
                        // ExecuteScriptAsync 不等 Promise：包一层等 promise 落定（15s 超时）
                        var wrapped = "(function(){ return new Promise(function(res){" +
                                      "var t=setTimeout(function(){res('<<eval-timeout>>');},15000);" +
                                      "try{ Promise.resolve((function(){" + code + "\n})()).then(function(v){ clearTimeout(t); res(v); }, function(e){ clearTimeout(t); res('<<eval-rejected>>:'+((e&&e.message)||e)); }); }" +
                                      "catch(e){ clearTimeout(t); res('<<eval-threw>>:'+((e&&e.message)||e)); } }); })()";
                        var r = await _core.ExecuteScriptAsync(wrapped);
                        return new Dictionary<string, object> { { "op", "eval" }, { "ok", true }, { "result", r } };
                    }
                    catch (Exception ex)
                    {
                        return new Dictionary<string, object> { { "op", "eval" }, { "ok", false }, { "error", ex.Message } };
                    }
                }
            case "setMockBook":
                _mockBookPath = cmd.GetProperty("path").GetString();
                return new Dictionary<string, object> { { "op", "setMockBook" }, { "ok", true }, { "path", _mockBookPath } };
            case "setMockSource":
                _mockSourcePath = cmd.GetProperty("path").GetString();
                return new Dictionary<string, object> { { "op", "setMockSource" }, { "ok", true }, { "path", _mockSourcePath } };
            case "screenshot":
                {
                    try
                    {
                        var path = cmd.GetProperty("path").GetString();
                        await CaptureToAsync(path);
                        return new Dictionary<string, object> { { "op", "screenshot" }, { "ok", true }, { "path", path } };
                    }
                    catch (Exception ex)
                    {
                        return new Dictionary<string, object> { { "op", "screenshot" }, { "ok", false }, { "error", ex.Message } };
                    }
                }
            case "hostSnapshot":
                {
                    var obj = new Dictionary<string, object> { { "op", "hostSnapshot" }, { "ok", true } };
                    lock (Lock)
                    {
                        obj["console"] = ConsoleMsgs.ToArray();
                        obj["requests"] = ReqLog.ToArray();
                        obj["hostLog"] = HostLog.ToArray();
                    }
                    return obj;
                }
                case "ping":
                case "finalize":
                    if (op == "finalize")
                    {
                        await FinalizeAsync("cmd-finalize");
                        try { _form.BeginInvoke(new Action(() => { try { _form.Close(); } catch { } })); } catch { }
                    }
                    return new Dictionary<string, object> { { "op", op }, { "ok", true }, { "href", _core.Source } };
            default:
                return new Dictionary<string, object> { { "op", op }, { "ok", false }, { "error", "unknown op" } };
        }
    }

    private static async Task CaptureToAsync(string path)
    {
        // CoreWebView2 1.0.2592 has CapturePreview (with output stream). We use CDP-free path:
        // 简化：截图走 ExecuteScriptAsync html2canvas 不可靠；直接用 WebView2 PrintToPdf 也行，
        // 但最稳的截图是 CoreWebView2.CapturePreview（PNG）—— 1.0.2210+ 可用。
        try
        {
            using (var ms = new MemoryStream())
            {
                await _core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                File.WriteAllBytes(path, ms.ToArray());
            }
            Log("screenshot -> " + path);
        }
        catch (Exception ex)
        {
            Log("screenshot err: " + ex.Message);
            throw;
        }
    }

    /* ================================================================
     * 收尾
     * ================================================================ */
    private static async Task FinalizeAsync(string reason)
    {
        if (_finalized) return;
        _finalized = true;
        WriteResult(reason);
    }

    private static void WriteResult(string reason)
    {
        try
        {
            var obj = new Dictionary<string, object> {
                { "reason", reason },
                { "elapsedMs", Sw.ElapsedMilliseconds },
                { "lastSnapshot", _lastSnapshot },
                { "snapshots", Snapshots.ToArray() },
                { "hostLog", HostLog.ToArray() },
                { "console", ConsoleMsgs.ToArray() },
                { "requests", ReqLog.ToArray() }
            };
            File.WriteAllText(_outFile, JsonSerializer.Serialize(obj, new JsonSerializerOptions { WriteIndented = true }),
                new UTF8Encoding(false));
        }
        catch { }
    }
}

/* Slice2 helper：C# string 没有 Slice；这里截前 N 个字符 */
internal static class StrExt
{
    public static string Slice2(this string s, int n) => s == null ? "" : (s.Length <= n ? s : s.Substring(0, n) + "…");
}
