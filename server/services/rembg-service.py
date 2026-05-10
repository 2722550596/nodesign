#!/usr/bin/env python3
"""rembg-service — long-running FastAPI service over Unix socket.

server/index.js spawn 这个进程在自己启动时；自己 shutdown 时 SIGTERM 它。
所有 onnxruntime session 在内存里 warm 缓存，避免 per-call cold spawn 税
（每次省 ~20-40s）。

启动顺序（2026-05-11 重构）：
  1. bind Unix socket（立刻 ready，~1s）
  2. uvicorn startup event 起后台 _preload(models) task 异步预热
  3. /remove 请求路径：未预热则同步 load（per-model asyncio.Lock 防并发重 load）
  避免老版"先 preload → 再 bind socket"路径在 birefnet+CoreML 卡死时
  socket 永不创建的死锁。

Endpoints:
  GET  /health
    返回 {"ok": true, "loaded_models": [...], "preload_done": bool}（也用作 isAvailable 探活）

  POST /remove
    Headers:
      X-Model: <rembg model name>             default 'birefnet-general-lite'
      X-Alpha-Matting: 0|1                    default 0
    Body: raw image bytes (PNG/JPEG/WEBP/...)
    Returns: RGBA PNG bytes (200) or JSON error (4xx/5xx)

Env:
  NODESIGN_REMBG_SOCKET         Unix socket path (default /tmp/nodesign-rembg.sock)
  NODESIGN_REMBG_PRELOAD        逗号分隔的 model 列表，启动时异步预加载
                                例：'isnet-general-use,birefnet-general-lite'
  NODESIGN_REMBG_PROVIDERS      逗号分隔 onnxruntime providers 覆盖默认。
                                未设时：darwin 默认 'CPUExecutionProvider' 单一
                                项绕过 CoreML+birefnet 卡死 bug（onnxruntime
                                1.19.2 验证），其它平台传 None 让 ort 自选
                                （Linux CUDA EP / Windows DML 等）。
"""
import asyncio
import atexit
import os
import sys
import warnings

# urllib3 v2 + LibreSSL（Apple python）只是警告，silence 防污染 stderr
warnings.filterwarnings('ignore')

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from rembg import remove, new_session


def _resolve_providers():
    """决定传给 rembg new_session 的 providers 列表。

    darwin（Apple Silicon Mac）必须排除 CoreMLExecutionProvider：
    onnxruntime 1.19.2 在 birefnet-general-lite 上 CoreML graph compile
    卡死（>110s 未返回；CPU-only providers 2.5s 完成）。

    Linux / Windows 走 None = ort 自选，保留 CUDA EP / DML 等加速。
    Env NODESIGN_REMBG_PROVIDERS 覆盖一切（escape hatch + ort 升级后复测用）。

    将来 onnxruntime 升级时重测：
      .venv-rembg/bin/python3 -c "from rembg import new_session; \\
        import time; t=time.time(); new_session('birefnet-general-lite'); \\
        print(time.time()-t)"
    < 30s 返回即可考虑放开 darwin 默认。
    """
    env = os.environ.get('NODESIGN_REMBG_PROVIDERS', '').strip()
    if env:
        return [p.strip() for p in env.split(',') if p.strip()]
    if sys.platform == 'darwin':
        return ['CPUExecutionProvider']
    return None  # ort 自选


PROVIDERS = _resolve_providers()

app = FastAPI()

# 模型 session 缓存：model name → onnxruntime session
sessions = {}
# per-model asyncio.Lock 防并发同一 model 重复 new_session（preload + 第一个
# /remove 撞车场景）。dict 默认 lazy 建 Lock。
_session_locks: dict = {}
# preload 任务完成与否（仅 /health 报告用）
_preload_done = False


def _get_lock(model_name: str) -> asyncio.Lock:
    if model_name not in _session_locks:
        _session_locks[model_name] = asyncio.Lock()
    return _session_locks[model_name]


def _load_session_sync(model_name: str):
    """同步 load——锁内调用。onnxruntime new_session 是阻塞 CPU 工作，
    用 asyncio.to_thread 在外层包裹。"""
    if model_name not in sessions:
        sessions[model_name] = new_session(model_name, providers=PROVIDERS)
    return sessions[model_name]


async def ensure_session(model_name: str):
    """异步获取 session：已 load 直接返；未 load 锁内同步 load 然后返。"""
    if model_name in sessions:
        return sessions[model_name]
    async with _get_lock(model_name):
        # double-check：另一 task 可能已经 load 完
        if model_name in sessions:
            return sessions[model_name]
        return await asyncio.to_thread(_load_session_sync, model_name)


async def _preload(models):
    """启动后台预热——串行 load 防同时撑爆内存。失败单 model 不影响整体。"""
    global _preload_done
    for m in models:
        print(f'[rembg-service] preloading {m}...', file=sys.stderr, flush=True)
        try:
            await ensure_session(m)
            print(f'[rembg-service]   ✓ {m} ready', file=sys.stderr, flush=True)
        except Exception as e:
            print(f'[rembg-service]   ✗ {m} failed: {type(e).__name__}: {e}',
                  file=sys.stderr, flush=True)
    _preload_done = True
    print(f'[rembg-service] preload done, loaded={sorted(sessions.keys())}',
          file=sys.stderr, flush=True)


@app.on_event('startup')
async def _on_startup():
    preload = os.environ.get('NODESIGN_REMBG_PRELOAD', '').strip()
    if not preload:
        return
    models = [s.strip() for s in preload.split(',') if s.strip()]
    if models:
        asyncio.create_task(_preload(models))


@app.get('/health')
def health():
    return {
        'ok': True,
        'loaded_models': sorted(sessions.keys()),
        'preload_done': _preload_done,
    }


@app.post('/remove')
async def remove_endpoint(request: Request):
    model = request.headers.get('x-model', 'birefnet-general-lite')
    alpha_matting = request.headers.get('x-alpha-matting', '0') == '1'
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(400, detail='empty body')
    try:
        session = await ensure_session(model)
        # rembg remove 是 CPU 密集——丢线程池防阻塞 event loop
        rgba = await asyncio.to_thread(
            remove, image_bytes, session=session, alpha_matting=alpha_matting,
        )
        return Response(content=rgba, media_type='image/png')
    except Exception as e:
        print(f'[rembg-service] /remove error: {type(e).__name__}: {e}',
              file=sys.stderr, flush=True)
        raise HTTPException(500, detail=f'{type(e).__name__}: {e}')


def cleanup_socket(socket_path: str):
    """退出时删 socket file，方便下次启动重新 bind。"""
    try:
        if os.path.exists(socket_path):
            os.unlink(socket_path)
            print(f'[rembg-service] cleaned up {socket_path}', file=sys.stderr, flush=True)
    except OSError:
        pass


def main():
    socket_path = os.environ.get('NODESIGN_REMBG_SOCKET', '/tmp/nodesign-rembg.sock')
    # bind 前清掉旧 socket（上次没干净退出会留残骸；SIGKILL 不走 atexit）
    cleanup_socket(socket_path)
    atexit.register(cleanup_socket, socket_path)

    providers_label = ','.join(PROVIDERS) if PROVIDERS else '<ort-default>'
    print(f'[rembg-service] providers={providers_label}', file=sys.stderr, flush=True)
    print(f'[rembg-service] listening on {socket_path}', file=sys.stderr, flush=True)

    import uvicorn
    # log_level=warning 静音 uvicorn access logs（每次请求一行很吵）
    uvicorn.run(app, uds=socket_path, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
