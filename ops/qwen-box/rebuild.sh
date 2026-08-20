#!/usr/bin/env bash
# 一条龙：clone → build → 起服务。⛔ 教训：绝不并行跑两个克隆到会互相 rm 的路径，
# git clone 失败时会自己删掉目标目录，赢家的编译产物一起陪葬。
set -e
cd "$HOME/qwen38"
rm -rf llama.cpp
git clone --depth 1 https://github.com/ggml-org/llama.cpp
echo "CLONE_DONE"
bash "$HOME/qwen38/build.sh"
# 编好立刻备份二进制，下次目录出事不用再等 15 分钟
mkdir -p "$HOME/qwen38/binbak"
cp llama.cpp/build/bin/llama-server llama.cpp/build/bin/llama-cli "$HOME/qwen38/binbak/" 2>/dev/null || true
cp -r llama.cpp/build/bin/*.so "$HOME/qwen38/binbak/" 2>/dev/null || true
echo "REBUILD_DONE"
setsid nohup bash "$HOME/qwen38/serve.sh" > "$HOME/qwen38/logs/server.log" 2>&1 < /dev/null &
