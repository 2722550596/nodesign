#!/usr/bin/env node
/**
 * Nodesign M3a live probe — 模型层真相源 + 外部插槽修复 + 裸 pi 体检。
 *
 * 与 _probe-m15-live.mjs 同构（临时数据目录 + sidecar + runSession），验证三件事：
 *   1. 内置模型 turn：models.json → models-json.js → model-context → model-map →
 *      providers.ts（读 models.json 注册）→ pi run.done
 *   2. 外部插槽 turn（A7 回归修复）：config.json 外部行 → lifecycle 注入
 *      NODESIGN_UPSTREAM_<NAME>_KEY + NODESIGN_EXTERNAL_MODELS → providers.ts 注册
 *      外部 provider → pi run.done（M1 起这条路 INIT_FAILED，这里必须通）
 *   3. 体检探针（A9）：probeModel 临时 spawn 裸 pi（nd-probe preset），checks[0].ok
 *
 * 本机只有 GMI key → 内置行用 minimax-m3；外部行造一个指向 GMI 的 'extgmi' 上游
 * （inline key 取自 env），wireModel 同为 MiniMaxAI/MiniMax-M3 —— 验的是注册链路，
 * 不是新上游。
 *
 * 用法：node server/_probe-m3a-live.mjs [--model minimax-m3] [--timeout 180000]
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
const GMI_KEY = process.env.NODESIGN_UPSTREAM_GMI_KEY;
if (!GMI_KEY) {
  console.error('[probe] NODESIGN_UPSTREAM_GMI_KEY 缺失（~/.nodesign/.env），无法跑 live 探针');
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m3a-probe-'));
const projectsDir = path.join(tmpRoot, 'projects');
const dbPath = path.join(tmpRoot, 'probe.db');
fs.mkdirSync(projectsDir, { recursive: true });

// 外部插槽 config.json（A7）：extgmi 上游指向 GMI，inline key；一行外部模型。
// NODESIGN_MODELS_CONFIG 必须在 import local-config.js 之前设（configPath 模块加载期读）。
const extConfigPath = path.join(tmpRoot, 'config.json');
fs.writeFileSync(extConfigPath, JSON.stringify({
  upstreams: {
    extgmi: {
      label: 'M3a probe external GMI',
      baseUrl: 'https://api.gmi-serving.com',
      authStyle: 'bearer',
      key: GMI_KEY,
    },
  },
  models: [
    { id: 'ext-minimax', label: 'Ext MiniMax', desc: 'M3a probe', window: 272000, upstream: 'extgmi', wireModel: 'MiniMaxAI/MiniMax-M3', thinking: 'strip' },
  ],
}, null, 2));

process.env.NODESIGN_MODEL = MODEL;
process.env.PROJECTS_DATA_DIR = projectsDir;
process.env.DB_PATH = dbPath;
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = tmpRoot;
process.env.NODESIGN_MODELS_CONFIG = extConfigPath;

// ── 共享 agent-dir/settings.json 快照（防御性：本探针不走 setModel/setThinkingLevel，
// 但万一 pi 侧回归弄脏了也不留在工作区）──
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
const { closeQuerySession } = await import('./engine/runs/active-runs.js');
const { piProviderModelFor } = await import('./engine/pi/model-map.js');
const { probeModel } = await import('./lib/probe-pi.js');

const results = { builtin: null, external: null, mapLookup: null, probe: null };

// ── 1. 内置模型 turn ──
{
  const sessionId = randomUUID();
  const projectId = 'proj_m3a_probe01';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });
  const bus = new EventBus();
  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'M3a builtin turn', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({ runId: run1.id, text: 'Reply with exactly: M3A-BUILTIN-OK', images: [] });
  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null, sessionWorkspaceRoot: wsRoot,
    eventBus: bus, inputQueue, skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));
  results.builtin = (await waitForTurn(bus, run1.id, TIMEOUT_MS)).type;
  console.log(`[probe] 1 内置模型 ${MODEL} turn → ${results.builtin}`);
  closeQuerySession(sessionId, 'probe_done');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── 2. 外部插槽 turn（A7）──
{
  // 服务端反查先验：model-map 必须命中外部行（session-loop init 的闸门）
  results.mapLookup = piProviderModelFor('ext-minimax');
  console.log(`[probe] 2 piProviderModelFor('ext-minimax') → ${JSON.stringify(results.mapLookup)}`);

  process.env.NODESIGN_MODEL = 'ext-minimax';
  const sessionId = randomUUID();
  const projectId = 'proj_m3a_probe02';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });
  const bus = new EventBus();
  const run2 = createRun({ skillId: 'deskskill-engine-mini', brief: 'M3a external slot turn', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({ runId: run2.id, text: 'Reply with exactly: M3A-EXTERNAL-OK', images: [] });
  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null, sessionWorkspaceRoot: wsRoot,
    eventBus: bus, inputQueue, skillId: 'deskskill-engine-mini', initialRunId: run2.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));
  results.external = (await waitForTurn(bus, run2.id, TIMEOUT_MS)).type;
  console.log(`[probe] 2 外部插槽 ext-minimax turn → ${results.external}`);
  closeQuerySession(sessionId, 'probe_done');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── 3. 体检探针（A9：裸 pi + nd-probe preset）──
{
  try {
    const r = await probeModel(MODEL, { timeoutMs: TIMEOUT_MS });
    results.probe = { ok: r.checks?.[0]?.ok === true, checks: r.checks };
    console.log(`[probe] 3 probeModel(${MODEL}) → ok=${results.probe.ok} note=${r.checks?.[0]?.note}`);
  } catch (err) {
    results.probe = { ok: false, error: err.message };
    console.error(`[probe] 3 probeModel threw: ${err.message}`);
  }
}

// ── cleanup ──
server.close();
if (settingsBackup != null) {
  try { fs.writeFileSync(SETTINGS_PATH, settingsBackup); } catch { /* */ }
}

// ── pass/fail ──
console.log('\n===== M3A LIVE PROBE RESULTS =====');
const checks = [
  ['内置模型 turn run.done', results.builtin === 'run.done'],
  ['外部行 piProviderModelFor 命中', !!results.mapLookup && results.mapLookup.provider === 'extgmi'],
  ['外部插槽 turn run.done（A7 回归修复）', results.external === 'run.done'],
  ['体检探针 checks[0].ok（A9）', results.probe?.ok === true],
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
