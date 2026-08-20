#!/usr/bin/env bash
set -e
export CUDAENV=$HOME/qwen38/cudaenv
export PATH=$CUDAENV/bin:$PATH
export CUDA_HOME=$CUDAENV
export CUDACXX=$CUDAENV/bin/nvcc
export CUDAToolkit_ROOT=$CUDAENV
cd $HOME/qwen38/llama.cpp
# sm_120 = Blackwell（PRO 6000 / 5090 同族 GB202），要 CUDA ≥12.8，这里是 12.9
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j30 --target llama-server llama-cli llama-mtmd-cli
echo "BUILD_DONE"
