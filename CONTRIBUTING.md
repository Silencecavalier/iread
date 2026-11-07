# 开发与贡献

## 环境

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 x64 |
| 编译 | .NET 8 SDK |
| 运行 | WebView2 Evergreen Runtime（Win11 自带） |
| 安装包 | NSIS 3.x（可选） |

```bash
git clone https://github.com/Silencecavalier/iread.git
cd iread
bash scripts/build-desktop.sh                 # → dist/publish
bash scripts/build-desktop.sh --installer     # 追加 dist/iread-setup.exe
```

`DOTNET=` / `NSIS=` / `VERSION=` 覆盖默认路径与版本号，便携 SDK 同样适用：

```bash
DOTNET=/d/sdk/dotnet.exe bash scripts/build-desktop.sh
```

## 两类改动

**渲染层（`src/Iread.Renderer/`）** 为静态文件，无构建步骤。覆盖到程序目录后重启即可：

```bash
cp -r src/Iread.Renderer/* dist/publish/wwwroot/
```

**C# 宿主（`src/Iread.Desktop/`）** 必须重新 publish。`dotnet build` 的产物找不到 `wwwroot`，不可直接运行。

## 约定

- C# 文件不声明 `namespace`，根命名空间由 csproj 的 `RootNamespace` 决定。添加 namespace 会使 `RuleWorkerHost.cs` 的反射入口失效。
- 渲染层保持原生 ES5 风格 JS：不引入打包器、TypeScript 或框架。
- 新增 localStorage 键避开 `nr_` 前缀。该前缀归 `js/store.js`，撞键会导致存储初始化失败并锁死读写。
- 书源规则运行在独立 worker 进程，不在页面主线程。获取完整错误对象需走页面内调试通道，见 `docs/ARCHITECTURE.md`。
- 不提交 `bin/ obj/ dist/ publish/ *.exe *.apk *.keystore`，`.gitignore` 已覆盖。

## 验证

无自动化测试套件，依赖以下三条路径。

1. **构建自检**：`build-desktop.sh` 的 [1/4] 校验关键文件缺失或截断、版本注入点存在；[3/4] 比对 `wwwroot` 与仓库渲染层是否一致。
2. **CDP 求值**：带调试端口启动，对页面发 `Runtime.evaluate`，直接断言 `NR.*` 的返回：

   ```bash
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9336 ./iread-plugin.exe
   node tools/cdp-eval.js 9336 expr.js
   ```

3. **手动走查**：插件交互、视频播放、mpv 面板无法由求值覆盖，改动后需人工过一遍。

> `location.reload()` 会使 CDP 的 execution context 作废（`Execution context was destroyed`），刷新后需重新获取 target。

## 提交

- 一个 PR 对应一件事；渲染层与 C# 改动尽量分开提交，便于定位回归。
- commit message 说明「改了什么」与「为什么」。
- 界面改动在 PR 描述中附截图，不入库。
- 版本号分布于 4 处，需同步修改：`Iread.Desktop.csproj` 的 `Version` 与 `InformationalVersion`、`js/app.js` 顶部的 `global.__ireadVersion`、`scripts/installer.nsi` 的 `APPVERSION` 默认值（构建时由 `/D` 覆盖）。

## 不接受

- 提交书源清单、站点账号、Cookie，或抓取所得的书籍 / 漫画 / 影视文件。仓库只存代码。
- 为「抓得到」而绕过付费墙、登录校验或验证码。
- 提交 mpv / ffmpeg 二进制。二者由运行时下载，见 `THIRD-PARTY-NOTICES.md`。
- 提交插件实现。插件由使用者自行分发与安装。

## 许可

提交即视为同意以 MIT 授权（见 `LICENSE`）。新增第三方代码或资源时，同步在 `THIRD-PARTY-NOTICES.md` 登记许可与出处。
