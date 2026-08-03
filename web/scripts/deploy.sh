#!/usr/bin/env bash
# 构建 + 无缝换入口（2026-08-03）
#
# 为什么不能直接 `npm run build`：
#   nginx 直接托管 web/dist，而 vite build 的第一件事是**清空 dist**。于是每次
#   构建都有几秒钟站点是半残的（index.html 没了、分片没了），任何人这时候刷新
#   都会白屏或报错。
#
#   更麻烦的是第二件事：分片名带内容指纹，清空等于**删掉上一版的分片**。已经开着
#   页面的人手里那份 index.js 记的是旧分片名，等他点进站点窗口触发懒加载
#   （DeckWindow / SiteWindow），那个文件已经不存在了 —— 报
#   "Failed to fetch dynamically imported module"，而且浏览器会记住这次失败不再重试。
#
# 做法：构建到旁边的 dist-build，然后
#   1. 新分片**加**进 dist/assets，旧的一个不删 —— 老页面继续能取到自己的分片
#   2. index.html 最后换，且用同分区 mv（原子替换，没有"文件写了一半"的瞬间）
#   3. 顺手清掉 KEEP_DAYS 天没被任何一次部署碰过的分片
#
# 前端还有第二道保险：main.jsx 里监听分片加载失败 → 自动刷一次（只刷一次）。
set -euo pipefail

cd "$(dirname "$0")/.."          # web/
KEEP_DAYS="${KEEP_DAYS:-7}"
BUILD_DIR="dist-build"
LIVE_DIR="dist"

echo "==> 构建到 $BUILD_DIR"
npx vite build --outDir "$BUILD_DIR" --emptyOutDir

if [ ! -f "$BUILD_DIR/index.html" ]; then
  echo "!! 构建没产出 index.html，中止（线上保持原样）" >&2
  exit 1
fi

mkdir -p "$LIVE_DIR/assets"

echo "==> 新分片加进 $LIVE_DIR/assets（旧的保留）"
cp -a "$BUILD_DIR/assets/." "$LIVE_DIR/assets/"

# assets 和 index.html 之外的静态文件（favicon、robots 之类）直接覆盖
find "$BUILD_DIR" -maxdepth 1 -mindepth 1 ! -name assets ! -name index.html \
  -exec cp -a {} "$LIVE_DIR/" \;

echo "==> 换入口（同分区 mv，原子）"
cp "$BUILD_DIR/index.html" "$LIVE_DIR/.index.html.new"
mv -f "$LIVE_DIR/.index.html.new" "$LIVE_DIR/index.html"

echo "==> 清理 ${KEEP_DAYS} 天没被碰过的旧分片"
# 每次部署 cp -a 会把仍在用的分片 mtime 刷新到本次构建时间，所以"老"= 真的没人引用了
PRUNED=$(find "$LIVE_DIR/assets" -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)

echo "==> 完成：分片 $(find "$LIVE_DIR/assets" -type f | wc -l) 个，清理 $PRUNED 个"
