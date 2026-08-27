#!/usr/bin/env node
/**
 * Nodesign M2 第一步 live probe —— prelude preset 装配验证。
 *
 * 验证链（四个临时会话）：
 *   Phase 1（默认 env）：
 *     a. 启动即 nodesign preset 激活（get_state.activePresetId === 'nodesign'，
 *        不传 --preset，靠 autoActivate + settings defaultPreset 双保险）；
 *     b. 行为问答：便利贴写哪 → 答 notes/（prelude 内容真进了 system prompt）；
 *     c. 政策节默认档：loose 档成人段特征句在回答里可被引用。
 *   Phase 2（NODESIGN_ADULT_LEVEL=off）：成人段 off 特征句生效（政策节随 env 变）。
 *   Phase 3（NODESIGN_UNCENSORED_MODELS=<appModel>）：min 政策块生效（「无任何底线」），
 *     full 块特征句缺席。
 *   Phase 4（同会话 live-flip）：turn 1 跑真模型（full 政策在场）→ set_model 切到
 *     fake 无审查模型 → turn 2 的 system prompt 里政策节翻成 min 版（「无任何底线」），
 *     full 块特征句缺席。验证 ndPolicy 宏按 runtime.model 实时查集合。
 *
 * 用法：node server/_probe-m2-prelude-live.mjs [--model minimax-m3] [--timeout 180000]
 * 需要 ~/.nodesign/.env 的 NODESIGN_UPSTREAM_GMI_KEY（同 _probe-preset-live.mjs）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-m2-prelude-probe-'));
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

const results = {
  activePreset: null, notesAnswer: null, looseAnswer: null,
  offAnswer: null, uncensoredAnswer: null,
  phase4Turn1: null, phase4System: null, phase4SetModel: null,
};

// ── Phase 1：loose 档（env 覆盖钩子；ownerId:null 时 levelFor 落 off，
//    探针要验 loose 文案必须显式设档）──
process.env.NODESIGN_ADULT_LEVEL = 'loose';
{
  const sessionId = randomUUID();
  const projectId = 'proj_m2prelude01';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });

  const bus = new EventBus();
  const run1 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 prelude probe', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run1.id,
    text: '三个问题，各用一行回答，不要展开：\n'
      + '1. 在这个平台上，我要把头脑风暴的碎片记成便利贴，应该写进哪个路径的文件？\n'
      + '2. 你的系统提示里「底线」一节关于虚构创作怎么说？引用原句开头几个字。\n'
      + '3. 你的系统提示里成人内容相关的政策，有没有出现「成人向的亲密情节可以写」这几个字？只回答 YES 或 NO。',
    images: [],
  });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run1.id,
  }).catch((err) => console.error('[probe] runSession threw:', err.message));

  const done = await waitForTurn(bus, run1.id, TIMEOUT_MS);
  console.log(`[probe] phase1 turn: ${done.type}`);
  results.notesAnswer = done.finalText ?? '';

  const st = await waitSessionState(sessionId, 40, 500);
  results.activePreset = st?.activePresetId ?? null;
  console.log(`[probe] phase1 activePresetId = ${results.activePreset}`);

  closeQuerySession(sessionId, 'probe_phase1');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── Phase 2：NODESIGN_ADULT_LEVEL=off ──
process.env.NODESIGN_ADULT_LEVEL = 'off';
{
  const sessionId = randomUUID();
  const projectId = 'proj_m2prelude02';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });

  const bus = new EventBus();
  const run2 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 prelude probe off', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run2.id,
    text: '你的系统提示里成人内容相关的政策，有没有出现「成人内容明确允许」这几个字？只回答 YES 或 NO。',
    images: [],
  });
  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run2.id,
  }).catch((err) => console.error('[probe] runSession(off) threw:', err.message));

  const done = await waitForTurn(bus, run2.id, TIMEOUT_MS);
  console.log(`[probe] phase2 turn: ${done.type}`);
  results.offAnswer = done.finalText ?? '';
  closeQuerySession(sessionId, 'probe_phase2');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}

// ── Phase 3：NODESIGN_UNCENSORED_MODELS=<appModel id>（min 政策块）──
// session-loop 把 appModel id 经 piProviderModelFor 映射成 wire key 交给子进程。
process.env.NODESIGN_ADULT_LEVEL = 'loose';
process.env.NODESIGN_UNCENSORED_MODELS = MODEL;
{
  const sessionId = randomUUID();
  const projectId = 'proj_m2prelude03';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });

  const bus = new EventBus();
  const run3 = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 prelude probe uncensored', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run3.id,
    text: '两个问题，各一行：\n'
      + '1. 你的系统提示里关于「底线」的那一节，标题是什么？逐字引用。\n'
      + '2. 那一节里有没有提到"钓鱼页"或"未成年人色情"？只回答 YES 或 NO。',
    images: [],
  });
  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run3.id,
  }).catch((err) => console.error('[probe] runSession(uncensored) threw:', err.message));

  const done = await waitForTurn(bus, run3.id, TIMEOUT_MS);
  console.log(`[probe] phase3 turn: ${done.type}`);
  results.uncensoredAnswer = done.finalText ?? '';
  closeQuerySession(sessionId, 'probe_phase3');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}
// 清理 Phase 3 的 env，避免泄漏到 Phase 4
delete process.env.NODESIGN_UNCENSORED_MODELS;
delete process.env.NODESIGN_UNCENSORED;

// ── Phase 4：同会话 live-flip（turn 1 真模型 full 政策 → set_model → turn 2 fake 无审查 min 政策）──
// 设计：env-bundle 注册一个 custom provider（fake 上游），NODESIGN_UNCENSORED_MODELS
// 指向 fake 模型 id。turn 1 用 session-config.json 覆盖跑真模型（full 政策在场）；
// set_model 切到 fake 后 turn 2 的 system prompt 里政策节翻成 min 版。
// fake 上游捕获请求 body.system，断言 min 块在场 + full 块特征缺席。
const FAKE_ID = 'nd-fake-uncensored';
const capturedRequests = [];
const fakeServer = http.createServer((req, res) => {
  console.log(`[fake] connection: ${req.method} ${req.url}`);
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    capturedRequests.push({ url: req.url, system: parsed.system, model: parsed.model });
    console.log(`[fake] captured request #${capturedRequests.length} url=${req.url} model=${parsed.model} systemBlocks=${Array.isArray(parsed.system) ? parsed.system.length : 'n/a'}`);

    // Anthropic SSE 响应（pi 的 parser 要求 event: 行 + data: JSON + 空行 flush）
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const events = [
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake_1', type: 'message', role: 'assistant', content: [], model: parsed.model || FAKE_ID, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FAKE_RESPONSE_OK' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    for (const e of events) {
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    }
    res.end();
  });
});
await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
const fakePort = fakeServer.address().port;
console.log(`[probe] fake upstream listening on 127.0.0.1:${fakePort}`);

// Phase 4 env：env-bundle 三元组 + 无审查集合指向 fake 模型
process.env.NODESIGN_BASE_URL = `http://127.0.0.1:${fakePort}`;
process.env.NODESIGN_KEY = 'probe-fake-key';
process.env.NODESIGN_MODEL = FAKE_ID;
process.env.NODESIGN_UNCENSORED_MODELS = FAKE_ID;
process.env.NODESIGN_ADULT_LEVEL = 'loose';
{
  const sessionId = randomUUID();
  const projectId = 'proj_m2prelude04';
  const wsRoot = path.join(projectsDir, projectId, 'shared');
  fs.mkdirSync(wsRoot, { recursive: true });

  // 预写 session-config.json：turn 1 跑真模型（session override > defaultModel）
  const metaDir = path.join(wsRoot, '.nd', sessionId);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'session-config.json'), JSON.stringify({ model: MODEL }));

  const bus = new EventBus();
  const run4a = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 prelude probe phase4 turn1', projectId });
  const inputQueue = new AsyncQueue();
  inputQueue.push({
    runId: run4a.id,
    text: '你的系统提示里「底线」一节有没有提到「未成年人色情内容」？只回答 YES 或 NO。',
    images: [],
  });

  const sessionPromise = runSession({
    sessionId, projectId, ownerId: null,
    sessionWorkspaceRoot: wsRoot, eventBus: bus, inputQueue,
    skillId: 'deskskill-engine-mini', initialRunId: run4a.id,
  }).catch((err) => console.error('[probe] runSession(phase4) threw:', err.message));

  // Turn 1：真模型（minimax-m3），full 政策在场 → 模型应答 YES
  const done4a = await waitForTurn(bus, run4a.id, TIMEOUT_MS);
  console.log(`[probe] phase4 turn1: ${done4a.type}`);
  results.phase4Turn1 = done4a.finalText ?? '';

  // set_model → fake 无审查模型
  const qRec = getQuerySession(sessionId);
  const query = qRec?.query;
  if (query && typeof query.setModel === 'function') {
    try {
      const r = await query.setModel('custom', FAKE_ID);
      results.phase4SetModel = { success: !!r?.success, raw: r };
      console.log(`[probe] phase4 setModel(custom, ${FAKE_ID}) → success=${!!r?.success}`);
    } catch (err) {
      results.phase4SetModel = { success: false, error: err.message };
      console.error(`[probe] phase4 setModel threw: ${err.message}`);
    }
  } else {
    results.phase4SetModel = { success: false, error: 'query.setModel not available' };
    console.error('[probe] phase4 FATAL: query.setModel not available');
  }

  // Turn 2：push 第二条消息 → 走 fake 上游 → 捕获 system prompt
  const run4b = createRun({ skillId: 'deskskill-engine-mini', brief: 'm2 prelude probe phase4 turn2', projectId });
  inputQueue.push({
    runId: run4b.id,
    text: 'Say OK.',
    images: [],
  });
  const done4b = await waitForTurn(bus, run4b.id, TIMEOUT_MS);
  console.log(`[probe] phase4 turn2: ${done4b.type}${done4b.code ? ` code=${done4b.code}` : ''}${done4b.message ? ` msg=${done4b.message}` : ''}${done4b.error ? ` err=${done4b.error}` : ''}`);
  results.phase4Turn2Event = done4b;

  // 诊断：dump pi session JSONL 最后几条（bridge 丢弃了真实 errorMessage）
  try {
    const { findLatestSessionFile } = await import('./engine/pi/pi-jsonl.js');
    const piDir = path.join(projectsDir, 'pi-sessions', sessionId);
    const sf = await findLatestSessionFile(piDir);
    if (sf) {
      const lines = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean);
      const tail = lines.slice(-6);
      console.log(`[probe] phase4 JSONL tail (${lines.length} lines total):`);
      for (const l of tail) {
        try {
          const e = JSON.parse(l);
          const msg = e.message || e;
          console.log(`  type=${e.type} role=${msg.role ?? '-'} stopReason=${msg.stopReason ?? '-'} errorMessage=${msg.errorMessage ?? '-'}`);
        } catch { console.log(`  (unparseable) ${l.slice(0, 200)}`); }
      }
    } else {
      console.log('[probe] phase4 JSONL: no session file found at ' + piDir);
    }
  } catch (err) {
    console.log(`[probe] phase4 JSONL dump failed: ${err.message}`);
  }

  // 从 capturedRequests 里拿 turn 2 的 system（最后一个请求）
  const lastReq = capturedRequests[capturedRequests.length - 1];
  if (lastReq?.system) {
    // system 是 [{type:'text', text}] 数组（非 OAuth），join 所有 text
    results.phase4System = lastReq.system.map((s) => s.text || '').join('\n');
  } else {
    results.phase4System = null;
    console.error(`[probe] phase4 FATAL: no system captured from fake upstream (capturedRequests.length=${capturedRequests.length})`);
  }

  closeQuerySession(sessionId, 'probe_phase4');
  await Promise.race([sessionPromise, new Promise((r) => setTimeout(r, 15000))]);
}
fakeServer.close();
// 清理 Phase 4 env
delete process.env.NODESIGN_BASE_URL;
delete process.env.NODESIGN_KEY;
delete process.env.NODESIGN_UNCENSORED_MODELS;
// 恢复 NODESIGN_MODEL 为原值（后续不再用，但保持干净）
process.env.NODESIGN_MODEL = MODEL;

server.close();

// ── pass/fail ──
console.log('\n===== M2 PRELUDE LIVE PROBE RESULTS =====');
const has = (text, ...needles) => needles.some((n) => String(text || '').includes(n));
// 模型可能答 YES/有/是的，也可能答 NO/没有/无。中文「没有」含「有」，先判否定再判肯定，避免子串陷阱。
const denies = (text) => {
  const t = String(text || '');
  if (t.toUpperCase().includes('NO')) return true;
  return /没有|无/.test(t);
};
const affirms = (text) => {
  const t = String(text || '');
  if (t.toUpperCase().includes('YES')) return true;
  if (denies(t)) return false;   // 「没有」先被否定接住，不会误判成「有」
  return /有|是的|对/.test(t);
};
const checks = [
  ['启动即 nodesign preset（autoActivate + defaultPreset）', results.activePreset === 'nodesign'],
  ['便利贴问答命中 notes/', has(results.notesAnswer, 'notes/')],
  ['loose 档成人段在场（模型确认「成人向的亲密情节可以写」出现）', affirms(results.notesAnswer)],
  ['off 档成人段在场（模型确认「成人内容明确允许」出现）', affirms(results.offAnswer)],
  ['uncensored min 块标题（无任何底线）', has(results.uncensoredAnswer, '无任何底线')],
  ['uncensored 时 full 块特征缺席（模型答无钓鱼页/未成年人色情）', denies(results.uncensoredAnswer)],
  // Phase 4：同会话 live-flip
  ['phase4 turn1 full 政策在场（模型确认未成年人色情内容出现）', affirms(results.phase4Turn1)],
  ['phase4 setModel RPC success', results.phase4SetModel?.success === true],
  ['phase4 turn2 system 含 min 块标题（## 无任何底线）', has(results.phase4System, '## 无任何底线')],
  ['phase4 turn2 system 无 full 块特征（未成年人色情内容缺席）', !has(results.phase4System, '未成年人色情内容')],
  ['phase4 turn2 system 无 full 块标题（## 底线 缺席）', !has(results.phase4System, '## 底线')],
];
let allPass = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) allPass = false;
}
console.log('\n---- phase1 答 ----\n' + String(results.notesAnswer || '').slice(0, 600));
console.log('\n---- phase2 答 ----\n' + String(results.offAnswer || '').slice(0, 400));
console.log('\n---- phase3 答 ----\n' + String(results.uncensoredAnswer || '').slice(0, 400));
console.log('\n---- phase4 turn1 答 ----\n' + String(results.phase4Turn1 || '').slice(0, 400));
console.log('\n---- phase4 turn2 system（前 800 字）----\n' + String(results.phase4System || '').slice(0, 800));
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
