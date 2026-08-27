#!/usr/bin/env node
/**
 * Nodesign bash 放开 live probe —— 验 bash 真在 pi 会话里可调用（2026-08-27）。
 *
 * 背景：defaultTools 白名单补了 bash（成 pi 内建全集，不禁任何 pi 工具）。get_state
 * 不暴露工具清单，唯一硬证据是**真 turn 里模型调 bash 拿到输出**。本探针起一个临时
 * 会话，指示模型用 bash 跑 `echo BASH_PROBE_OK_<随机>`，断言 run.done 且最终文本
 * 回显该标记（= bash 真执行了，不是模型编的）。
 *
 * 用法：node server/_probe-bash-live.mjs [--model minimax-m3] [--timeout 180000]
 * 需要 ~/.nodesign/.env 的 NODESIGN_UPSTREAM_GMI_KEY。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('model', 'minimax-m3');
const TIMEOUT_MS = Number(opt('timeout', '180000'));

// ── env setup (BEFORE any server imports) ──
const envFile = path.join(os.homedir(), '.nodesign', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!process.env.NODESIGN_UPSTREAM_GMI_KEY) {
  console.error('[probe] NODESIGN_UPSTREAM_GMI_KEY 缺失（~/.nodesign/.env），无法跑 live 探针');
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-bash-probe-'));
const projectsDir = path.join(tmpRoot, 'projects');
const dbPath = path.join(tmpRoot, 'probe.db');
fs.mkdirSync(projectsDir, { recursive: true });

process.env.NODESIGN_MODEL = MODEL;
process.env.PROJECTS_DATA_DIR = projectsDir;
process.env.DB_PATH = dbPath;
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = tmpRoot;

// ── sidecar Express server on a free port ──
const { default: express } = await import('express');
const { createSidecarRouter } = await import('./engine/pi/sidecar.js');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/__nd-sidecar', createSidecarRouter({}));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
process.env.PORT = String(PORT);
console.log(`[probe] sidecar listening on 127.0.0.1:${PORT}`);

// ── now import server modules (after env is set) ──
const { runSession } = await import('./engine/agent/session-loop.js');
const { AsyncQueue } = await import('./lib/async-queue.js');
const { createRun } = await import('./engine/runs/store.js');
const { closeQuerySession, getQuerySession } = await import('./engine/runs/active-runs.js');
const { getProjectBus } = await import('./ws/broker.js');

const MARKER = `BASH_PROBE_OK_${randomUUID().slice(0, 8)}`;
const results = {
  activePreset: null,
  bashDone: false,
  bashToolSeen: false,
  finalText: '',
  extensionErrors: [],
};

{
  const sessionId = randomUUID();
  const projectId = 'proj_bashprobe';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });

  const bus = getProjectBus(projectId);
  const un = bus.subscribe('*', (e) => {
    if (e.type === 'run.error' && e.code === 'EXTENSION_ERROR') results.extensionErrors.push(e);
    // 工具调用事件：记下 bash 真被调过（event-bridge 把 tool 事件转成 run.* 转发）
    if (e.type === 'run.tool_start' && e.toolName === 'bash') results.bashToolSeen = true;
    if (e.type === 'run.tool_use' && (e.toolName === 'bash' || e.name === 'bash')) results.bashToolSeen = true;
  });

  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'bash probe', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run1.id,
    text: `请用 bash 工具执行这条命令：echo ${MARKER}。`
      + `执行后，把命令的标准输出原样用一行回复给我（只回那一行，不要别的）。`,
    images: [],
  });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));

  const done = await waitForTurn(bus, run1.id, TIMEOUT_MS);
  console.log(`[probe] turn: ${done.type}${done.type === 'run.error' ? ` code=${done.code} msg=${done.message}` : ''}`);
  results.bashDone = done.type === 'run.done';
  results.finalText = done.finalText ?? '';

  const st = await waitSessionState(sessionId, 40, 500);
  results.activePreset = st?.activePresetId ?? null;
  console.log(`[probe] activePresetId = ${results.activePreset}`);

  un();
  closeQuerySession(sessionId, 'probe_bash');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

server.close();

// ── pass/fail ──
console.log('\n===== BASH LIVE PROBE RESULTS =====');
const checks = [
  ['turn 跑通 run.done', results.bashDone],
  ['无 EXTENSION_ERROR', results.extensionErrors.length === 0],
  ['activePresetId === nodesign', results.activePreset === 'nodesign'],
  [`最终文本回显 bash 输出标记（${MARKER}）`, String(results.finalText).includes(MARKER)],
];
let allPass = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) allPass = false;
}
if (results.extensionErrors.length > 0) {
  console.log('\n---- extension_error 明细 ----');
  for (const e of results.extensionErrors) console.log(`  ${e.extensionPath ?? '?'} [${e.event ?? '?'}] ${e.message}`);
}
console.log('\n---- 最终答 ----\n' + String(results.finalText).slice(0, 400));
console.log(`\n${allPass ? 'GATE PASS' : 'GATE FAIL'}`);

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
process.exit(allPass ? 0 : 1);

// ── helper ──
function waitForTurn(bus, runId, timeoutMs) {
  // 对齐 session-loop.js TERMINAL_ERROR_CODES：非终态 run.error（如 guards 的
  // INIT_CONTRACT 心跳）不结束 turn，继续等真终态。
  const TERMINAL = new Set(['PROMPT_REJECTED', 'AUTO_RETRY_EXHAUSTED', 'STOP_REASON_ERROR']);
  return new Promise((resolve) => {
    const un = bus.subscribe('*', (e) => {
      if (e.runId !== runId) return;
      if (e.type === 'run.done' || e.type === 'run.cancelled') { un(); resolve(e); return; }
      if (e.type === 'run.error' && TERMINAL.has(e.code)) { un(); resolve(e); }
    });
    setTimeout(() => { un(); resolve({ type: 'timeout', runId }); }, timeoutMs);
  });
}

async function waitSessionState(sid, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    const q = getQuerySession(sid)?.query;
    if (q && typeof q.getState === 'function') {
      try { return await q.getState(); } catch { /* pi 未就绪，重试 */ }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}
