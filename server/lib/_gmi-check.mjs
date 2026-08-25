/**
 * server/lib/_gmi-check.mjs — GMI Cloud（MiniMax M3 / M2.7）**穿真入口**的接入校验。
 *
 * 裸协议那趟由 `server/_probe-upstream.mjs` 跑过了（08-25：M3 8/9，只差 count_tokens）。
 * 这一趟验的是裸协议验不了的部分 —— 表、会话级路由、共用别名、思考档改写、helper 分岔：
 *
 *   1. 共用别名（SHARED_SDK_ALIAS）在**注册过的会话**里解回主行（全表反查里它根本不存在）
 *   2. appModel id 直呼（ANTHROPIC_SMALL_FAST_MODEL 走这条）
 *   3. ⭐ tool_result 里的图 —— 答得出 ND-7342 / 三角 / 黄才算真看见（M3 有视觉）
 *   4. 思考档：主行 adaptive（本站发的 enabled+8192 被出口改写）出 thinking 块；
 *      helper 请求**跨上游**落到 /zen/go 的 deepseek helper 行（08-25 晚换的，理由见 model-table.js）——
 *      这一项同时验了「一个会话的主行和 fast 行可以分属两个上游、两种协议」
 *   5. count_tokens：上游 404 → 入口本地估算兜底，绝不 fail
 *   6. ⛔ 没注册的会话用共用别名发过来 → 502 fail-loud（不许静默落到别人家）
 *   （M2.7 行 08-25 当天撤了：GMI 这家部署把图整个丢掉，判据与复牌条件见 model-table.js 那段注释）
 *
 * 用法：node --env-file=.env server/lib/_gmi-check.mjs
 *      （没配 .env 也行：钥匙直接从 ~/apikey/gmicloud-API.md 读）
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ⛔ 先把库指走再 import 任何 server 模块（测试写生产库的旧案，见 feedback-verify-the-instrument）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-gmi-check-'));
process.env.DB_PATH = path.join(TMP, 'check.db');

if (!process.env.NODESIGN_UPSTREAM_GMI_KEY) {
  process.env.NODESIGN_UPSTREAM_GMI_KEY = fs.readFileSync(path.join(os.homedir(), 'apikey/gmicloud-API.md'), 'utf8').trim();
}

const { getOrStartIngress, stopIngress, registerIngressSession, unregisterIngressSession } = await import('./model-ingress.js');
const { resolveModelRoute } = await import('../engine/agent/model-context.js');
const sharp = (await import('sharp')).default;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
  <rect width="480" height="320" fill="#102040"/>
  <polygon points="240,40 120,220 360,220" fill="#ffd21e"/>
  <text x="240" y="285" font-size="44" font-family="monospace" fill="#ffffff" text-anchor="middle">ND-7342</text>
</svg>`;
const pngB64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');

const results = [];
const check = (name, ok, note = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`); };

const { baseUrl } = await getOrStartIngress();
const SID = 'gmicheck-session';
registerIngressSession(SID, 'minimax-m3');
const ALIAS = resolveModelRoute('minimax-m3').sdkAlias;

async function post(body, { sid = SID, endpoint = 'messages' } = {}) {
  const t0 = Date.now();
  const url = `${baseUrl}${sid ? `/__nd/${sid}` : ''}/v1/${endpoint === 'count' ? 'messages/count_tokens' : 'messages'}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'nd-ingress-managed', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: r.status, json, text, ms: Date.now() - t0 };
}
const textOf = (j) => (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
const hasThinking = (j) => (j?.content || []).some((b) => b.type === 'thinking');
const PEEK = { name: 'peek_screen', description: 'Take a screenshot and return it as an image.', input_schema: { type: 'object', properties: {} } };
const THINK = { type: 'enabled', budget_tokens: 8192 };   // 本站 pickThinkingConfig 给每条 API 行发的就是这个

console.log(`\n===== GMI 接入校验 @ ${baseUrl}（alias=${ALIAS}）=====\n`);

// 1. 共用别名 → 会话主行
{
  const r = await post({ model: ALIAS, max_tokens: 200, messages: [{ role: 'user', content: '只回两个字：收到' }] });
  check('1 共用别名经会话路由解回 minimax-m3', r.status === 200 && /收到/.test(textOf(r.json)), `${r.status} ${r.ms}ms model=${r.json?.model}`);
}
// 2. appModel 直呼（SMALL_FAST_MODEL 走的路）
{
  const r = await post({ model: 'minimax-m3', max_tokens: 200, messages: [{ role: 'user', content: '只回两个字：收到' }] });
  check('2 appModel 直呼路由', r.status === 200 && /收到/.test(textOf(r.json)), `${r.status} ${r.ms}ms`);
}
// 3. ⭐ tool_result 里的图
{
  const r = await post({
    model: ALIAS, max_tokens: 3000, tools: [PEEK],
    messages: [
      { role: 'user', content: '调用 peek_screen 看一眼屏幕，然后说出图里的文字、形状、颜色。' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'peek_screen', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } }] }] },
    ],
  });
  const out = textOf(r.json);
  check('3 ⭐tool_result 里的图真看见（M3 有视觉，原生直通不用 lift）', r.status === 200 && /7342/.test(out) && /(三角|triangle)/i.test(out), `${r.status} ${r.ms}ms「${out.replace(/\s+/g, ' ').slice(0, 60)}」`);
}
// 4. 思考档
{
  const r = await post({ model: ALIAS, max_tokens: 2000, thinking: THINK, messages: [{ role: 'user', content: '17×23 等于多少？先想再答。' }] });
  check('4a 主行 adaptive：enabled+8192 被改写，模型自己决定想（这题该想 → 出 thinking 块）', r.status === 200 && hasThinking(r.json), `${r.status} ${r.ms}ms blocks=[${(r.json?.content || []).map((b) => b.type).join(',')}]`);
  // helper 请求带的是 fast 行的 **app id**（session-loop 注给 CLI 的 SMALL_FAST_MODEL 就是它）
  const h = await post({ model: 'deepseek-v4-flash-helper', max_tokens: 300, thinking: THINK, messages: [{ role: 'user', content: '给这段对话起个五个字以内的标题：修图片裂开的问题。只回标题。' }] });
  check('4b helper 跨上游：GMI 会话里的 helper 请求落到 /zen/go 的 deepseek 行并答得出', h.status === 200 && textOf(h.json).length > 0, `${h.status} ${h.ms}ms「${textOf(h.json).replace(/\s+/g, ' ').slice(0, 24)}」`);
  // ⭐ 08-25 fable 评审抓到的那一类：helper 行接的**不只是纯文本**（auto-compact 要把带截图的整段对话
  // 交给它，兜底改道的请求也从这儿走）。同池的纯文本版 deepseek-v4-flash 一带图就 400，所以这一项必须带图，
  // 否则换错变体没人拦得住 —— 上一版的 4b 只发纯文本，正是因此漏过。
  const hi = await post({
    model: 'deepseek-v4-flash-helper', max_tokens: 400, thinking: THINK,
    messages: [{ role: 'user', content: [{ type: 'text', text: '一句话说说这张图里有什么。' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } }] }],
  });
  check('4c ⭐helper 行必须收得下图（auto-compact 会把带截图的对话交给它）', hi.status === 200, `${hi.status} ${hi.ms}ms ${hi.status === 200 ? '「' + textOf(hi.json).replace(/\s+/g, ' ').slice(0, 30) + '」' : hi.text.slice(0, 120)}`);
}
// 5. count_tokens 本地兜底
{
  const r = await post({ model: ALIAS, messages: [{ role: 'user', content: 'hello world' }] }, { endpoint: 'count' });
  check('5 count_tokens 上游 404 → 入口本地估算', r.status === 200 && Number(r.json?.input_tokens) > 0, `${r.status} input_tokens=${r.json?.input_tokens}`);
}
// 6. ⛔ 没注册的会话用共用别名 → 502
{
  const r = await post({ model: ALIAS, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, { sid: null });
  check('6 ⛔共用别名无会话 → 502 fail-loud（不静默落到别人家）', r.status === 502, `${r.status} ${r.text.slice(0, 60)}`);
}
unregisterIngressSession(SID);
await stopIngress();
const pass = results.filter((r) => r.ok).length;
console.log(`\n===== ${pass}/${results.length} 项通过 =====`);
if (pass < results.length) console.log('未过：' + results.filter((r) => !r.ok).map((r) => r.name).join('、'));
process.exit(pass === results.length ? 0 : 1);
