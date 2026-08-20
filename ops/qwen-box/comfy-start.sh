#!/usr/bin/env bash
# ComfyUI 起服务。只绑环回 —— 出网靠 SSH 隧道，跟 llama-server 同一个范式。
cd ~/ComfyUI || exit 1
exec /environment/miniconda3/envs/comfyui/bin/python main.py \
  --listen 127.0.0.1 --port 8188 \
  --highvram
