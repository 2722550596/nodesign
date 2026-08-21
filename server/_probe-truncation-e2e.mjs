/**
 * _probe-truncation-e2e.mjs — 半截续接的真路径验收（08-21 晚）。
 *
 * 链路全真：真 runSession（session-loop）→ 真 SDK/CLI → 真 ingress → 真 openai-chat 转换层
 * → 假 OpenAI 上游（本文件里，唯一的假件）。假上游第一发**说到一半就把流掐了**（无 finish_reason、
 * 无 [DONE]），第二发正常收尾 —— 验证：
 *   ① 转换层把第一发标成半截（不是发 error：实测有可见输出后发 error CLI 不重试，只会判 is_error）
 *   ② session-loop 自动补一条续接消息、同一个 run 内再跑一轮
 *   ③ 用户最终拿到的是**接完的话**，run.done 只有一次（续接不多发一次结账）
 *   ④ 上游一直半截时，续接次数封顶（NODESIGN_TRUNCATION_CONTINUATIONS，默认 2）后按现状收尾
 *
 * 跑法（⚠️ DB_PATH 必须指走，别写生产库）：
 *   DB_PATH=/tmp/nd-probe-trunc.db node server/_probe-truncation-e2e.mjs           # 场景一：一次半截 → 续接成功
 *   DB_PATH=/tmp/nd-probe-trunc.db node server/_probe-truncation-e2e.mjs forever   # 场景二：一直半截 → 封顶收尾
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// once | forever | rst | clean（对照组：上游全程正常）| busy（503 重试提示）
// | donefin（发了 [DONE] 但末块没 finish_reason —— 不该被当半截）| billing（续接的账有没有结转）
const MODE = process.argv[2] || 'once';
const FOREVER = MODE === 'forever';
const RST = MODE === 'rst';                    // 上游中途硬断连（RST），比干净 EOF 更狠
const PORT = 45231;
const HALF = '这是上半句，说到一';
const USAGE = { prompt_tokens: 5000, completion_tokens: 300, total_tokens: 5300 };
const REST = '半被掐断了。下半句在这里，续接成功 NDCONTINUED。';

// ── 假 OpenAI chat 上游 ──
let mainCalls = 0;      // 真回合的主模型请求
let suggestionCalls = 0;  // CLI 回合之外的主模型请求（SUGGESTION MODE 猜你想问）—— 不算回合
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta, finish = null) => ({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', model: 'ox-alpha-free', choices: [{ index: 0, delta, finish_reason: finish }] });

const fake = http.createServer((req, res) => {
  const bufs = [];
  req.on('data', (c) => bufs.push(c));
  req.on('end', () => {
    const body = Buffer.concat(bufs).toString('utf8');
    let j = {}; try { j = JSON.parse(body); } catch { /* */ }
    const nTools = Array.isArray(j.tools) ? j.tools.length : 0;
    const isMain = nTools > 3;          // helper（标题/摘要）不带全套工具
    const sawContinuation = body.includes('上一条回复在传输途中被上游中断');
    if (!isMain) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });   // helper 一律正常收尾
      sse(res, chunk({ role: 'assistant', content: '好的' }, null));
      sse(res, chunk({}, 'stop'));
      res.write('data: [DONE]\n\n'); res.end();
      return;
    }
    const isSuggestion = body.includes('SUGGESTION MODE');
    if (isSuggestion) suggestionCalls += 1; else mainCalls += 1;
    const tag = `${isSuggestion ? 'SUGGEST' : 'MAIN'} #${isSuggestion ? suggestionCalls : mainCalls}`;
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastTxt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');

    // busy：前两发回空体 503（Zen 真实形态），验 ingress 有没有把"正在重试"推给用户
    if (MODE === 'busy' && !isSuggestion && mainCalls <= 2) {
      console.log(`[fake] ${tag} → HTTP 503（空体）`);
      res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    // donefin：正文 + [DONE]，末块**不带** finish_reason，传输层完全干净 —— 这是"收完了"，不是被掐
    if (MODE === 'donefin' && !isSuggestion) {
      console.log(`[fake] ${tag} → 完整收尾但末块无 finish_reason（带 [DONE]）`);
      sse(res, chunk({ role: 'assistant', content: REST }, null));
      sse(res, { ...chunk({}, null), usage: USAGE });
      res.write('data: [DONE]\n\n'); res.end();
      return;
    }
    const truncate = (MODE === 'clean' || MODE === 'busy' || MODE === 'billing') ? false
      : (FOREVER || (mainCalls === 1 && !isSuggestion));
    console.log(`[fake] ${tag} → ${truncate ? '半截掐断' : '完整收尾'}（续接提示=${sawContinuation} msgs=${msgs.length} 末条user=${lastTxt.slice(0, 60).replace(/\s+/g, ' ')}）`);
    if (MODE === 'billing' && !isSuggestion && mainCalls === 1) {
      console.log(`[fake] ${tag} → 半截掐断（带 usage）`);
      sse(res, chunk({ role: 'assistant', content: HALF }, null));
      sse(res, { ...chunk({}, null), usage: USAGE });
      setTimeout(() => { try { res.end(); } catch { /* */ } }, 60);
      return;
    }
    if (truncate) {
      // 半截：吐一段正文，然后**不给 finish_reason、不给 [DONE]** 就收场。
      // 默认走干净 EOF（生产日志里 Zen 就是这样：'stream ended without finish_reason'）；
      // rst 模式硬断连，验我们对上游中途断流的处理。
      sse(res, chunk({ role: 'assistant', content: HALF }, null));
      setTimeout(() => { try { RST ? res.destroy() : res.end(); } catch { /* */ } }, 60);
      return;
    }
    sse(res, chunk({ role: 'assistant', content: REST }, null));
    sse(res, { ...chunk({}, 'stop'), usage: USAGE });
    res.write('data: [DONE]\n\n'); res.end();
  });
});
await new Promise((r) => fake.listen(PORT, '127.0.0.1', r));
console.log(`[fake] listening on ${PORT}（模式：${MODE}）`);

