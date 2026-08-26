#!/usr/bin/env bash
# ComfyUI 与 llama-server 同住 5090 32G：--lowvram 权重住内存、采样时分层上卡，给 qwen 留出 ~28G。
cd ~/ComfyUI || exit 1
exec /environment/miniconda3/envs/comfyui/bin/python main.py --listen 127.0.0.1 --port 8188 --lowvram
