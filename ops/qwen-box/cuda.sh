conda create -y -p ~/qwen38/cudaenv --override-channels \
  -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge \
  cuda-nvcc cuda-cudart-dev cuda-cccl libcublas-dev cuda-driver-dev cuda-version=12.9
echo "CUDA_ENV_DONE"
