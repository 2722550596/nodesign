#!/usr/bin/env bash
#
# install-macos-fonts.sh — 把上传到 server 的 macOS 字体装到 Linux 系统
# + 应用 fontconfig 让 generic family 命中苹果字体。
#
# 前提：先从 Mac 拷字体到 server 的 ~/macos-fonts/ 目录。最少需要：
#   PingFang.ttc       — /System/Library/Fonts/PingFang.ttc
#   Songti.ttc         — /System/Library/Fonts/Songti.ttc
# 推荐补：
#   STHeiti Light.ttc  — /System/Library/Fonts/STHeiti Light.ttc
#   STHeiti Medium.ttc — /System/Library/Fonts/STHeiti Medium.ttc
#   Helvetica.ttc      — /System/Library/Fonts/Helvetica.ttc
#   SF-Pro.ttf         — Apple 官网下载（developer.apple.com/fonts/）
#   SF-Pro-Display.ttf — 同上
#   SF-Pro-Text.ttf    — 同上
#   SF-Mono.ttf        — 同上
#
# 从 Mac 拷的命令示例（在 Mac 上跑）：
#   scp /System/Library/Fonts/PingFang.ttc \
#       /System/Library/Fonts/Songti.ttc \
#       "/System/Library/Fonts/STHeiti Light.ttc" \
#       "/System/Library/Fonts/STHeiti Medium.ttc" \
#       /System/Library/Fonts/Helvetica.ttc \
#       user@server:~/macos-fonts/
#
# 在 server 上跑：
#   sudo bash server/ops/install-macos-fonts.sh
#
# ⚠️ 法律：苹果字体仅限内部使用，禁止打包外传。这份 script 只装到 server 端
# 系统字体目录，让 PDF/PPT 渲染时本地使用，不会嵌入 baked HTML 外传。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FONT_SRC_DIR="${MACOS_FONT_SRC:-$HOME/macos-fonts}"
FONT_DST_DIR="/usr/share/fonts/macos"
FONTCONFIG_DST="/etc/fonts/conf.d/99-macos.conf"

# ── 0. 必须 root 跑 ──
if [ "$EUID" -ne 0 ]; then
  echo "❌ 必须 sudo / root 跑（要写 /usr/share/fonts 和 /etc/fonts/conf.d）"
  echo "   sudo bash $0"
  exit 1
fi

# ── 1. 检查源目录 ──
if [ ! -d "$FONT_SRC_DIR" ]; then
  echo "❌ 找不到字体源目录：$FONT_SRC_DIR"
  echo "   先从 Mac scp 字体过来，参考脚本头注释。"
  echo "   或设 MACOS_FONT_SRC=/path/to/dir 环境变量再跑。"
  exit 1
fi

shopt -s nullglob
fonts=("$FONT_SRC_DIR"/*.ttc "$FONT_SRC_DIR"/*.ttf "$FONT_SRC_DIR"/*.otf)
if [ ${#fonts[@]} -eq 0 ]; then
  echo "❌ $FONT_SRC_DIR 里没找到 .ttc / .ttf / .otf 文件"
  exit 1
fi

echo "📦 找到 ${#fonts[@]} 个字体文件："
for f in "${fonts[@]}"; do echo "   - $(basename "$f")"; done
echo

# ── 2. 装到系统字体目录 ──
echo "📥 拷贝到 $FONT_DST_DIR/"
mkdir -p "$FONT_DST_DIR"
cp -v "${fonts[@]}" "$FONT_DST_DIR/"

# 权限：所有用户可读
chmod 644 "$FONT_DST_DIR"/*

# ── 3. 应用 fontconfig ──
echo
echo "⚙️  应用 fontconfig：$FONTCONFIG_DST"
cp -v "$SCRIPT_DIR/macos-fonts.conf" "$FONTCONFIG_DST"
chmod 644 "$FONTCONFIG_DST"

# ── 4. 刷字体缓存 ──
echo
echo "🔄 刷新 fontconfig 缓存（fc-cache -fv）"
fc-cache -fv 2>&1 | tail -10

# ── 5. 验证 ──
echo
echo "✅ 装完了。验证 generic family 是否命中苹果字体："
echo
echo "── fc-match serif（应该是 Songti SC 或 STSong 在前）──"
fc-match -s serif | head -3
echo
echo "── fc-match sans-serif（应该是 PingFang SC 在前）──"
fc-match -s sans-serif | head -3
echo
echo "── fc-match \"PingFang SC\"（应该返回 PingFang.ttc）──"
fc-match "PingFang SC"
echo
echo "── fc-match \"Songti SC\"（应该返回 Songti.ttc）──"
fc-match "Songti SC"
echo
echo "── fc-match \"system-ui\"（应该是 SF Pro Text 或 PingFang SC）──"
fc-match -s system-ui | head -3

echo
echo "🎯 下一步：重启 NoDesign server 让 Chromium 重新读 fontconfig"
echo "   pm2 restart nodesign"
echo
echo "   重启后导一份新中文 deck 的 PDF/PPT，跟 Mac preview 对比应该 1:1。"
