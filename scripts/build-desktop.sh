#!/usr/bin/env bash
# 桌面版构建：dotnet publish（自包含单文件）→ 可选 NSIS 安装包
#
# 用法：
#   bash scripts/build-desktop.sh              # 只出 dist/publish
#   bash scripts/build-desktop.sh --installer  # 再打 dist/iread-setup.exe
#
# 环境变量：
#   DOTNET   dotnet 可执行文件（默认 PATH）
#   NSIS     makensis 可执行文件（默认 PATH）
#   VERSION  覆盖版本号（默认读 csproj 的 InformationalVersion）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOTNET="${DOTNET:-dotnet}"
PROJ="$ROOT/src/Iread.Desktop/Iread.Desktop.csproj"
RENDERER="$ROOT/src/Iread.Renderer"
DIST="$ROOT/dist"
WITH_INSTALLER=0
for a in "$@"; do
  case "$a" in
    --installer) WITH_INSTALLER=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

VERSION="${VERSION:-$(grep -oP '(?<=<InformationalVersion>)[^<]+' "$PROJ" | head -1)}"
[ -n "$VERSION" ] || VERSION="0.0.0"

echo "ROOT=$ROOT"
echo "VERSION=$VERSION"

command -v "$DOTNET" >/dev/null 2>&1 || [ -x "$DOTNET" ] || { echo "FAIL: 找不到 dotnet（设 DOTNET=/path/to/dotnet）"; exit 1; }

# ── [1/4] 渲染层自检 ──────────────────────────────────────────
echo "=== [1/4] 渲染层自检 ==="
for f in index.html js/app.js js/online.js js/plugins.js js/store.js css/base.css css/online.css; do
  [ -f "$RENDERER/$f" ] || { echo "FAIL: 缺 $f"; exit 1; }
done
for f in js/app.js js/online.js js/plugins.js; do
  sz=$(wc -c < "$RENDERER/$f")
  [ "$sz" -gt 20000 ] || { echo "FAIL: $f 只有 $sz 字节，疑似被截断"; exit 1; }
done
grep -q "__ireadVersion" "$RENDERER/js/app.js" || { echo "FAIL: app.js 缺版本注入点"; exit 1; }
echo "RENDERER_OK files=$(find "$RENDERER" -type f | wc -l)"

# ── [2/4] publish ────────────────────────────────────────────
echo "=== [2/4] dotnet publish (win-x64, self-contained) ==="
rm -rf "$DIST/publish"
mkdir -p "$DIST"
"$DOTNET" publish "$PROJ" -c Release -r win-x64 --self-contained true \
  -p:InformationalVersion="$VERSION" -o "$DIST/publish" --nologo
[ -f "$DIST/publish/iread-plugin.exe" ] || { echo "FAIL: 没产出 iread-plugin.exe"; exit 1; }

# ── [3/4] 校验 + 剔除插件 + 附带许可 ─────────────────────────
echo "=== [3/4] 产物整理 ==="
[ -d "$DIST/publish/wwwroot" ] || { echo "FAIL: publish 里没有 wwwroot"; exit 1; }
# 不夹带插件：插件由使用者自行导入，仓库与安装包均不含实现
rm -rf "$DIST/publish/wwwroot/plugins"
for f in index.html js/app.js css/base.css; do
  a=$(md5sum "$RENDERER/$f" | cut -d' ' -f1)
  b=$(md5sum "$DIST/publish/wwwroot/$f" | cut -d' ' -f1)
  [ "$a" = "$b" ] || { echo "FAIL: $f 不一致（$a vs $b）"; exit 1; }
done
cp -r "$ROOT/LICENSES" "$DIST/publish/" 2>/dev/null || true
cp "$ROOT/THIRD-PARTY-NOTICES.md" "$ROOT/LICENSE" "$DIST/publish/" 2>/dev/null || true
echo "WWWROOT_OK files=$(find "$DIST/publish/wwwroot" -type f | wc -l)"

# ── [4/4] 安装包（可选） ─────────────────────────────────────
if [ "$WITH_INSTALLER" = "1" ]; then
  echo "=== [4/4] NSIS ==="
  NSIS="${NSIS:-makensis}"
  command -v "$NSIS" >/dev/null 2>&1 || [ -x "$NSIS" ] || { echo "FAIL: 找不到 makensis（设 NSIS=/path/to/makensis）"; exit 1; }
  cd "$ROOT"
  # makensis 解析相对路径时以脚本目录为基准，这里统一传绝对路径
  to_win() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }
  PUB_WIN="$(to_win "$DIST/publish")"
  OUT_WIN="$(to_win "$DIST/iread-setup.exe")"
  # NSIS 3 读取含中文的脚本要求 UTF-8 BOM；仓库里的文件保持无 BOM，构建时生成临时副本
  NSI_TMP="$ROOT/scripts/.installer.build.nsi"
  { printf '\xef\xbb\xbf'; sed '1s/^\xEF\xBB\xBF//' "$ROOT/scripts/installer.nsi"; } > "$NSI_TMP"
  trap 'rm -f "$NSI_TMP"' EXIT
  MSYS_NO_PATHCONV=1 "$NSIS" /V2 \
    /DAPPVERSION="$VERSION" \
    "/DPUBDIR=$PUB_WIN" \
    "/DOUTFILE=$OUT_WIN" \
    "$(to_win "$NSI_TMP")" | tail -6
else
  echo "=== [4/4] 跳过安装包（加 --installer 才打） ==="
fi

echo
echo "产物："
ls -la "$DIST/publish/iread-plugin.exe" 2>/dev/null || true
ls -la "$DIST"/*.exe 2>/dev/null || true
