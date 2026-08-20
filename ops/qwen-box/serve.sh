#!/usr/bin/env bash
# llama-server：Anthropic 原生端点（/v1/messages）给 Nodesign 用。
# PRO 6000 Blackwell 96G / Q8_K_P 29.3GiB / 视觉 mmproj。
#
#   ⚠️ **每个 slot 的上下文**必须与 Nodesign model-context.js 里 qwen3.8-27b 的
#      window 一致（262144），低了会在 SDK 触发 auto-compact 之前先撞上游 400。
#      多 slot 时 -c 是总量，每路拿到 -c / -np —— 所以 3 路要写 786432。
#      **启动日志的 `n_ctx_slot` 是唯一真相**，改完看那一行确认，别信这段注释。
#
#   --jinja 是工具调用的前提（llama.cpp 官方明写）。
#
# 2026-08-19 三处调整：
#   -np 3      并发。原来是 1，站主和后台任务共抢一个 slot，谁先到谁占着，
#              另一边完全排队 —— 实测 65k token 的 agent 请求一发要 200 秒以上。
#   -cram -1   prompt cache 不限。默认 8192 MiB，而 agent 长对话单个 prompt state
#              就 2.5-8.2GB，日志里在反复驱逐、还有直接 skip 的 —— 意味着那 25 秒
#              的 prefill 每轮重来一遍。这块住系统内存（117G 总/101G 可用），不占显存。
#   --spec-draft-n-max 16 / --spec-draft-p-min 0.8
#              投机解码调参。p-min 默认是 0.00（关闭）。社区在 RTX 5090 + Qwen3.6-27B
#              上实测 112 → 178 t/s。⚠️ 那是结构化任务；本机实测散文接受率只有 0.35，
#              提升多少没测干净（对照被真实流量污染了），有空要补一次干净的。
export LD_LIBRARY_PATH=$HOME/qwen38/cudaenv/targets/x86_64-linux/lib:$HOME/qwen38/cudaenv/lib:${LD_LIBRARY_PATH:-}
M=$HOME/qwen38/models
exec $HOME/qwen38/llama.cpp/build/bin/llama-server \
  -m $M/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf \
  --mmproj $M/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf \
  -ngl 99 \
  -c 786432 \
  -np 3 \
  -cram -1 \
  -fa on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --cache-reuse 256 \
  -b 4096 -ub 2048 \
  --spec-type draft-mtp \
  --spec-draft-n-max 16 \
  --spec-draft-p-min 0.8 \
  --jinja \
  --chat-template-file $HOME/qwen38/chat-template.jinja \
  --host 127.0.0.1 --port 8080 \
  ${EXTRA_ARGS:-}
