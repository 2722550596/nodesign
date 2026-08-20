export HF_HUB_ENABLE_HF_TRANSFER=1
export HF_ENDPOINT=https://hf-mirror.com
R=HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF
/environment/miniconda3/bin/hf download $R Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf --local-dir ~/qwen38/models
/environment/miniconda3/bin/hf download $R mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf --local-dir ~/qwen38/models
echo "DOWNLOAD_DONE"
