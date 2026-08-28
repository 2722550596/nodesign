#!/usr/bin/env node
/**
 * server/_probe-m3b-live.mjs — M3b 删除波 Gate（2026-08-28）。
 *
 *   node server/_probe-m3b-live.mjs [--model minimax-m3] [--timeout 180000] [--skip-tests]
 *
 * 三道闸（计划 M3b Gate）：
 *   1. 订阅模型选择 → 明确拒绝：订阅行 id 已不在模型表里，turn.js 的校验语义是
 *      403 MODEL_NOT_ALLOWED（清单非空）或 400 UNKNOWN_MODEL —— **不再是**
 *      SUBSCRIPTION_LANE_M1_DISABLED / MODEL_LOCKED。这里按 turn.js 的同一条判据
 *      （isEnvBundleModel + allowedModelsFor）对全部已删订阅名走一遍，并钉
 *      resolveModelRoute 对它们返 null、picker 清单无 locked 行。
 *   2. API 模型 turn 正常 → run.done（真上游，需要 ~/.nodesign/.env 的
 *      NODESIGN_UPSTREAM_GMI_KEY；默认 minimax-m3）。
 *   3. server 全绿：spawn `npm run test:server`（--skip-tests 可跳过）。
 *
 * 只写不跑由父代理统一执行（需要真上游 key）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// ── args ──
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('model', 'minimax-m3');
const TIMEOUT_MS = Number(opt('timeout', '180000'));
const SKIP_TESTS = args.includes('--skip-tests');

// M3b 删掉的 12 条订阅行 id（models.json B3 段）。探针钉的是：这些名字在删除波之后
// 一律走「不可用」路径，任何一条还能被选中/路由都是删除波的漏网。
const REMOVED_SUB_IDS = [
  'claude-sonnet-5[1m]', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-opus-5',
  'claude-opus-4-7[1m]', 'claude-sonnet-4-6[1m]', 'claude-opus-4-7', 'claude-sonnet-4-6',
  'claude-haiku-4-5', 'claude-opus-4-6[1m]', 'claude-opus-4-8[1m]', 'claude-sonnet-4-5-20250929[1m]',
];

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m3b-probe-'));
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
const { closeQuerySession } = await import('./engine/runs/active-runs.js');
const {
  selectableModelsFor, allowedModelsFor, resolveModelRoute, defaultModelFor,
} = await import('./engine/agent/model-context.js');
const { isEnvBundleModel } = await import('./engine/pi/model-map.js');

const results = {
  subRejected: null,       // 全部订阅名被拒
  routeNull: null,         // resolveModelRoute 全返 null
  noLockedRows: null,      // picker 清单无 locked 行
  noSubInList: null,       // 清单里没有任何订阅名
  turnDone: null,          // API turn run.done
  testsGreen: null,        // npm run test:server 全绿
};

// ── 1. 订阅模型选择 → 明确拒绝 ──
{
  // turn.js 的校验同构判据：不在 env 全家桶、不在白名单 → 拒。
  // 白名单非空时是 403 MODEL_NOT_ALLOWED；空清单是 NO_MODEL_CONFIGURED。
  // 这里对 admin（白名单最宽）断言：每条订阅名都进不了白名单。
  const admin = { id: '_probe', role: 'admin' };
  const allowed = allowedModelsFor(admin).map((m) => m.id);
  const leaked = REMOVED_SUB_IDS.filter((id) => isEnvBundleModel(id) || allowed.includes(id));
  results.subRejected = leaked.length === 0;
  console.log(`[probe] 1a 订阅名白名单泄漏: ${leaked.length ? leaked.join(',') : '无'}（期望无）`);

  results.routeNull = REMOVED_SUB_IDS.every((id) => resolveModelRoute(id) === null);
  console.log(`[probe] 1b resolveModelRoute 对全部订阅名返 null: ${results.routeNull}`);

  // picker 清单（admin 最宽口径）：无 locked 行、无订阅名
  const list = selectableModelsFor(admin);
  results.noLockedRows = list.every((m) => !m.locked);
  results.noSubInList = list.every((m) => !REMOVED_SUB_IDS.includes(m.id));
  console.log(`[probe] 1c picker 无 locked 行: ${results.noLockedRows}；无订阅名: ${results.noSubInList}（清单 ${list.length} 行）`);
  console.log(`[probe] 1d 默认模型: ${defaultModelFor(admin)}（期望 ox-alpha）`);
}

// ── 2. API 模型 turn 正常 → run.done ──
{
  const sessionId = randomUUID();
  const projectId = 'proj_m3b_probe01';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });
  const bus = new EventBus();
  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'M3b api turn', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({ runId: run1.id, text: 'Reply with exactly: M3B-API-OK', images: [] });
  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null, sessionWorkspaceRoot: wsRoot,
    eventBus: bus, inputQueue, skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));
  const done = await waitForTurn(bus, run1.id, TIMEOUT_MS);
  results.turnDone = done.type === 'run.done';
  console.log(`[probe] 2 API 模型 ${MODEL} turn → ${done.type}${done.finalText ? `（finalText: ${String(done.finalText).slice(0, 80)}）` : ''}`);
  closeQuerySession(sessionId, 'probe_done');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── 3. server 全绿（npm run test:server）──
if (!SKIP_TESTS) {
  console.log('[probe] 3 跑 server 全量测试（npm run test:server）…');
  const t0 = Date.now();
  const r = spawnSync('npm', ['run', 'test:server'], {
    cwd: repoRoot, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env },   // vitest.server.config.js 自带测试 DB_PATH，不碰生产库
    timeout: 15 * 60 * 1000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const summary = out.split('\n').filter((l) => /Test Files|Tests\s+\d/.test(l)).join(' | ');
  results.testsGreen = r.status === 0;
  console.log(`[probe] 3 npm run test:server → exit ${r.status}（${((Date.now() - t0) / 1000).toFixed(0)}s）${summary ? ` ${summary}` : ''}`);
  if (!results.testsGreen) console.log(out.split('\n').slice(-40).join('\n'));
} else {
  console.log('[probe] 3 --skip-tests：跳过全量测试');
}

// ── cleanup ──
server.close();

// ── pass/fail ──
console.log('\n===== M3B LIVE PROBE RESULTS =====');
const checks = [
  ['订阅名全部被白名单拒绝（MODEL_NOT_ALLOWED/UNKNOWN_MODEL 语义，无 SUBSCRIPTION_LANE_M1_DISABLED）', results.subRejected],
  ['resolveModelRoute 对全部订阅名返 null（subscription 通路不存在）', results.routeNull],
  ['picker 清单无 locked 行', results.noLockedRows],
  ['picker 清单无任何订阅名', results.noSubInList],
  [`API 模型 ${MODEL} turn run.done`, results.turnDone],
];
if (!SKIP_TESTS) checks.push(['server 全量测试全绿（npm run test:server）', results.testsGreen]);
let allPass = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
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
      else if (e.type === 'run.error') { clearTimeout(t); unsub(); resolve({ type: 'run.error', error: e.error, code: e.code }); }
      else if (e.type === 'run.cancelled') { clearTimeout(t); unsub(); resolve({ type: 'run.cancelled' }); }
    });
  });
}
