/**
 * server/_probe-run-accounting.mjs — run 记账错位案的端到端验收（2026-08-20）。
 *
 * 走真 runSession + 真 SDK + 真 runs 表，复现 08-19 的错位场景：
 *   m1（sleep 8 的 Bash）→ 2.5s 后追加 m2（被 CLI 并轮）→ m1 的 result 到 → 再发 m3（新一轮）。
 * 通过条件：
 *   - run1 / run3 各收到一次 run.start + run.done；run2 **没有** run.start，收到 run.merged(into run1)
 *   - runs 表：三条全 succeeded；run2.metadata.mergedIntoRunId === run1.id；
 *     run3.started_at ≥ run1.finished_at（不再是"下一轮的执行窗口"）；没有 pending 残留
 *
 * 跑法（⚠️ 必须把库指走，store.js 默认指生产库）：
 *   DB_PATH=/tmp/nd-probe-runs.db node --env-file=.env server/_probe-run-accounting.mjs
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runSession } from './engine/agent/session-loop.js';
import { EventBus } from './engine/agent/events.js';
import { createRun, getRun } from './engine/runs/store.js';
import { AsyncQueue } from './lib/async-queue.js';
import { closeQuerySession } from './engine/runs/active-runs.js';
import { pushUserMessage } from './engine/runs/turn-relay.js';

if (!process.env.DB_PATH || /server[\\/]db[\\/]nodesign\.db$/.test(path.resolve(process.env.DB_PATH))) {
  console.error('refusing to run: DB_PATH must point at a scratch db, not the production one');
  process.exit(3);
}

const t0 = Date.now();
const ts = () => String(Date.now() - t0).padStart(6, ' ') + 'ms';
const log = (...a) => console.log(ts(), '[probe-ra]', ...a);
const pf = (b) => (b ? 'PASS' : 'FAIL');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodesign-probe-ra-'));
const sessionId = '00000000-0000-0000-0000-00000000fafa';
const sessionRoot = path.join(tmpRoot, 'sessions', sessionId);
fs.mkdirSync(path.join(sessionRoot, '.claude', 'projects'), { recursive: true });
const projectId = 'proj_probe_ra_0001';   // 形状要过 validateProjectId（projects/store.js），不必真存在

const bus = new EventBus();
const byRun = new Map();   // runId → { start, done, merged, mergedInto }
const depths = [];
const rec = (id) => { if (!byRun.has(id)) byRun.set(id, { start: 0, done: 0, merged: 0, mergedInto: null }); return byRun.get(id); };
bus.subscribe('*', (e) => {
  if (e.type === 'run.start') rec(e.runId).start += 1;
  if (e.type === 'run.done') rec(e.runId).done += 1;
  if (e.type === 'run.merged') { rec(e.runId).merged += 1; rec(e.runId).mergedInto = e.intoRunId; }
  if (e.type === 'run.queue.depth') depths.push(e.depth);
  if (['run.start', 'run.done', 'run.merged', 'run.error', 'run.cancelled', 'run.queue.depth'].includes(e.type)) {
    log('EVT', e.type, e.runId ? `run=${short(e.runId)}` : '', e.intoRunId ? `into=${short(e.intoRunId)}` : '', e.depth != null ? `depth=${e.depth}` : '', e.message || '');
  }
});
function short(id) { return String(id).slice(0, 14); }

const inputQueue = new AsyncQueue();
const sessionPromise = runSession({
  sessionId, projectId, sessionWorkspaceRoot: sessionRoot, eventBus: bus, inputQueue,
  skillId: 'deskskill-engine-mini',
}).catch((err) => { console.error('[probe-ra] runSession threw:', err.message); throw err; });

await new Promise((r) => setTimeout(r, 1500));

const mk = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
const waitFor = (pred, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { off(); reject(new Error(`timeout ${ms}ms`)); }, ms);
  const off = bus.subscribe('*', (e) => { if (pred(e)) { clearTimeout(timer); off(); resolve(e); } });
});

const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm1 sleep', projectId, sessionId });
log('PUSH m1 run=' + short(run1.id));
pushUserMessage(sessionId, run1.id, mk('Use the Bash tool to run exactly: `sleep 8 && echo A-DONE`. When it finishes reply with exactly one line: FIRST-DONE'));

await new Promise((r) => setTimeout(r, 2500));
const run2 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 appended mid-turn', projectId, sessionId });
log('PUSH m2 run=' + short(run2.id) + ' (mid-turn)');
pushUserMessage(sessionId, run2.id, mk('Second request: use the Bash tool to run `echo B-DONE`, then reply with exactly one line: SECOND-DONE'));

await waitFor((e) => e.type === 'run.done' && e.runId === run1.id, 120_000);
log('run1 done');
await new Promise((r) => setTimeout(r, 1000));

const run3 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm3 next turn', projectId, sessionId });
log('PUSH m3 run=' + short(run3.id));
pushUserMessage(sessionId, run3.id, mk('Third request: reply with exactly one line: THIRD-DONE (no tools)'));
await waitFor((e) => e.type === 'run.done' && e.runId === run3.id, 120_000);
log('run3 done');

closeQuerySession(sessionId, 'probe_done');
await sessionPromise.catch(() => {});

log('===================== VERIFY =====================');
const rows = [run1, run2, run3].map((r) => getRun(r.id));
for (const r of rows) {
  log(`run=${short(r.id)} status=${r.status} created=${r.createdAt} started=${r.startedAt} finished=${r.finishedAt} merged→${r.metadata?.mergedIntoRunId ? short(r.metadata.mergedIntoRunId) : '-'}`);
}
for (const [id, c] of byRun) log(`events run=${short(id)} start=${c.start} done=${c.done} merged=${c.merged}${c.mergedInto ? ' into=' + short(c.mergedInto) : ''}`);
log('queue depth sequence:', depths.join(','));

const [r1, r2, r3] = rows;
const checks = [
  ['run1: start=1 done=1', byRun.get(run1.id)?.start === 1 && byRun.get(run1.id)?.done === 1],
  ['run2: no run.start, run.merged into run1', (byRun.get(run2.id)?.start ?? 0) === 0 && byRun.get(run2.id)?.merged === 1 && byRun.get(run2.id)?.mergedInto === run1.id],
  ['run3: start=1 done=1', byRun.get(run3.id)?.start === 1 && byRun.get(run3.id)?.done === 1],
  ['db: all three succeeded', rows.every((r) => r.status === 'succeeded')],
  ['db: run2.metadata.mergedIntoRunId = run1', r2.metadata?.mergedIntoRunId === run1.id],
  ['db: run3.started_at >= run1.finished_at', r3.startedAt >= r1.finishedAt],
  // 并进去的那条，它的"执行窗口"必须落在承载它那一轮里（老病是每条 run 的窗口其实是
  // 下一轮的）。不拿 run1.started_at ≤ run2.created_at 当判据 —— run1 的 startTurn 发生在
  // 首条 SDK 消息到达时，CLI 冷启动慢一点就晚于 m2 的 created_at，那是时序不是错位。
  ['db: run2 (merged) timestamps fall inside run1 window', r2.startedAt >= r1.startedAt && r2.finishedAt <= r1.finishedAt],
];
let all = true;
for (const [name, ok] of checks) { log(`[${pf(ok)}] ${name}`); all = all && ok; }
log('OVERALL:', all ? 'PASS' : 'FAIL');
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(all ? 0 : 2);
