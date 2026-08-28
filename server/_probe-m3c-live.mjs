#!/usr/bin/env node
/**
 * Nodesign M3c live probe —— rewind 全链路（对话侧 navigate_tree + 文件侧 rewindWorkspace）。
 *
 * 验证链（一个临时会话，两轮 turn，活会话路径）：
 *   1. turn1：让 agent 写文件 A（rewind-index 记 turn1 user entry → turn1 前 HEAD）
 *   2. turn2：让 agent 写文件 B（索引记第二条）
 *   3. rewind 到 turn1 的 user entry：
 *      a. 对话侧：getQuerySession(sid).query.navigateTree(entryId_turn1)
 *         （label 默认 'rewind' → pi appendLabelChange 落盘 leaf，C0/C1）
 *      b. get_tree 断言 leafId === turn1 entry 的 parentId（user message 回滚位语义）
 *      c. JSONL 断言：最后一条 entry 是 type:'label' 且 targetId === turn1 entry
 *         （落盘锚 —— 死会话 rewind 重启后靠它恢复 leaf 位置）
 *      d. 文件侧：rewindWorkspace(pid, sid, turn1 的 headShaBefore)
 *         断言：文件 B 被删、文件 A 保留、filesChanged 含 b.txt、rewind 是新 commit
 *
 * 用法：node server/_probe-m3c-live.mjs [--model minimax-m3] [--timeout 180000]
 * 需要 ~/.nodesign/.env 的 NODESIGN_UPSTREAM_GMI_KEY。
 *
 * 注：死会话分支（spawnBarePiForRewind，C6）不在本探针覆盖 —— 它由 wave 2 落地，
 * 活会话路径已覆盖 navigate_tree + label 落盘 + 文件回滚的全部核心语义。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m3c-probe-'));
const projectsDir = path.join(tmpRoot, 'projects');
const dbPath = path.join(tmpRoot, 'probe.db');
fs.mkdirSync(projectsDir, { recursive: true });

process.env.NODESIGN_MODEL = MODEL;
process.env.PROJECTS_DATA_DIR = projectsDir;
process.env.DB_PATH = dbPath;
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = tmpRoot;

// ── sidecar Express server（工具 handler 走 sidecar，对齐生产接线）──
const { default: express } = await import('express');
const { createSidecarRouter } = await import('./engine/pi/sidecar.js');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/__nd-sidecar', createSidecarRouter({}));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.PORT = String(server.address().port);
console.log(`[probe] sidecar listening on 127.0.0.1:${process.env.PORT}`);

// ── now import server modules (after env is set) ──
const { runSession } = await import('./engine/agent/session-loop.js');
const { AsyncQueue } = await import('./lib/async-queue.js');
const { createRun } = await import('./engine/runs/store.js');
const { closeQuerySession, getQuerySession } = await import('./engine/runs/active-runs.js');
const { getProjectBus } = await import('./ws/broker.js');
const { readRewindIndex } = await import('./engine/agent/rewind-index.js');
const { rewindWorkspace } = await import('./projects/workspace.js');
const { piSessionDir, findLatestSessionFile } = await import('./engine/pi/pi-jsonl.js');
const { PROJECTS_DATA_ROOT } = await import('./projects/workspace.js');

const results = {
  turn1Done: false,
  turn2Done: false,
  indexEntries: 0,
  navigateOk: false,
  leafAtRollback: false,
  labelPersisted: false,
  fileBDeleted: false,
  fileAKept: false,
  filesChanged: [],
  rewindIsNewCommit: false,
};

const git = (cwd, ...a) => execFileSync(
  'git', ['-c', 'user.email=probe@nodesign', '-c', 'user.name=probe', ...a],
  { cwd, encoding: 'utf8' },
).trim();

const sessionId = randomUUID();
const projectId = 'proj_m3c_probe01';
const wsRoot = path.join(projectsDir, projectId, 'shared');
fs.mkdirSync(wsRoot, { recursive: true });
// rewind 文件侧依赖 git 历史：先 init + 基线 commit（getHeadSha 非 null 的前提）。
// .gitignore 排除 .nd/（rewind-index 等会话私档）与 .pi/（mcp.json）—— 对齐生产
// DEFAULT_GITIGNORE，否则它们会被 commitWorkspace 跟踪进树、污染 filesChanged。
git(wsRoot, 'init', '-q');
fs.writeFileSync(path.join(wsRoot, '.gitignore'), '.nd/\n.pi/\n');
fs.writeFileSync(path.join(wsRoot, 'baseline.txt'), 'baseline\n');
git(wsRoot, 'add', '-A');
git(wsRoot, 'commit', '-q', '-m', 'baseline');

const bus = getProjectBus(projectId);
const inputQueue = new AsyncQueue();

// turn1：写文件 A
const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm3c probe turn1', projectId });
inputQueue.push({
  runId: run1.id,
  text: '用写文件工具在当前目录创建文件 fileA.txt，内容为一行：ALPHA。只创建这一个文件，完成后一句话确认。',
  images: [],
});

const sessionPromise = runSession({
  sessionId, projectId, ownerId: null,
  sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
  skillId: 'deskskill-engine-mini', initialRunId: run1.id,
}).catch((err) => console.error('[probe] runSession threw:', err.message));

const done1 = await waitForTurn(bus, run1.id, TIMEOUT_MS);
console.log(`[probe] turn1: ${done1.type}${done1.type === 'run.error' ? ` code=${done1.code} msg=${done1.message}` : ''}`);
results.turn1Done = done1.type === 'run.done';

// turn2：写文件 B（排队语义：直接 push 进同一条 inputQueue）
const run2 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm3c probe turn2', projectId });
inputQueue.push({
  runId: run2.id,
  text: '用写文件工具在当前目录创建文件 fileB.txt，内容为一行：BETA。只创建这一个文件，完成后一句话确认。',
  images: [],
});
const done2 = await waitForTurn(bus, run2.id, TIMEOUT_MS);
console.log(`[probe] turn2: ${done2.type}${done2.type === 'run.error' ? ` code=${done2.code} msg=${done2.message}` : ''}`);
results.turn2Done = done2.type === 'run.done';

// ── rewind 前置：索引应有两条（turn1/turn2 各一）──
// run.done 在 finishTurn 前段 emit，rewind-index 在 commitWorkspace 之后才写。
// 探针收到 run.done 立刻读会漏掉刚结束那轮的条目 —— 轮询等索引长齐。生产无此
// race：用户看到消息才点回滚，那时 finishTurn 早已完成；且 turn 串行，前一轮索引
// 必先于后一轮 runTurn 落盘。
const metaDir = path.join(wsRoot, '.nd', sessionId);
let index = [];
for (let i = 0; i < 50 && index.length < 2; i++) {
  index = await readRewindIndex(metaDir);
  if (index.length < 2) await new Promise((r) => setTimeout(r, 200));
}
results.indexEntries = index.length;
console.log(`[probe] rewind-index entries: ${index.length}`);

// rewind 目标取 turn2 的条目（index[1]）：这才是「回滚到此轮之前 / 回到此处」的
// 真实 UX —— 保留 turn1 的产物（fileA），丢弃 turn2 及之后（fileB）。
// headShaBefore(turn2) = turn1 commit 之后、turn2 改动之前的树。
// （若按字面 rewind 到 turn1 条目，headShaBefore=baseline，fileA/fileB 全删，
//  那是「回到第一轮之前」的整段重置，不是本 Gate 要验的「保留前轮」语义。）
const target = index[1] ?? index[0];   // { entryId, headShaBefore } —— turn2 的 user entry
if (target) {
  // ── 对话侧：活会话 navigate_tree（label 默认 'rewind'）──
  const query = getQuerySession(sessionId)?.query;
  if (query?.navigateTree) {
    try {
      await query.navigateTree(target.entryId);
      results.navigateOk = true;
    } catch (err) {
      console.error('[probe] navigateTree failed:', err.message);
    }
  }

  // ── JSONL 断言：pi navigate_tree 语义（agent-session.ts）—— 目标是 user message
  //    时 leaf 先移到它的 parentId（回滚位），随后 appendLabelChange(targetId,'rewind')
  //    落一条 label entry（parentId = 导航后的 leaf = 回滚位），且 _appendEntry 把 leaf
  //    推进到这条 label entry 自身。所以：
  //      - 最后一条 entry 是 label 且 targetId = 目标 entry（C0 落盘生效）
  //      - label.parentId === 目标 entry 的 parentId（活动分支截到该消息发出前）
  //      - get_tree leafId === label entry 的 id（leaf 被 label 推进）
  const jsonl = await findLatestSessionFile(piSessionDir(PROJECTS_DATA_ROOT, sessionId));
  let targetParentId; let labelEntryId;
  if (jsonl) {
    const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim());
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const targetJsonlEntry = parsed.find((e) => e.id === target.entryId);
    targetParentId = targetJsonlEntry ? (targetJsonlEntry.parentId ?? null) : undefined;
    const last = parsed[parsed.length - 1];
    labelEntryId = last?.id;
    results.labelPersisted = last?.type === 'label' && last?.targetId === target.entryId
      && last?.parentId === targetParentId;
    console.log(`[probe] JSONL last entry: type=${last?.type} targetId=${last?.targetId} parentId=${last?.parentId}（目标 entry parentId=${targetParentId}）`);
  }
  if (query?.getTree && labelEntryId) {
    try {
      const { leafId } = await query.getTree();
      results.leafAtRollback = leafId === labelEntryId;
      console.log(`[probe] get_tree leafId=${leafId}（期望 = label entry id=${labelEntryId}，其 parentId 已截到回滚位）`);
    } catch (err) {
      console.error('[probe] getTree failed:', err.message);
    }
  }

  // ── 文件侧：rewindWorkspace 回到 turn2 开始前（= turn1 commit 后）──
  try {
    const rw = await rewindWorkspace(projectId, sessionId, target.headShaBefore);
    results.filesChanged = rw?.filesChanged ?? [];
    results.fileBDeleted = !fs.existsSync(path.join(wsRoot, 'fileB.txt'));
    results.fileAKept = fs.existsSync(path.join(wsRoot, 'fileA.txt'));
    // rewind 是新 commit（历史保留），且目标 sha 仍在祖先链里
    if (rw?.sha) {
      const ancestors = git(wsRoot, 'log', '--format=%H');
      results.rewindIsNewCommit = rw.sha !== target.headShaBefore && ancestors.includes(target.headShaBefore);
    }
    console.log(`[probe] rewindWorkspace sha=${rw?.sha} filesChanged=${JSON.stringify(results.filesChanged)}`);
  } catch (err) {
    console.error('[probe] rewindWorkspace failed:', err.message);
  }
}

closeQuerySession(sessionId, 'probe_m3c');
await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
server.close();

// ── pass/fail ──
console.log('\n===== M3C LIVE PROBE RESULTS =====');
const checks = [
  ['turn1（写文件 A）run.done', results.turn1Done],
  ['turn2（写文件 B）run.done', results.turn2Done],
  ['rewind-index 记了两条（每 turn 一条）', results.indexEntries === 2],
  ['navigate_tree 成功（活会话 RPC）', results.navigateOk],
  ['get_tree leafId === label entry id（leaf 被落盘 label 推进，活动分支截到回滚位）', results.leafAtRollback],
  ['JSONL 最后一条是 label entry 且 targetId/parentId 正确（leaf 落盘，C0 生效）', results.labelPersisted],
  ['文件 B 被删（rewind 精确回树，丢弃目标轮及之后）', results.fileBDeleted],
  ['文件 A 保留（保留目标轮之前的产物）', results.fileAKept],
  ['filesChanged 含 fileB.txt（前端计数源）', results.filesChanged.includes('fileB.txt')],
  ['rewind 是新 commit 且目标 sha 在祖先链（历史保留）', results.rewindIsNewCommit],
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
  // 对齐 session-loop.js TERMINAL_ERROR_CODES：非终态 run.error 不结束 turn
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
