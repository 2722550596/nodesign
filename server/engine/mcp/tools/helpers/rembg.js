/**
 * helpers/rembg.js — Node 侧 spawn rembg-bridge.py 的包装。
 *
 * 用法：
 *   import { removeBackground, isAvailable } from './helpers/rembg.js';
 *   const rgbaPngBuf = await removeBackground(imgBuf);
 *
 * 工作流：
 *   1. 拿 NB2 / 任意来源的 PNG/JPEG 字节
 *   2. spawn server/.venv-rembg/bin/python3 跑 rembg-bridge.py
 *   3. stdin 喂源图字节，stdout 收 rembg 处理后的 RGBA PNG
 *   4. 返 Buffer 给调用方写盘 / 进 sharp pipeline
 *
 * 依赖（一次性 setup）：
 *   cd server && python3 -m venv .venv-rembg
 *   .venv-rembg/bin/python3 -m pip install rembg onnxruntime
 *   # 首次抠图触发 u2net.onnx (176MB) 下载到 ~/.u2net/，之后缓存
 *
 * Env override（部署不同环境时）：
 *   NODESIGN_REMBG_PYTHON  = python 解释器路径（默认 server/.venv-rembg/bin/python3）
 *   NODESIGN_REMBG_HELPER  = bridge 脚本路径（默认 server/engine/mcp/tools/helpers/rembg-bridge.py）
 *   NODESIGN_REMBG_TIMEOUT = subprocess 超时 ms（默认 30000；首次冷启 onnx 加载慢）
 *
 * Fail-soft 原则：rembg 不可用 / 失败时**不抛**——返 null 让调用方降级回原图，
 * agent 看到 text 提示"removeBackground 失败原因 X，落原图"，决定要不要重生 / 改 prompt。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// helpers/ 在 server/engine/mcp/tools/helpers/，server root 上溯 4 层
const SERVER_ROOT = path.resolve(__dirname, '../../../../');

const DEFAULT_PYTHON = path.join(SERVER_ROOT, '.venv-rembg', 'bin', 'python3');
const DEFAULT_HELPER = path.join(__dirname, 'rembg-bridge.py');
const DEFAULT_TIMEOUT_MS = 30_000;

function resolvePython() {
  return process.env.NODESIGN_REMBG_PYTHON || DEFAULT_PYTHON;
}

function resolveHelper() {
  return process.env.NODESIGN_REMBG_HELPER || DEFAULT_HELPER;
}

/**
 * 检查 rembg 是否可用——venv python 解释器 + bridge 脚本都在。
 * 不实际 spawn 跑，只 stat 文件存在性。
 *
 * @returns {Promise<{ available: boolean, reason?: string }>}
 */
export async function isAvailable() {
  const py = resolvePython();
  const helper = resolveHelper();
  try {
    await fs.access(py);
  } catch {
    return { available: false, reason: `python not found: ${py}` };
  }
  try {
    await fs.access(helper);
  } catch {
    return { available: false, reason: `bridge script not found: ${helper}` };
  }
  return { available: true };
}

/**
 * 抠掉背景 → 返 transparent RGBA PNG Buffer。
 *
 * @param {Buffer} inputBuf - 源图字节（PNG/JPEG/WEBP 都可，rembg 自动识）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - subprocess 超时（ms），默认 30s
 * @returns {Promise<Buffer | null>} - 成功返 RGBA PNG buffer；失败返 null（不抛）
 */
export async function removeBackground(inputBuf, opts = {}) {
  if (!Buffer.isBuffer(inputBuf) || inputBuf.length === 0) {
    console.warn('[rembg] empty input buffer');
    return null;
  }

  const py = resolvePython();
  const helper = resolveHelper();
  const timeoutMs = opts.timeoutMs
    || Number(process.env.NODESIGN_REMBG_TIMEOUT)
    || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(py, [helper], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[rembg] spawn failed:', err.message);
      resolve(null);
      return;
    }

    const stdoutChunks = [];
    let stderrText = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      console.warn(`[rembg] timeout after ${timeoutMs}ms`);
      finish(null);
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk) => { stderrText += chunk.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[rembg] subprocess error:', err.message);
      finish(null);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(
          `[rembg] exit ${code}: ${stderrText.slice(0, 300).trim() || '(no stderr)'}`,
        );
        finish(null);
        return;
      }
      const out = Buffer.concat(stdoutChunks);
      if (out.length === 0) {
        console.warn('[rembg] empty stdout despite exit 0');
        finish(null);
        return;
      }
      finish(out);
    });

    // 喂 stdin 写源图
    try {
      proc.stdin.write(inputBuf);
      proc.stdin.end();
    } catch (err) {
      console.warn('[rembg] stdin write failed:', err.message);
      clearTimeout(timer);
      finish(null);
    }
  });
}
