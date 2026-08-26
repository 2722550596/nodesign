#!/usr/bin/env bash
# serve-prod.sh — 5090 32G 今晚对外服务配置（2026-08-20 定案）：
#   OrcaRouter Qwen3.8-27B-Uncensored Q5_K_M（19.5G）+ mmproj 视觉
#   1 槽 × 131072（⚠️ 必须等于 Nodesign model-context.js 里 qwen 行的 window）
#   MTP 投机 n8/p0.5（5090 干净 A/B 选出：散文 +29%、agent ~2.5×、14k 长上下文 +11%）
#   -cram 24576：prompt cache 住系统内存（盒子 58G）
#   留 ~6G 显存给 ComfyUI --lowvram（noobai）
export LD_LIBRARY_PATH=$HOME/qwen38/cudaenv/targets/x86_64-linux/lib:$HOME/qwen38/cudaenv/lib:${LD_LIBRARY_PATH:-}
M=$HOME/qwen38/models/orca
exec $HOME/qwen38/llama.cpp/build/bin/llama-server \
  -m $M/Qwen3.8-27B-Uncensored-Q5_K_M.gguf \
  --mmproj $M/mmproj-Qwen3.8-27B-Uncensored-f16.gguf \
  -ngl 99 -c 131072 -np 1 -cram 24576 -fa on \
  --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 \
  -b 4096 -ub 2048 \
  --spec-type draft-mtp --spec-draft-n-max 8 --spec-draft-p-min 0.5 \
  --reasoning-effort medium \
  --jinja --chat-template-file $HOME/qwen38/chat-template.jinja \
  --host 127.0.0.1 --port 8080 ${EXTRA_ARGS:-}
