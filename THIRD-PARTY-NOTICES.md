# 第三方组件

本项目代码以 MIT 发布（见 `LICENSE`）。以下组件随仓库或随发布产物分发。

## hls.js 1.7.3 — Apache-2.0

- 文件：`src/Iread.Renderer/js/vendor/hls.min.js`
- 用途：HLS（m3u8）解码与播放
- 全文：`LICENSES/Apache-2.0.txt`
- 上游：<https://github.com/video-dev/hls.js>

该 min 构建的 license banner 已被移除，仓库内已在文件头补回：

```js
/*! hls.js v1.7.3 | Copyright (c) 2017-present Dailymotion | Apache License 2.0
 *  https://github.com/video-dev/hls.js — full text in LICENSES/Apache-2.0.txt */
```

升级 hls.js 时保留该 banner。

## Poppins 500 / 600 — SIL OFL 1.1

- 文件：`src/Iread.Renderer/assets/fonts/poppins-500.woff2`、`poppins-600.woff2`
- 用途：界面数字与拉丁字形
- 全文：`LICENSES/OFL-1.1.txt`
- 上游：<https://github.com/itfoundry/Poppins>

字体未修改，保留原名使用，不得单独售卖。

## Microsoft Edge WebView2 SDK 1.0.2592.51

- 引用：`src/Iread.Desktop/Iread.Desktop.csproj` 的 `PackageReference`
- 运行期依赖 WebView2 Evergreen Runtime：Win11 自带，Win10 由安装包检测并引导安装
- 按 Microsoft redistributable 条款分发，无需额外附文本

## .NET 8 运行时（自包含发布）

- 构建参数 `--self-contained true -r win-x64`，运行时随发布目录分发
- .NET 本体为 MIT；运行时内含第三方组件，全文见 `LICENSES/dotnet-ThirdPartyNotices.txt`

## mpv — GPLv2 or later（独立程序，不随本仓库、不随安装包）

应用不打包 mpv。首次播放 mkv / HEVC 时下载：

```
https://github.com/Silencecavalier/iread-mpv/releases/download/mpv-v0.42.0/mpv-x86_64.zip
备用：https://gh-proxy.com/<同上直链>
```

解压至 `<数据目录>\mpv\`，以 `--wid` 嵌入窗口，经命名管道下发命令。

与本项目为进程级调用关系：不链接、不修改源码，故本项目自身无须 GPL 化。若将该 release 作为公开分发渠道，即构成 GPL 二进制再分发，需在该仓库同时提供：GPL 全文、mpv 版本与构建来源、对应源码获取地址，以及 ffmpeg 等依赖的许可。

上游：<https://mpv.io> / <https://github.com/mpv-player/mpv>

## NSIS 3.x — zlib/libpng（仅构建期）

仅用于打包安装包（`scripts/installer.nsi`），不入仓库、不入产物。

## Legado（阅读 3.0）书源方言 — 仅格式兼容

本项目实现 Legado 书源 JSON 的子集解析，未复制其代码。若日后引入其源码，需按其许可（GPLv3）处理并在此登记。

---

## 发布包附带文件

`scripts/build-desktop.sh` 将以下文件复制进 `dist/publish/`，打包时随 `publish\*` 一并进入安装包：

```
LICENSE
THIRD-PARTY-NOTICES.md
LICENSES/
├─ Apache-2.0.txt
├─ OFL-1.1.txt
└─ dotnet-ThirdPartyNotices.txt
```
