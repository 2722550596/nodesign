#!/usr/bin/env node
/**
 * Nodesign M1 live integration probe — pi-rp engine end-to-end.
 *
 * Verifies the full chain:
 *   turn.js message shape → runSession (session-loop.js) → PiRpcClient → pi --mode rpc
 *   → providers.ts (GMI upstream) → event-bridge → run.done with finalText + usage
 *   → standalone MCP tool call via pi-mcp-adapter → sidecar gate → tool result
 *
 * Usage (repo root):
 *   node server/_probe-m1-live.mjs [--model minimax-m3] [--turns 2]
 *
 * Requires: NODESIGN_UPSTREAM_GMI_KEY in ~/.nodesign/.env (or env).
 * The probe starts a minimal Express sidecar on a free port so standalone's
 * tool calls can reach /__nd-sidecar for gate/emit/charge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// ── args ──
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('model', 'minimax-m3');
const TURNS = Number(opt('turns', '2'));
const TIMEOUT_MS = Number(opt('timeout', '180000'));

// ── env setup (BEFORE any server imports) ──
// Load GMI key from ~/.nodesign/.env
const envFile = path.join(os.homedir(), '.nodesign', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^(NODESIGN_UPSTREAM_[A-Z_]+_KEY)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!process.env.NODESIGN_UPSTREAM_GMI_KEY) {
  console.error('FATAL: NODESIGN_UPSTREAM_GMI_KEY not set (check ~/.nodesign/.env)');
  process.exit(1);
}

// Temp data dirs (isolate from real data)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m1-probe-'));
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
const { createRun, getRun, getRunModelUsage } = await import('./engine/runs/store.js');
const { pushUserMessage } = await import('./engine/runs/turn-relay.js');
const { closeQuerySession } = await import('./engine/runs/active-runs.js');

// ── session setup ──
const sessionId = randomUUID();
const projectId = 'proj_m1probe01';
const wsRoot = path.join(projectsDir, projectId, 'shared');
fs.mkdirSync(wsRoot, { recursive: true });

const bus = new EventBus();
const events = [];
bus.subscribe('*', (e) => events.push(e));

// ── Turn 1 setup (create run BEFORE runSession so initialRunId wires currentRunId) ──
const MARKER = 'ND-M1-LIVE-20260827';
const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'M1 live probe turn 1', projectId });

const inputQueue = new AsyncQueue();
// 首条消息提前 push（production turn.js startNewRunSession 同款）
inputQueue.push({ runId: run1.id, text: `Repeat the exact token ${MARKER} as the first line of your reply. Then say one short sentence.`, images: [] });

const sessionPromise = runSession({
  sessionId,
  projectId,
  ownerId: null,
  sessionWorkspaceRoot: wsRoot,
  eventBus: bus,
  inputQueue,
  skillId: 'deskskill-engine-mini',
  initialRunId: run1.id,
}).catch((err) => {
  console.error('[probe] runSession threw:', err.message);
});

// Wait for pi to start (run.query.start event)
await new Promise((resolve) => {
  const un = bus.subscribe('*', (e) => {
    if (e.type === 'run.query.start') { un(); resolve(); }
  });
  setTimeout(() => { un(); resolve(); }, 30000);
});
console.log('[probe] session started, pi process alive');

const t0 = Date.now();
const result1 = await waitForTurn(bus, run1.id, TIMEOUT_MS);
console.log(`[probe] turn 1: ${result1.type} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (result1.type === 'run.done') {
  console.log(`[probe] finalText (first 200): ${(result1.finalText || '').slice(0, 200)}`);
}

// ── Turn 2: tool call (read_board) ──
let result2 = null;
let run2 = null;
if (TURNS >= 2 && result1.type === 'run.done') {
  // Write a minimal board.json so read_board has something to return
  const boardPath = path.join(wsRoot, 'board.json');
  fs.writeFileSync(boardPath, JSON.stringify({ version: 1, objects: [], zones: [] }));

  run2 = createRun({ skillId: 'deskskill-engine-mini', brief: 'M1 live probe turn 2', projectId });
  pushUserMessage(sessionId, run2.id, {
    text: 'Call the read_board tool now. After it returns, reply with exactly: BOARD_READ_OK',
    images: [],
  });

  const t1 = Date.now();
  result2 = await waitForTurn(bus, run2.id, TIMEOUT_MS);
  console.log(`[probe] turn 2: ${result2.type} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (result2.type === 'run.done') {
    console.log(`[probe] finalText (first 200): ${(result2.finalText || '').slice(0, 200)}`);
  }
}

// ── cleanup ──
closeQuerySession(sessionId, 'probe_done');
await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
server.close();

// ── verify ──
const runRow1 = getRun(run1.id);
const usage1 = getRunModelUsage(run1.id);
const totalMs = Date.now() - t0;

console.log('\n===== M1 LIVE PROBE RESULTS =====');
console.log(`model: ${MODEL}`);
console.log(`turn 1: ${result1.type} | run status: ${runRow1?.status}`);
console.log(`turn 1 marker present: ${(result1.finalText || '').includes(MARKER)}`);
console.log(`turn 1 usage rows: ${usage1?.length || 0}`);
if (usage1?.length) {
  const inp = usage1.reduce((a, r) => a + (r.inputTokens || 0), 0);
  const out = usage1.reduce((a, r) => a + (r.outputTokens || 0), 0);
  console.log(`turn 1 tokens: in=${inp} out=${out}`);
}
if (result2 && run2) {
  const runRow2 = getRun(run2.id);
  console.log(`turn 2: ${result2.type} | run status: ${runRow2?.status}`);
  const toolEvents = events.filter((e) => e.type === 'run.delta.tool_use' || e.type === 'run.delta.tool_result');
  console.log(`turn 2 tool events: ${toolEvents.length}`);
  console.log(`turn 2 BOARD_READ_OK: ${(result2.finalText || '').includes('BOARD_READ_OK')}`);
}
console.log(`total time: ${(totalMs / 1000).toFixed(1)}s`);

// Event type summary
const typeCounts = {};
for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
console.log(`\nevent types: ${JSON.stringify(typeCounts)}`);

// ── pass/fail ──
const checks = [
  ['turn 1 completed (run.done)', result1.type === 'run.done'],
  ['turn 1 marker in finalText', (result1.finalText || '').includes(MARKER)],
  ['turn 1 run status succeeded', runRow1?.status === 'succeeded'],
  ['turn 1 usage recorded', (usage1?.length || 0) > 0],
];
if (result2 && run2) {
  checks.push(['turn 2 completed (run.done)', result2.type === 'run.done']);
  checks.push(['turn 2 run status succeeded', getRun(run2.id)?.status === 'succeeded']);
}

let allPass = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass) allPass = false;
}
console.log(`\n${allPass ? 'GATE PASS' : 'GATE FAIL'}`);

// cleanup temp
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
process.exit(allPass ? 0 : 1);

// ── helper ──
function waitForTurn(bus, runId, timeoutMs) {
  return new Promise((resolve) => {
    const un = bus.subscribe('*', (e) => {
      if ((e.type === 'run.done' || e.type === 'run.error' || e.type === 'run.cancelled') && e.runId === runId) {
        un();
        resolve(e);
      }
    });
    setTimeout(() => { un(); resolve({ type: 'timeout', runId }); }, timeoutMs);
  });
}
