#!/usr/bin/env node
/**
 * Nodesign M2 第二步 live probe —— 扩展挂载联调 + AskUserQuestion 回路验证。
 *
 * 第一步（_probe-m2-prelude-live.mjs）已验 preset 装配与政策档；本探针验第二步
 * 新挂的 4 个扩展（ask-user / guards / prompt-support / inject）在真 pi 进程里
 * 干净加载、不误伤正常 turn，以及 AskUserQuestion 全链路（方案 A）。
 *
 * 验证链（两个临时会话，各一轮；bus 用 getProjectBus(pid)，对齐 turn.js:317 生产接线，
 * 让 sidecar /emit 与 /ask 的事件和 runSession 的流汇到同一条 bus）：
 *   Phase A（扩展健康 + 正常 turn 不误伤）：
 *     a. 正常 turn（列目录）跑通 run.done；
 *     b. 全程无 run.error code=EXTENSION_ERROR（4 个扩展 jiti 加载 + handler 无炸）；
 *     c. 收到 guards.ts 的 INIT_CONTRACT 心跳（session_start /emit，证扩展挂载且 sidecar 通路活）；
 *     d. activePresetId === 'nodesign'（preset 未被扩展装配破坏）。
 *   Phase B（AskUserQuestion 全链路）：
 *     a. 提示模型必须调 ask_user_question 工具问颜色偏好；
 *     b. bus 收到 run.ask_user_question（sidecar /ask emit，带 askId + questions）；
 *     c. 直接 answerAsk(sid, answers) resolve 挂起（/answer HTTP 路由的薄内核，已单测）；
 *     d. /ask 长轮询返回 → 工具拿到答案 → turn 继续 → run.done 且最终文本反映所选答案。
 *
 * 用法：node server/_probe-m2-step2-live.mjs [--model minimax-m3] [--timeout 180000]
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m2-step2-probe-'));
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
const { answerAsk } = await import('./engine/pi/ask-registry.js');

const results = {
  activePreset: null,
  normalDone: false,
  extensionErrors: [],
  initContractSeen: false,
  askEvent: null,
  askDone: false,
  askFinalText: '',
};

// ── Phase A：扩展健康 + 正常 turn 不误伤 ──
{
  const sessionId = randomUUID();
  const projectId = 'proj_m2step2a';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'hello.txt'), 'probe fixture\n');

  const bus = getProjectBus(projectId);   // 生产接线：sidecar /emit /ask 与 runSession 同 bus
  const extErrUn = bus.subscribe('*', (e) => {
    if (e.type === 'run.error' && e.code === 'EXTENSION_ERROR') results.extensionErrors.push(e);
    if (e.type === 'run.error' && e.code === 'INIT_CONTRACT') results.initContractSeen = true;
  });

  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 step2 probe A', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run1.id,
    text: '列出当前目录下的文件，用一行回答你看到了什么。',
    images: [],
  });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession(A) threw:', err.message));

  const done = await waitForTurn(bus, run1.id, TIMEOUT_MS);
  console.log(`[probe] phaseA turn: ${done.type}${done.type === 'run.error' ? ` code=${done.code} msg=${done.message}` : ''}`);
  results.normalDone = done.type === 'run.done';

  const st = await waitSessionState(sessionId, 40, 500);
  results.activePreset = st?.activePresetId ?? null;
  console.log(`[probe] phaseA activePresetId = ${results.activePreset}`);

  extErrUn();
  closeQuerySession(sessionId, 'probe_phaseA');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── Phase B：AskUserQuestion 全链路 ──
{
  const sessionId = randomUUID();
  const projectId = 'proj_m2step2b';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });

  const bus = getProjectBus(projectId);

  // 收到 run.ask_user_question → 直接 answerAsk resolve（/answer 路由的薄内核）。
  // 选「红色」，断言最终文本反映它。
  const askUn = bus.subscribe('*', (e) => {
    if (e.type === 'run.ask_user_question' && !results.askEvent) {
      results.askEvent = e;
      console.log(`[probe] phaseB got run.ask_user_question askId=${e.askId} questions=${(e.questions || []).length}`);
      const answers = (e.questions || []).map(() => ({ selectedLabels: ['红色'] }));
      const ok = answerAsk(e.sessionId, answers);
      console.log(`[probe] phaseB answerAsk(${e.sessionId}) → ${ok}`);
    }
  });

  const run2 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 step2 probe B', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run2.id,
    text: '你必须使用 ask_user_question 工具问我一个问题：我喜欢红色还是蓝色？'
      + '给出「红色」和「蓝色」两个选项。一定要调用工具，不要用文字直接问。'
      + '拿到我的回答后，用一行告诉我你收到了什么选择。',
    images: [],
  });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run2.id,
  }).catch((err) => console.error('[probe] runSession(B) threw:', err.message));

  const done = await waitForTurn(bus, run2.id, TIMEOUT_MS);
  console.log(`[probe] phaseB turn: ${done.type}${done.type === 'run.error' ? ` code=${done.code} msg=${done.message}` : ''}`);
  results.askDone = done.type === 'run.done';
  results.askFinalText = done.finalText ?? '';

  askUn();
  closeQuerySession(sessionId, 'probe_phaseB');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

server.close();

// ── pass/fail ──
console.log('\n===== M2 STEP2 LIVE PROBE RESULTS =====');
const has = (text, ...needles) => needles.some((n) => String(text || '').includes(n));
const checks = [
  ['Phase A 正常 turn 跑通 run.done', results.normalDone],
  ['Phase A 无 EXTENSION_ERROR（4 扩展干净加载）', results.extensionErrors.length === 0],
  ['Phase A 收到 guards INIT_CONTRACT 心跳（扩展挂载 + sidecar 通路活）', results.initContractSeen],
  ['Phase A activePresetId === nodesign', results.activePreset === 'nodesign'],
  ['Phase B 收到 run.ask_user_question（带 askId + questions）', !!results.askEvent && !!results.askEvent.askId && Array.isArray(results.askEvent.questions) && results.askEvent.questions.length > 0],
  ['Phase B turn 跑通 run.done（答案回流后继续）', results.askDone],
  ['Phase B 最终文本反映所选答案（红色）', has(results.askFinalText, '红色')],
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
console.log('\n---- phaseB ask 事件 ----\n' + JSON.stringify(results.askEvent, null, 2).slice(0, 600));
console.log('\n---- phaseB 答 ----\n' + String(results.askFinalText).slice(0, 400));
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
