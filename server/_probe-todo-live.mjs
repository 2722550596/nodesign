#!/usr/bin/env node
/**
 * Nodesign todo 复刻 live probe —— TaskCreate/TaskUpdate/TaskList → run.todo.updated → 板书镜像。
 *
 * 背景：SDK 时代 agent-shared.js 把 Task* 工具调用镜像成 run.todo.updated（M2 删除波
 * 删了生产端）；本次用 pi 扩展 task-tools.ts 复刻生产端，消费端（board-tasklist.js
 * 板书镜像 + live-turn todos）零改动。本探针验全链路：
 *
 *   Phase A（一个临时会话，一轮）：
 *     a. 提示模型必须用 TaskCreate 列 3 个任务、TaskUpdate 把第一个标 completed；
 *     b. bus 收到 run.todo.updated（sidecar /emit，todos 形状 [{content,status,activeForm?}]）；
 *     c. 最后一条 todo 事件含 completed 项（TaskUpdate 生效）；
 *     d. turn 跑通 run.done，全程无 EXTENSION_ERROR；
 *     e. board-tasklist 消费事件落盘板书 notes/板书/*-步骤.md（含「这一轮的步骤」）。
 *
 * 用法：node server/_probe-todo-live.mjs [--model minimax-m3] [--timeout 180000]
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-todo-probe-'));
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
const { closeQuerySession } = await import('./engine/runs/active-runs.js');
const { getProjectBus } = await import('./ws/broker.js');

const results = {
  done: false,
  extensionErrors: [],
  todoEvents: [],
  boardFile: null,
  finalText: '',
};

// ── Phase A：Task* 工具 → run.todo.updated → 板书落盘 ──
const projectId = 'proj_todoprobe';
const wsRoot = path.join(projectsDir, projectId, 'shared');
fs.mkdirSync(wsRoot, { recursive: true });
{
  const sessionId = randomUUID();
  const bus = getProjectBus(projectId);   // 生产接线：sidecar /emit 与 runSession 同 bus

  const un = bus.subscribe('*', (e) => {
    if (e.type === 'run.error' && e.code === 'EXTENSION_ERROR') results.extensionErrors.push(e);
    if (e.type === 'run.todo.updated') {
      results.todoEvents.push(e);
      console.log(`[probe] got run.todo.updated #${results.todoEvents.length} todos=${(e.todos || []).length} runId=${e.runId ? 'set' : 'NULL'}`);
    }
  });

  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'todo probe', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run1.id,
    text: '你必须使用 TaskCreate 工具创建 3 个任务：「读文件」「写摘要」「收尾」。'
      + '创建完后，必须用 TaskUpdate 工具把第一个任务的状态改为 completed。'
      + '一定要调用这两个工具，不要用文字假装。全部做完后用一行话告诉我。',
    images: [],
  });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));

  const done = await waitForTurn(bus, run1.id, TIMEOUT_MS);
  console.log(`[probe] turn: ${done.type}${done.type === 'run.error' ? ` code=${done.code} msg=${done.message}` : ''}`);
  results.done = done.type === 'run.done';
  results.finalText = done.finalText ?? '';

  // board-tasklist 的落盘是 bus handler 里的异步活 —— run.done 后最后几条
  // run.todo.updated 的重写可能还在飞。等 3s 让它落完再读。
  await new Promise((r) => setTimeout(r, 3000));

  // board-tasklist 的落盘是 bus handler 里的异步活，且每条 run.todo.updated 都重写
  // 同一文件 —— 首次出现只是第一步的快照。轮询等它含全部 3 个任务 + completed 勾选
  // （最终态：TaskUpdate 的重写已落盘）再读。
  results.boardFile = await waitForBoardFile(wsRoot, 10000, ['读文件', '写摘要', '收尾', '- [x]']);

  un();
  closeQuerySession(sessionId, 'probe_todo');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

server.close();

// ── pass/fail ──
console.log('\n===== TODO REPLICATION LIVE PROBE RESULTS =====');
const lastTodos = results.todoEvents.length ? results.todoEvents[results.todoEvents.length - 1].todos : [];
const hasCompleted = Array.isArray(lastTodos) && lastTodos.some((t) => t && t.status === 'completed');
const todoShapeOk = results.todoEvents.every((e) => Array.isArray(e.todos) && e.todos.length > 0
  && e.todos.every((t) => t && typeof t.content === 'string' && typeof t.status === 'string'));
const boardContent = results.boardFile ? fs.readFileSync(results.boardFile, 'utf8') : '';
const checks = [
  ['turn 跑通 run.done', results.done],
  ['无 EXTENSION_ERROR（task-tools.ts 干净加载）', results.extensionErrors.length === 0],
  ['收到 run.todo.updated（TaskCreate/TaskUpdate 发射）', results.todoEvents.length > 0],
  ['todo 事件形状 [{content,status,...}]（消费端契约）', todoShapeOk],
  ['最后一条 todo 含 completed 项（TaskUpdate 生效）', hasCompleted],
  ['板书落盘 notes/板书/*-步骤.md（board-tasklist 消费）', !!results.boardFile],
  ['板书内容含「这一轮的步骤」', boardContent.includes('这一轮的步骤')],
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
console.log(`\n---- todo 事件（最后一条）----\n` + JSON.stringify(lastTodos, null, 2).slice(0, 600));
if (results.boardFile) console.log(`\n---- 板书 ${results.boardFile} ----\n` + boardContent.slice(0, 400));
console.log('\n---- 答 ----\n' + String(results.finalText).slice(0, 300));
console.log(`\n${allPass ? 'GATE PASS' : 'GATE FAIL'}`);

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
process.exit(allPass ? 0 : 1);

// ── helpers ──
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

/** 轮询等板书文件（board-tasklist 异步落盘 + 每事件重写）：notes/板书/*-步骤.md。
 *  mustContain 全命中才算最终态（否则只是早期快照）。 */
async function waitForBoardFile(root, timeoutMs, mustContain = []) {
  const deadline = Date.now() + timeoutMs;
  let lastHit = null;
  while (Date.now() < deadline) {
    const dir = path.join(root, 'notes', '板书');
    if (fs.existsSync(dir)) {
      const hit = fs.readdirSync(dir).find((f) => f.endsWith('-步骤.md'));
      if (hit) {
        const p = path.join(dir, hit);
        lastHit = p;
        const content = fs.readFileSync(p, 'utf8');
        if (mustContain.every((s) => content.includes(s))) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 超时兜底：返回已存在的文件（哪怕只是早期快照），让断言如实反映
  return lastHit;
}
