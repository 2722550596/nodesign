/**
 * services/rembg-launcher.js — Node 侧管 rembg-service.py 子进程生命周期
 *
 * server/index.js 启动时调 startRembgService()，shutdown 时调 stopRembgService()。
 * service 自己常驻一个 python 进程把 onnxruntime session 缓存在内存里——
 * 比 per-call cold subprocess spawn 省 ~20-40s/call。
 *
 * Service 死了不影响主流程（fallback 到老的 spawn-bridge 路径，详见 helpers/rembg.js）。
 *
 * Env override：
 *   NODESIGN_REMBG_PYTHON     venv python 解释器路径
 *   NODESIGN_REMBG_SERVICE    service 脚本路径
 *   NODESIGN_REMBG_SOCKET     Unix socket 路径
 *   NODESIGN_REMBG_PRELOAD    逗号分隔预加载模型列表（默认 isnet-general-use,birefnet-general-lite）
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// services/ 在 server/services/，server root 上溯 1 层
const SERVER_ROOT = path.resolve(__dirname, '..');

const DEFAULT_PYTHON = path.join(SERVER_ROOT, '.venv-rembg', 'bin', 'python3');
const DEFAULT_SERVICE = path.join(__dirname, 'rembg-service.py');
const DEFAULT_PRELOAD = 'isnet-general-use,birefnet-general-lite';

let serviceProc = null;
let started = false;

/**
 * 启动 rembg-service。幂等：重复调用 noop。
 * 返回 boolean —— 是否启动成功（venv 不存在 / spawn 错时返 false，server 继续）。
 */
export async function startRembgService() {
  if (started) return Boolean(serviceProc);
  started = true;

  const py = process.env.NODESIGN_REMBG_PYTHON || DEFAULT_PYTHON;
  const script = process.env.NODESIGN_REMBG_SERVICE || DEFAULT_SERVICE;
  const preload = process.env.NODESIGN_REMBG_PRELOAD || DEFAULT_PRELOAD;

  // venv 不存在直接 noop（首次部署 / dev 没装 rembg 的环境）
  try {
    await fs.access(py);
    await fs.access(script);
  } catch (err) {
    console.warn(
      `[rembg-service] not started: ${err.code === 'ENOENT' ? 'venv or script missing' : err.message}.`
      + ' Setup: cd server && python3 -m venv .venv-rembg && .venv-rembg/bin/python3 -m pip install rembg onnxruntime.'
      + ' remove_background tool will fall back to per-call spawn (slower).',
    );
    return false;
  }

  try {
    serviceProc = spawn(py, [script], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        NODESIGN_REMBG_PRELOAD: preload,
      },
      // detached:false → child 跟父 share 进程组，父收 SIGINT 时 shell 也会
      // 转给 child（双保险）；显式 SIGTERM 仍走 stopRembgService()
      detached: false,
    });
  } catch (err) {
    console.warn(`[rembg-service] spawn failed: ${err.message}`);
    serviceProc = null;
    return false;
  }

  console.log(`[rembg-service] spawned PID ${serviceProc.pid}, preload=[${preload}]`);

  serviceProc.on('exit', (code, signal) => {
    console.log(`[rembg-service] exited code=${code} signal=${signal}`);
    serviceProc = null;
    // 不自动重启——server shutdown / 真崩了由 pm2 重启 server 一并起。
    // 单方面重启子进程容易掩盖问题。
  });

  serviceProc.on('error', (err) => {
    console.warn(`[rembg-service] process error: ${err.message}`);
  });

  return true;
}

/**
 * 优雅关闭 rembg-service。SIGTERM 让 service 走 atexit 清 socket。
 */
export function stopRembgService() {
  if (!serviceProc) return;
  console.log(`[rembg-service] stopping PID ${serviceProc.pid}`);
  try {
    serviceProc.kill('SIGTERM');
  } catch { /* ignore — already dead */ }
  // 兜底 3s 后 SIGKILL
  const killer = setTimeout(() => {
    if (serviceProc) {
      try { serviceProc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 3000);
  killer.unref();
  serviceProc = null;
}

/**
 * 给外部探活用（helpers/rembg.js 不强依赖；自己也会 isAvailable check service health）
 */
export function isRembgServiceRunning() {
  return serviceProc !== null && !serviceProc.killed;
}
