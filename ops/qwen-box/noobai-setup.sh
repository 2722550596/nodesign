#!/usr/bin/env bash
# 只装生图那半：ComfyUI + NoobAI 检查点。不碰 44G 的视频权重（这趟用不上）。
set -e
export PATH=/environment/miniconda3/bin:$PATH
conda create -y -n comfyui python=3.12 2>&1 | tail -1
ENV_PY=/environment/miniconda3/envs/comfyui/bin/python
$ENV_PY -m pip install -q -i https://pypi.tuna.tsinghua.edu.cn/simple torch torchvision --index-url https://download.pytorch.org/whl/cu130 2>&1 | tail -2
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git ~/ComfyUI
$ENV_PY -m pip install -q -i https://pypi.tuna.tsinghua.edu.cn/simple -r ~/ComfyUI/requirements.txt 2>&1 | tail -2
$ENV_PY -m pip install -q -i https://pypi.tuna.tsinghua.edu.cn/simple huggingface_hub
echo "COMFY_READY"
export HF_ENDPOINT=https://hf-mirror.com
mkdir -p ~/ComfyUI/models/checkpoints
/environment/miniconda3/envs/comfyui/bin/hf download Laxhar/noobai-XL-Vpred-1.0 NoobAI-XL-Vpred-v1.0.safetensors --local-dir ~/ComfyUI/models/checkpoints
echo "NOOBAI_READY"
