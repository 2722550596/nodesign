#!/usr/bin/env python3
"""rembg-bridge — read source PNG/JPEG from stdin, write transparent RGBA PNG to stdout.

调用方（Node 端 helpers/rembg.js）spawn 这个脚本，stdin 喂 NB2 生图字节，
stdout 拿 rembg 抠完背景的 PNG。stderr 走 logging（urllib3 LibreSSL 警告等
非致命噪声 silence 掉，真错让 caller 看到非零 exit code）。

依赖：server/.venv-rembg/ 装了 rembg + onnxruntime + u2net 模型缓存
（首次 ~/.u2net/u2net.onnx 自动下载 176MB）。

跑法：
  printf '<png-bytes>' | <server>/.venv-rembg/bin/python3 rembg-bridge.py > out.png
"""
import sys
import warnings

# urllib3 v2 + LibreSSL（macOS 自带 Python 用 LibreSSL 不是 OpenSSL）只是警告，
# 抠图不受影响。silence 防污染 stderr 让 caller 误判失败。
warnings.filterwarnings('ignore')

from rembg import remove


def main() -> int:
    try:
        input_data = sys.stdin.buffer.read()
        if not input_data:
            print('rembg-bridge: empty stdin', file=sys.stderr)
            return 2
        output_data = remove(input_data)
        sys.stdout.buffer.write(output_data)
        return 0
    except Exception as e:
        print(f'rembg-bridge error: {type(e).__name__}: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
