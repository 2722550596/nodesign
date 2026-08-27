#!/usr/bin/env node
/**
 * Nodesign M1.5 live probe — pi-rp RPC 直通能力（热换模型 / thinking 档位 / 会话统计）。
 *
 * 与 _probe-m1-live.mjs 同构（临时数据目录 + sidecar + runSession），但验证的是
 * M1.5 新接的三条 RPC：
 *   1. setModel(provider, modelId)   —— 热换模型（经 attachSessionQuery shim → rpc-client）
 *   2. setThinkingLevel(level)       —— thinking 档位
 *   3. getSessionStats()             —— 会话统计（含 contextUsage）
 *
 * 本机只有 GMI key → 唯一可用模型 minimax-m3。热换用「同模型 set_model」验证
 * 完整 RPC 往返（pi 校验 provider/modelId 合法性 + 落 model_change 条目），
 * 不依赖第二个上游。
 *
 * 用法：node server/_probe-m15-live.mjs [--model minimax-m3] [--timeout 180000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ── args ──
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m15-probe-'));
const projectsDir = path.join(tmpRoot, 'projects');
const dbPath = path.join(tmpRoot, 'probe.db');
fs.mkdirSync(projectsDir, { recursive: true });

process.env.NODESIGN_MODEL = MODEL;
process.env.PROJECTS_DATA_DIR = projectsDir;
process.env.DB_PATH = dbPath;
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = tmpRoot;

// ── 共享 agent-dir/settings.json 快照 ──
// pi 的 setModel/setThinkingLevel 会自持久化到 PI_CODING_AGENT_DIR/settings.json
// （共享模板目录）。探针跑完必须还原，否则弄脏 committed 文件。
const SETTINGS_PATH = path.join(scriptDir, 'engine', 'pi', 'agent-dir', 'settings.json');
const settingsBackup = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, 'utf8') : null;

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
const { piProviderModelFor } = await import('./engine/pi/model-map.js');
const { piSessionDir, findLatestSessionFile } = await import('./engine/pi/pi-jsonl.js');

// ── session setup ──
const sessionId = randomUUID();
const projectId = 'proj_m15probe01';
const wsRoot = path.join(projectsDir, projectId, 'shared');
fs.mkdirSync(wsRoot, { recursive: true });

const bus = new EventBus();
const events = [];
bus.subscribe('*', (e) => events.push(e));

const MARKER = 'ND-M15-LIVE-20260827';
const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'M1.5 live probe turn 1', projectId });
const inputQueue = new AsyncQueue();
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

// Wait for pi to start
await new Promise((resolve) => {
  const t = setTimeout(resolve, TIMEOUT_MS);
  bus.subscribe('run.query.start', () => { clearTimeout(t); resolve(); });
});
console.log('[probe] session started, pi process alive');

const t0 = Date.now();
const result1 = await waitForTurn(bus, run1.id, TIMEOUT_MS);
console.log(`[probe] turn 1: ${result1.type} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── M1.5 RPC 直通验证（会话仍活着，shim 已 attach）──
const qRec = getQuerySession(sessionId);
const query = qRec?.query;
const results = { turn1: result1.type, setModel: null, setThinking: null, stats: null, jsonl: null };

if (!query) {
  console.error('[probe] FATAL: 会话未 attach，无法验证 RPC');
} else {
  // 1. setModel —— 同模型热换（验证完整 RPC 往返 + pi 校验）
  const wire = piProviderModelFor(MODEL);
  if (!wire) {
    console.error(`[probe] FATAL: ${MODEL} 无 pi wire 映射`);
  } else {
    try {
      const r = await query.setModel(wire.provider, wire.model);
      results.setModel = { success: !!r?.success, provider: wire.provider, model: wire.model, raw: r };
      console.log(`[probe] setModel(${wire.provider}, ${wire.model}) → success=${!!r?.success}`);
    } catch (err) {
      results.setModel = { success: false, error: err.message };
      console.error(`[probe] setModel threw: ${err.message}`);
    }
  }

  // 2. setThinkingLevel
  try {
    const r = await query.setThinkingLevel('high');
    results.setThinking = { success: !!r?.success, raw: r };
    console.log(`[probe] setThinkingLevel(high) → success=${!!r?.success}`);
  } catch (err) {
    results.setThinking = { success: false, error: err.message };
    console.error(`[probe] setThinkingLevel threw: ${err.message}`);
  }

  // 3. getSessionStats（含 contextUsage）
  try {
    const stats = await query.getSessionStats();
    results.stats = {
      ok: true,
      hasContextUsage: !!stats?.contextUsage,
      contextUsage: stats?.contextUsage ?? null,
      totalMessages: stats?.totalMessages,
    };
    console.log(`[probe] getSessionStats → totalMessages=${stats?.totalMessages}, contextUsage=${JSON.stringify(stats?.contextUsage)}`);
  } catch (err) {
    results.stats = { ok: false, error: err.message };
    console.error(`[probe] getSessionStats threw: ${err.message}`);
  }

  // 4. JSONL 落盘验证：model_change + thinking_level_change 条目
  try {
    const sdir = piSessionDir(projectsDir, sessionId);
    const sf = await findLatestSessionFile(sdir);
    if (sf) {
      const lines = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean);
      const types = lines.map((l) => { try { return JSON.parse(l).type; } catch { return null; } });
      results.jsonl = {
        hasModelChange: types.includes('model_change'),
        hasThinkingChange: types.includes('thinking_level_change'),
      };
      console.log(`[probe] JSONL model_change=${results.jsonl.hasModelChange}, thinking_level_change=${results.jsonl.hasThinkingChange}`);
    } else {
      results.jsonl = { error: 'no session file' };
    }
  } catch (err) {
    results.jsonl = { error: err.message };
  }
}

// ── cleanup ──
closeQuerySession(sessionId, 'probe_done');
await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
server.close();
// 还原共享 settings.json（pi 热切会写它）
if (settingsBackup != null) {
  try { fs.writeFileSync(SETTINGS_PATH, settingsBackup); } catch { /* */ }
}

// ── pass/fail ──
console.log('\n===== M1.5 LIVE PROBE RESULTS =====');
const checks = [
  ['turn 1 run.done', results.turn1 === 'run.done'],
  ['setModel RPC success', results.setModel?.success === true],
  ['setThinkingLevel RPC success', results.setThinking?.success === true],
  ['getSessionStats ok', results.stats?.ok === true],
  ['contextUsage present', results.stats?.hasContextUsage === true],
  ['JSONL model_change persisted', results.jsonl?.hasModelChange === true],
  ['JSONL thinking_level_change persisted', results.jsonl?.hasThinkingChange === true],
];
let allPass = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) allPass = false;
}
console.log(`\n${allPass ? 'GATE PASS' : 'GATE FAIL'}`);

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
process.exit(allPass ? 0 : 1);

// ── helper ──
function waitForTurn(bus, runId, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
    const unsub = bus.subscribe('*', (e) => {
      if (e.runId !== runId) return;
      if (e.type === 'run.done') { clearTimeout(t); unsub(); resolve({ type: 'run.done', finalText: e.finalText }); }
      else if (e.type === 'run.error') { clearTimeout(t); unsub(); resolve({ type: 'run.error', error: e.error }); }
    });
  });
}