// 上游指向假件（覆盖旋钮，见 model-context.js）—— 必须在 import model-context 之前设
process.env.NODESIGN_UPSTREAM_ZEN_GO_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.NODESIGN_UPSTREAM_ZEN_KEY = 'probe-fake-key';
process.env.NODESIGN_MODEL = 'ox-alpha';

const { runSession } = await import('./engine/agent/session-loop.js');
const { EventBus } = await import('./engine/agent/events.js');
const { createRun } = await import('./engine/runs/store.js');
const { AsyncQueue } = await import('./lib/async-queue.js');
const { closeQuerySession } = await import('./engine/runs/active-runs.js');
const { pushUserMessage } = await import('./engine/runs/turn-relay.js');
const { getRun, getRunModelUsage } = await import('./engine/runs/store.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-probe-trunc-'));
const sessionId = '00000000-0000-0000-0000-00000000c001';
const sessionRoot = path.join(tmpRoot, 'sessions', sessionId);
fs.mkdirSync(path.join(sessionRoot, '.claude', 'projects'), { recursive: true });

const PROJECT_ID = 'proj_probetrunc01';
const bus = new EventBus();
const finals = []; const notices = []; let doneCount = 0; let errCount = 0;
bus.subscribe('*', (e) => {
  if (e.type === 'run.done') { doneCount += 1; finals.push(e.finalText || ''); }
  if (e.type === 'run.error') { errCount += 1; finals.push(`[error] ${e.message}`); }
  if (e.type === 'run.notification') notices.push(`${e.key}: ${e.text}`);
});

const inputQueue = new AsyncQueue();
const sessionPromise = runSession({
  sessionId, projectId: PROJECT_ID, ownerId: null,
  sessionWorkspaceRoot: sessionRoot, eventBus: bus, inputQueue, skillId: 'deskskill-engine-mini',
}).catch((err) => { console.error('[probe] runSession threw:', err.message); });

await new Promise((r) => setTimeout(r, 2000));
const run = createRun({ skillId: 'deskskill-engine-mini', brief: 'truncation probe', projectId: PROJECT_ID });
console.log(`[probe] >>> push turn run=${run.id.slice(0, 12)}`);
pushUserMessage(sessionId, run.id, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '说一句话就好。' }] }, parent_tool_use_id: null });

