#!/usr/bin/env bash
# clone 一落地就自动接编译，省得人工盯着（GPU 按秒计费，串行等待就是烧钱）
for i in $(seq 1 240); do
  grep -q CLONE_DONE "$HOME/qwen38/logs/clone.log" 2>/dev/null && break
  sleep 10
done
grep -q CLONE_DONE "$HOME/qwen38/logs/clone.log" || { echo "CHAIN_ABORT: clone 超时"; exit 1; }
bash "$HOME/qwen38/build.sh"
