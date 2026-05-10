#!/usr/bin/env python3
"""rembg-bridge — read source PNG/JPEG from stdin, write transparent RGBA PNG to stdout.

Args:
  --model NAME        rembg session model name. Default: birefnet-general-lite.
                      Options: u2net / isnet-general-use / birefnet-general-lite /
                      birefnet-general / silueta etc. (see rembg docs)
  --alpha-matting     Enable rembg trimap alpha matting post-process. Drastically
                      reduces edge halo / 伪影 at cost of ~1-2× inference time.

调用方（Node 端 helpers/rembg.js）spawn 这个脚本，stdin 喂 NB2 生图字节，
stdout 拿 rembg 抠完背景的 PNG。stderr 走 logging（urllib3 LibreSSL 警告等
非致命噪声 silence 掉，真错让 caller 看到非零 exit code）。

依赖：server/.venv-rembg/ 装了 rembg + onnxruntime + 模型缓存到 ~/.u2net/
（首次 cold load 自动下载，birefnet-general-lite ~214MB / birefnet-general ~880MB）。

跑法：
  printf '<png-bytes>' | <server>/.venv-rembg/bin/python3 rembg-bridge.py \\
      --model birefnet-general-lite --alpha-matting > out.png
"""
import argparse
import sys
import warnings

# urllib3 v2 + LibreSSL（macOS 自带 Python 用 LibreSSL 不是 OpenSSL）只是警告，
# 抠图不受影响。silence 防污染 stderr 让 caller 误判失败。
warnings.filterwarnings('ignore')

from rembg import remove, new_session


def main() -> int:
    parser = argparse.ArgumentParser(description='rembg bridge: stdin → stdout')
    parser.add_argument(
        '--model',
        default='birefnet-general-lite',
        help='rembg session model name (default: birefnet-general-lite)',
    )
    parser.add_argument(
        '--alpha-matting',
        action='store_true',
        help='enable rembg trimap alpha matting (cleaner edges, ~1-2× slower)',
    )
    args = parser.parse_args()

    try:
        input_data = sys.stdin.buffer.read()
        if not input_data:
            print('rembg-bridge: empty stdin', file=sys.stderr)
            return 2

        session = new_session(args.model)
        output_data = remove(
            input_data,
            session=session,
            alpha_matting=args.alpha_matting,
        )
        sys.stdout.buffer.write(output_data)
        return 0
    except Exception as e:
        print(f'rembg-bridge error: {type(e).__name__}: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