const t0 = Date.now();
await new Promise((resolve) => {
  const un = bus.subscribe('*', (e) => {
    if ((e.type === 'run.done' || e.type === 'run.error') && e.runId === run.id) { un(); resolve(); }
  });
  setTimeout(() => { un(); resolve(); }, 120000);
});
const ms = Date.now() - t0;
closeQuerySession(sessionId, 'probe_done');
await sessionPromise;
fake.close();

const finalText = finals.join(' | ');
const runRow = getRun(run.id);
console.log(`\n===== VERIFY (${MODE}) =====`);
console.log(`上游回合请求 ${mainCalls} 发（另有 ${suggestionCalls} 发是 CLI 的猜你想问，不算回合）   回合耗时 ${(ms / 1000).toFixed(1)}s   run 状态=${runRow?.status}`);
console.log(`run.done=${doneCount} run.error=${errCount}`);
console.log(`通知：${notices.length ? notices.join(' ⏎ ') : '（无）'}`);
console.log(`最终文本：${finalText.slice(0, 300)}`);

const pf = (b) => (b ? 'PASS' : 'FAIL');
let checks;
if (MODE === 'donefin') {
  checks = [
    ['⛔ 带 [DONE] 的完整响应不该被当半截 → 只打一发', mainCalls === 1],
    ['没有任何"被掐断"的提示', !notices.some((n) => n.includes('掐断') || n.includes('没说完'))],
    ['run 落 succeeded', runRow?.status === 'succeeded'],
  ];
} else if (MODE === 'billing') {
  const usage = getRunModelUsage(run.id);
  const tot = usage.reduce((a, r) => ({ inp: a.inp + (r.inputTokens || 0), out: a.out + (r.outputTokens || 0) }), { inp: 0, out: 0 });
  console.log(`run_model_usage：${JSON.stringify(usage)}`);
  console.log(`落库合计 in=${tot.inp} out=${tot.out}（上游真打 ${mainCalls} 发 × 5000/300）`);
  checks = [
    ['半截后确实续接了（上游 2 发）', mainCalls === 2],
    ['⭐ 两轮的账都落库了（in ≈ 2×5000，不是只记最后一轮）', tot.inp >= 9000],
    ['输出 token 同样两轮都算', tot.out >= 500],
    ['run 落 succeeded', runRow?.status === 'succeeded'],
  ];
} else if (MODE === 'busy') {
  checks = [
    ['503 之后 CLI 重试、最终跑成', /NDCONTINUED/.test(finalText)],
    ['用户收到了"上游繁忙正在重试"的提示', notices.some((n) => n.includes('繁忙') && n.includes('重试'))],
    ['提示里告诉了用户可以自己停止', notices.some((n) => n.includes('停止'))],
    ['run 落 succeeded', runRow?.status === 'succeeded'],
  ];
} else if (MODE === 'clean') {
  checks = [
    ['对照组：上游全程正常 → 一发就完（没有平白续接）', mainCalls === 1],
    ['run 落 succeeded', runRow?.status === 'succeeded'],
    ['一次结账', doneCount === 1],
    ['⛔ 没有弹任何"被掐断"的提示', !notices.some((n) => n.includes('掐断') || n.includes('没说完'))],
  ];
} else if (!FOREVER) {   // once / rst 同一组判据：都该续接成功
  checks = [
    ['半截后真的又打了一发上游（自动续接）', mainCalls >= 2],
    ['最终文本包含续接后的下半句', /NDCONTINUED/.test(finalText)],
    ['整轮只结一次账（run.done 恰好 1 次）', doneCount === 1],
    ['run 落 succeeded', runRow?.status === 'succeeded'],
    ['给用户提示了"正在让它接着说完"', notices.some((n) => n.includes('接着说完'))],
  ];
} else {
  checks = [
    ['续接封顶：回合请求 = 首发 1 + 上限 2 = 3 发', mainCalls === 3],
    ['没有无限循环（回合在 120s 内收场）', ms < 118000],
    ['整轮只结一次账', doneCount + errCount === 1],
    ['提示了"可能没说完，重发试试"', notices.some((n) => n.includes('没说完'))],
  ];
}
for (const [name, ok] of checks) console.log(`[${pf(ok)}] ${name}`);
const all = checks.every(([, ok]) => ok);
console.log(`OVERALL: ${all ? 'PASS' : 'FAIL'}`);
process.exit(all ? 0 : 2);
