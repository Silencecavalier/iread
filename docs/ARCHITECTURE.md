# 架构

三层结构：宿主进程（C# / WinForms / WebView2）→ 渲染层（网页）→ 规则 worker 进程（同一 exe，以 `--rule-worker` 重启）。

```
┌──────────────────────────────────────────────────────────────┐
│ iread-plugin.exe  (Program.cs / IreadHost.cs)                 │
│                                                              │
│  无边框 WinForms 窗口                                          │
│  └─ WebView2 ── iread://app/index.html ──────────────┐         │
│       │  iread://      → wwwroot 静态文件            │         │
│       │  plugins.local → 插件目录（虚拟主机, DenyCors）│         │
│       │  yedu-net://   → 同步 XHR 代理（java.ajax）  │         │
│       │  window.yedu   → 注入的 postMessage 桥        │         │
│       └──────────────────────────────────────────────┘         │
│                                                              │
│  HostFetch（代发 HTTP：跨域、UA、编码嗅探）                      │
│  mpv 子进程 ── --wid 嵌入面板，网页只绘控制栏                    │
└───────────────┬──────────────────────────────────────────────┘
                │ 命名管道（PipeOptions.CurrentUserOnly）
┌───────────────▼──────────────────────────────────────────────┐
│ 同一 exe --rule-worker <pipe>                                 │
│ 执行书源规则 JS；RuleJobObject 绑定，父进程退出即终止            │
└──────────────────────────────────────────────────────────────┘
```

## 启动

`Program.cs:109` `Main` 解析 `--rule-worker`：带该参数进 worker 分支，否则创建窗口并 `Application.Run`（`:144`）。窗口 `FormBorderStyle=None`，标题栏自绘。

## 自定义 scheme

| scheme | 用途 |
| --- | --- |
| `iread://` | 从 `wwwroot` 读取静态文件，入口 `iread://app/index.html` |
| `yedu-net://` | `legacy-js.js` 的同步 XHR 代理，承载 Legado `java.ajax` |
| `plugins.local` | `SetVirtualHostNameToFolderMapping(..., DenyCors)`，映射用户插件目录 |

`yedu-net://` 请求格式：

```
yedu-net://net/?u=<urlenc>&m=<method>&body=<...>&cs=<charset>&h=<...>
```

## JS 桥

`AddScriptToExecuteOnDocumentCreated` 注入 shim，须在导航前完成，否则首个文档无 `window.yedu`。

```js
chrome.webview.postMessage({ __yedu: 1, id, method, args });
```

宿主 `WebMessageReceived` 分发，`PostWebMessageAsJson` 回包；宿主就绪后向页面派发 `yedu-host-ready`。

渲染层全局挂载：`NR.store / NR.plugins / NR.video / NR.mpv / NR.legado / NR.cover / NR.hotrank / NR.bookstore / NR.dataTools / NR.state() / NR.switchView() / NR.androidBack()`。

## 网络

- **HostFetch**：第三方请求统一由宿主代发，以便设置任意 `User-Agent` / `Referer`、跟随重定向、按 `NetworkEncoding.cs` 嗅探 GBK 等非 UTF-8 响应。
- WebView2 自身网络栈只承担静态资源与图片（CSP 放开 `img-src` / `media-src` 的 http/https）。
- 超时、响应体积、重定向次数均有硬上限，越界报 `NET_TIMEOUT` / `NET_TOO_LARGE`。

## 规则执行

`RuleProcess.cs` 以同一 exe 拉起子进程：

```csharp
start.ArgumentList.Add("--rule-worker");
start.ArgumentList.Add(name);   // NamedPipeServerStream, PipeOptions.CurrentUserOnly
```

- 独立进程隔离任意 JS 执行，单条规则可超时、可整体终止，不影响主界面。
- `RuleJobObject` 将子进程加入 Job Object，父进程异常退出时不残留。
- 每个 worker 使用独立 profile 目录，避免并发读写同一状态。
- worker 仅回传摘要；完整 `cause / textLen / traces` 经页面内执行通道获取。

## 视频

| 格式 | 通路 |
| --- | --- |
| mp4 / m3u8（H.264） | 原生 `<video>` + `js/vendor/hls.min.js`（1.7.3） |
| mkv / HEVC / AVI / TS | 宿主拉起 mpv，`--wid` 嵌入面板 |

mpv 面板布局：窗口内铺一块面板供 mpv 绘制，下方保留 WebView2 条带绘制控制栏；`NR.mpv.layout(h)` 调整高度，`0` 表示 WebView2 全隐。播放控制经命名管道下发命令。mpv 首次使用时下载，见 `THIRD-PARTY-NOTICES.md`。

`js/adskip.js` 在播放列表层面识别并重写广告段，不依赖 DOM。

## 存储

`js/store.js`：IndexedDB 为主，localStorage 为镜像与降级。

- `nr_` 前缀为业务数据命名空间，其它模块写入 localStorage 须避开。
- 坏数据不抛错，隔离至 `__nr_quarantine_<key>`；初始化按 `openBackend → 修复重试 → 降级 ls` 三级执行。

## 数据目录

```
%LOCALAPPDATA%\iread-plugin-data\
├─ EBWebView\     WebView2 userData（IndexedDB / localStorage）
├─ plugins\<id>\  用户插件
├─ covers\        封面缓存
├─ mpv\           mpv 可执行文件（首次播放时下载）
└─ backups\       导出备份
```

`AppDataLocation.cs` 负责首启迁移旧版 `iread-webview2` 或安装目录内的 `EBWebView`，失败时回滚并保留原数据。

## 调试

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9336 ./iread-plugin.exe
node tools/cdp-eval.js 9336 expr.js
```

`location.reload()` 会使 CDP execution context 作废（`Execution context was destroyed`），刷新后需重新获取 target。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `Program.cs` | 入口、worker 分支、窗口外壳、菜单 |
| `IreadHost.cs` | WebView2 初始化、scheme 拦截、JS 桥、HostFetch、mpv 面板、IPC 分发 |
| `RuleProcess.cs` | 拉起 worker、管道握手、超时与取消 |
| `RuleWorkerHost.cs` | worker 侧：接收任务、执行规则、回传结果 |
| `RuleJobObject.cs` | Job Object 绑定，防止子进程残留 |
| `NetworkEncoding.cs` | 响应编码嗅探（GBK / GB18030 / Big5 等） |
| `AppDataLocation.cs` | 数据目录解析、旧数据迁移、恢复备份 |
| `HostTaskScope.cs` | 宿主侧任务生命周期与取消 |
