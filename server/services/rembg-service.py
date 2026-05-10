#!/usr/bin/env python3
"""rembg-service — long-running FastAPI service over Unix socket.

server/index.js spawn 这个进程在自己启动时；自己 shutdown 时 SIGTERM 它。
所有 onnxruntime session 在内存里 warm 缓存，避免 per-call cold spawn 税
（每次省 ~20-40s）。

Endpoints:
  GET  /health
    返回 {"ok": true, "loaded_models": [...]}（也用作 isAvailable 探活）

  POST /remove
    Headers:
      X-Model: <rembg model name>             default 'birefnet-general-lite'
      X-Alpha-Matting: 0|1                    default 0
    Body: raw image bytes (PNG/JPEG/WEBP/...)
    Returns: RGBA PNG bytes (200) or JSON error (4xx/5xx)

Env:
  NODESIGN_REMBG_SOCKET         Unix socket path (default /tmp/nodesign-rembg.sock)
  NODESIGN_REMBG_PRELOAD        逗号分隔的 model 列表，启动时预加载（避免首
                                次请求等 model load）。例：
                                'isnet-general-use,birefnet-general-lite'
"""
import atexit
import os
import sys
import warnings

# urllib3 v2 + LibreSSL（Apple python）只是警告，silence 防污染 stderr
warnings.filterwarnings('ignore')

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from rembg import remove, new_session


app = FastAPI()

# 模型 session 缓存：model name → onnxruntime session
# 加载一次后常驻内存；多模型会累积内存，按需 preload 控制
sessions = {}


def get_session(model_name: str):
    if model_name not in sessions:
        sessions[model_name] = new_session(model_name)
    return sessions[model_name]


@app.get('/health')
def health():
    return {'ok': True, 'loaded_models': sorted(sessions.keys())}


@app.post('/remove')
async def remove_endpoint(request: Request):
    model = request.headers.get('x-model', 'birefnet-general-lite')
    alpha_matting = request.headers.get('x-alpha-matting', '0') == '1'
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(400, detail='empty body')
    try:
        session = get_session(model)
        rgba = remove(image_bytes, session=session, alpha_matting=alpha_matting)
        return Response(content=rgba, media_type='image/png')
    except Exception as e:
        # log 到 stderr 让 Node 端能看到（spawn 时 stdio inherit）
        print(f'[rembg-service] /remove error: {type(e).__name__}: {e}',
              file=sys.stderr, flush=True)
        raise HTTPException(500, detail=f'{type(e).__name__}: {e}')


def cleanup_socket(socket_path: str):
    """退出时删 socket file，方便下次启动重新 bind"""
    try:
        if os.path.exists(socket_path):
            os.unlink(socket_path)
            print(f'[rembg-service] cleaned up {socket_path}', file=sys.stderr, flush=True)
    except OSError:
        pass


def main():
    socket_path = os.environ.get('NODESIGN_REMBG_SOCKET', '/tmp/nodesign-rembg.sock')
    # bind 前清掉旧 socket（server 上次没干净退出会留残骸）
    cleanup_socket(socket_path)
    atexit.register(cleanup_socket, socket_path)

    # 预加载模型（PRELOAD env 控制）；不预加载也行，第一个请求会触发 lazy load
    preload = os.environ.get('NODESIGN_REMBG_PRELOAD', '').strip()
    if preload:
        for m in [s.strip() for s in preload.split(',') if s.strip()]:
            print(f'[rembg-service] preloading {m}...', file=sys.stderr, flush=True)
            try:
                get_session(m)
                print(f'[rembg-service]   ✓ {m} ready', file=sys.stderr, flush=True)
            except Exception as e:
                print(f'[rembg-service]   ✗ {m} failed: {e}', file=sys.stderr, flush=True)

    print(f'[rembg-service] listening on {socket_path}', file=sys.stderr, flush=True)

    import uvicorn
    # log_level=warning 静音 uvicorn access logs（每次请求一行很吵）
    uvicorn.run(app, uds=socket_path, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
