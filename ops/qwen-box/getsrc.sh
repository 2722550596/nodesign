#!/usr/bin/env bash
set -e
cd "$HOME/qwen38"
rm -rf llama.cpp
# ⛔ 不用 --depth 1：浅克隆的 git pull 会永远报 up-to-date，实际落后几百提交
git clone https://github.com/ggml-org/llama.cpp
echo "CLONE_DONE $(cd llama.cpp && git log --oneline -1)"
