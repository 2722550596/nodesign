#!/usr/bin/env bash
set -e
cd "$HOME/qwen38"
rm -rf llama.cpp.fast
# 浅克隆：这台是一次性租用机，不存在"日后 git pull 骗人"的复用场景，
# 拿今天的 master 正是我们要的（DeltaNet CUDA 乱码 bug 需要新构建）。
git clone --depth 1 https://github.com/ggml-org/llama.cpp llama.cpp.fast
rm -rf llama.cpp
mv llama.cpp.fast llama.cpp
echo "CLONE_DONE $(cd llama.cpp && git log --oneline -1)"
