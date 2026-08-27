#!/usr/bin/env node
/**
 * Nodesign pre-M2 live probe — set_preset RPC（preset 运行中切换 + --continue 恢复）。
 *
 * 验证 doc §5.6 交付节奏的第三步（前两步 M1.5 已完成：pi-rp dist 重建 + rpc-client
 * setPreset 封装）。三项验收：
 *   1. set_preset RPC 切换成功（response.success + data.presetId）
 *   2. preset_activated 线上事件到达（session-loop onEvent → eventBus run.preset_activated）
 *   3. --continue 恢复：关掉会话重开（同 sid，hasPiSession → --continue），
 *      get_state.activePresetId 从 session JSONL 的 preset_change 条目恢复
 *
 * 观测手段：get_state 新增 activePresetId 字段（本次 pi-rp 侧加的，rpc-mode.ts get_state）。
 * 用 nodesign-base preset（agent-dir 里现成的占位，autoActivate:false —— 正好验证
 * "非默认 preset 也能被 set_preset 显式激活"）。
 *
 * 用法：node server/_probe-preset-live.mjs [--model minimax-m3] [--timeout 180000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('model', 'minimax-m3');
const TIMEOUT_MS = Number(opt('timeout', '180000'));
const PRESET_ID = 'nodesign-base';

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-preset-probe-'));
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
const { EventBus } = await import('./engine/agent/events.js');
const { AsyncQueue } = await import('./lib/async-queue.js');
const { createRun } = await import('./engine/runs/store.js');
const { getQuerySession, closeQuerySession } = await import('./engine/runs/active-runs.js');

const sessionId = randomUUID();
const projectId = 'proj_presetprobe01';
const wsRoot = path.join(projectsDir, projectId, 'shared');
fs.mkdirSync(wsRoot, { recursive: true });

const results = {
  initialPreset: null, switchOk: false, switchDataPreset: null,
  activatedEvent: null, stateAfterSwitch: null, restoredPreset: null,
};

// ── Phase 1：起会话，跑一轮（建 session 文件），然后 set_preset ──
{
  const bus = new EventBus();
  const presetEvents = [];
  bus.subscribe('run.preset_activated', (e) => presetEvents.push(e));

  const MARKER = 'ND-PRESET-LIVE-20260827';
  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'preset probe turn 1', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({ runId: run1.id, text: `Repeat the exact token ${MARKER} as the first line. Then one short sentence.`, images: [] });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));

  await new Promise((resolve) => {
    const un = bus.subscribe('*', (e) => { if (e.type === 'run.query.start') { un(); resolve(); } });
    setTimeout(() => { un(); resolve(); }, 30000);
  });

  const t0 = Date.now();
  const result1 = await waitForTurn(bus, run1.id, TIMEOUT_MS);
  console.log(`[probe] turn 1: ${result1.type} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const query = getQuerySession(sessionId)?.query;
  if (!query || typeof query.setPreset !== 'function') {
    console.error('[probe] FATAL: 会话未 attach 或 shim 无 setPreset');
  } else {
    // 初始 preset（应是 pi-default：nodesign-base autoActivate:false，settings 无 defaultPreset）
    try {
      const st0 = await query.getState();
      results.initialPreset = st0?.activePresetId ?? null;
      console.log(`[probe] 初始 activePresetId = ${results.initialPreset}`);
    } catch (err) { console.error('[probe] getState(初始) threw:', err.message); }

    // set_preset 切换
    try {
      const r = await query.setPreset(PRESET_ID);
      results.switchOk = !!r?.success;
      results.switchDataPreset = r?.data?.presetId ?? null;
      console.log(`[probe] setPreset(${PRESET_ID}) → success=${!!r?.success}, data.presetId=${r?.data?.presetId}${r?.error ? `, error=${r.error}` : ''}`);
    } catch (err) {
      console.error('[probe] setPreset threw:', err.message);
    }

    // 等 preset_activated 事件（set_preset 同步发，留 2s 窗口）
    await new Promise((r) => setTimeout(r, 2000));
    results.activatedEvent = presetEvents.length ? presetEvents[presetEvents.length - 1].presetId : null;
    console.log(`[probe] preset_activated 事件 presetId = ${results.activatedEvent}（收到 ${presetEvents.length} 条）`);

    // get_state 确认切换生效
    try {
      const st1 = await query.getState();
      results.stateAfterSwitch = st1?.activePresetId ?? null;
      console.log(`[probe] 切换后 activePresetId = ${results.stateAfterSwitch}`);
    } catch (err) { console.error('[probe] getState(切换后) threw:', err.message); }
  }

  closeQuerySession(sessionId, 'probe_phase1_done');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── Phase 2：同 sid 重开（hasPiSession → --continue），验证 preset 从 JSONL 恢复 ──
{
  const bus2 = new EventBus();
  const inputQueue2 = new AsyncQueue();
  // 不 push 消息、不传 initialRunId —— 只要 pi 起来能 getState 就行
  //（resume 检测靠 hasPiSession；run.query.start 在 pi spawn 前就发，故下面轮询 getState）
  const sessionPromise2 = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus2, inputQueue: inputQueue2,
    skillId: 'deskskill-engine-mini',
  }).catch((err) => console.error('[probe] runSession(resume) threw:', err.message));

  await new Promise((resolve) => {
    const un = bus2.subscribe('*', (e) => { if (e.type === 'run.query.start') { un(); resolve(); } });
    setTimeout(() => { un(); resolve(); }, 30000);
  });
  // pi spawn + attachSessionQuery 都晚于 run.query.start（attach 在 client.start() 探活后）。
  // 轮询 getQuerySession 直到 shim 挂上，再 getState（_rebuildSystemPrompt 恢复块在
  // client.start() 的 get_state 探活之前已跑完，拿到即已恢复）。
  const st2 = await waitSessionState(sessionId, 40, 500);
  if (st2) {
    results.restoredPreset = st2?.activePresetId ?? null;
    console.log(`[probe] --continue 恢复后 activePresetId = ${results.restoredPreset}`);
  } else {
    console.error('[probe] resume 会话 attach/getState 轮询超时');
  }
  closeQuerySession(sessionId, 'probe_done');
  await Promise.race([sessionPromise2, new Promise((r) => setTimeout(r, 15000))]);
}

server.close();

// ── pass/fail ──
console.log('\n===== PRESET LIVE PROBE RESULTS =====');
const checks = [
  ['set_preset RPC success', results.switchOk === true],
  ['set_preset data.presetId 回显', results.switchDataPreset === PRESET_ID],
  ['preset_activated 事件到达', results.activatedEvent === PRESET_ID],
  ['get_state 切换后 = nodesign-base', results.stateAfterSwitch === PRESET_ID],
  ['--continue 恢复 preset', results.restoredPreset === PRESET_ID],
];
let allPass = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) allPass = false;
}
console.log(`\n初始 preset: ${results.initialPreset}（预期 pi-default 或 null）`);
console.log(`\n${allPass ? 'GATE PASS' : 'GATE FAIL'}`);

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
process.exit(allPass ? 0 : 1);

// ── helper ──
function waitForTurn(bus, runId, timeoutMs) {
  return new Promise((resolve) => {
    const un = bus.subscribe('*', (e) => {
      if ((e.type === 'run.done' || e.type === 'run.error' || e.type === 'run.cancelled') && e.runId === runId) {
        un(); resolve(e);
      }
    });
    setTimeout(() => { un(); resolve({ type: 'timeout', runId }); }, timeoutMs);
  });
}

// 轮询 getQuerySession(sid).query.getState() 直到成功（pi 进程就绪 + shim 已 attach）。
// 返回 state 或 null（超时）。每次迭代重新取 query —— attach 晚于 run.query.start。
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
