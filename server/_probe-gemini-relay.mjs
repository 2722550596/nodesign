/**
 * server/_probe-gemini-relay.mjs — 中转站(api.lament0.link) Anthropic 协议 × Gemini 探针。
 *
 * 背景：接非 Claude 模型的第一道闸是 tool_result 里的图片能不能过桥
 * （agent 感知栈全靠工具回图），第二道是 prompt cache 有没有（成本差一个量级）。
 * 08-14 只测过纯文本工具调用；这里把「只有真跑才知道的四条」+ 视觉一次验完。
 *
 * 用法：node server/_probe-gemini-relay.mjs [modelId]
 *   不带参数默认 中转-gemini-3.1-pro-preview。
 * 钥匙从 ~/apikey/gemini_bangongyi.txt 读（1 行 base、3 行 key），不进仓库不打日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const lines = fs.readFileSync(path.join(os.homedir(), 'apikey/gemini_bangongyi.txt'), 'utf8').split('\n');
const BASE = lines[0].trim().replace(/\/+$/, '');
const KEY = lines[2].trim();
const MODEL = process.argv[2] || '中转-gemini-3.1-pro-preview';

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok, note });
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`);
}

async function msg(body, { timeoutMs = 180_000 } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE 或非 JSON */ }
  return { status: res.status, json, text, ms };
}

const textOf = (j) => (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

// ---- 测试图：深蓝底 + 黄色三角 + 文字 ND-7342（已知真值，问答对得上才算看见）----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
  <rect width="480" height="320" fill="#102040"/>
  <polygon points="240,40 120,220 360,220" fill="#ffd21e"/>
  <text x="240" y="285" font-size="44" font-family="monospace" fill="#ffffff" text-anchor="middle">ND-7342</text>
</svg>`;
const pngB64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');

const PEEK_TOOL = {
  name: 'peek_screen',
  description: 'Take a screenshot of the current screen and return it as an image.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

console.log(`\n===== 探针目标: ${MODEL} @ ${BASE} =====\n`);

// ---------- 1. 纯文本 ----------
{
  const r = await msg({ max_tokens: 200, messages: [{ role: 'user', content: '只回两个字：收到' }] });
  check('1 纯文本', r.status === 200 && /收到/.test(textOf(r.json)), `${r.status} ${r.ms}ms「${textOf(r.json).slice(0, 30)}」`);
  if (r.json?.usage) console.log('   usage:', JSON.stringify(r.json.usage));
}

// ---------- 2. 顶层图片（vision 基线）----------
{
  // ⚠️ max_tokens 别给小：Gemini thinking 关不掉且计入 max_tokens，500 会被吃到正文截断
  const r = await msg({
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
        { type: 'text', text: '图里写着什么文字？画的是什么形状、什么颜色？' },
      ],
    }],
  });
  const out = textOf(r.json);
  const ok = r.status === 200 && /7342/.test(out) && /(三角|triangle)/i.test(out);
  check('2 顶层图片 vision', ok, `${r.status} ${r.ms}ms stop=${r.json?.stop_reason}「${out.slice(0, 80)}」`);
}

// ---------- 3. ⭐第一道闸：tool_result 里的图片 ----------
{
  const ask = [{ role: 'user', content: '调用 peek_screen 看一眼屏幕，然后告诉我图片里写着什么文字、是什么形状、什么颜色。' }];
  const r1 = await msg({ max_tokens: 1500, tools: [PEEK_TOOL], messages: ask });
  const toolUse = (r1.json?.content || []).find((b) => b.type === 'tool_use');
  check('3a 模型发起 tool_use', r1.status === 200 && !!toolUse,
    `${r1.status} ${r1.ms}ms stop=${r1.json?.stop_reason} id=${toolUse?.id?.slice(0, 18)}`);

  if (toolUse) {
    const r2 = await msg({
      max_tokens: 4000,
      tools: [PEEK_TOOL],
      messages: [
        ...ask,
        { role: 'assistant', content: r1.json.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } }],
          }],
        },
      ],
    });
    const out = textOf(r2.json);
    const sawText = /7342/.test(out);
    const sawShape = /(三角|triangle)/i.test(out);
    check('3b ⭐tool_result 图片过桥（原样）', r2.status === 200 && sawText && sawShape,
      `${r2.status} ${r2.ms}ms 文字${sawText ? '✓' : '✗'} 形状${sawShape ? '✓' : '✗'}「${out.slice(0, 100)}」`);

    // 3c: 修法验证 —— liftImagesFromToolResult 的形状：tool_result 只留文字占位，
    // 图提升到同一条 user message 的顶层 content。3b 不通 + 3c 通 = 修法成立。
    const r3 = await msg({
      max_tokens: 4000,
      tools: [PEEK_TOOL],
      messages: [
        ...ask,
        { role: 'assistant', content: r1.json.content },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolUse.id, content: [{ type: 'text', text: '截图完成，图片见下方。' }] },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
            { type: 'text', text: '（上面这张就是 peek_screen 返回的截图）' },
          ],
        },
      ],
    });
    const out3 = textOf(r3.json);
    const saw3 = /7342/.test(out3) && /(三角|triangle)/i.test(out3);
    check('3c 修法：图提升到顶层', r3.status === 200 && saw3,
      `${r3.status} ${r3.ms}ms「${out3.slice(0, 100)}」`);
  } else {
    check('3b ⭐tool_result 图片过桥（原样）', false, '3a 没发起工具调用，测不了');
    check('3c 修法：图提升到顶层', false, '同上');
  }
}

// ---------- 4. prompt cache ----------
{
  const filler = '设计系统里的间距、字重、圆角、层级、留白都必须服从同一套刻度，任何一处随手写死的像素值都会在换肤和缩放时变成暗雷。'.repeat(220);
  const body = {
    max_tokens: 100,
    system: [{ type: 'text', text: filler, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '只回两个字：好的' }],
  };
  const a = await msg(body);
  const b = await msg(body);
  const ua = a.json?.usage || {}; const ub = b.json?.usage || {};
  const hit = (ub.cache_read_input_tokens || 0) > 0;
  check('4 prompt cache', hit,
    `第1次 ${JSON.stringify(ua)} → 第2次 ${JSON.stringify(ub)}`);
}

// ---------- 5. max_tokens 钳制 ----------
{
  const r = await msg({ max_tokens: 128_000, messages: [{ role: 'user', content: '只回 OK' }] });
  if (r.status === 200) check('5 max_tokens=128k', true, `${r.ms}ms 直接吃下（不炸）`);
  else {
    const r2 = await msg({ max_tokens: 60_000, messages: [{ role: 'user', content: '只回 OK' }] });
    check('5 max_tokens=128k', false,
      `128k→${r.status}「${r.text.slice(0, 120)}」；60k→${r2.status}（钳制点在 64k 附近，接入要裁）`);
  }
}

// ---------- 6. 流式 tool_use 分片 ----------
{
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500, stream: true, tools: [PEEK_TOOL],
      messages: [{ role: 'user', content: '直接调用 peek_screen，不要说别的。' }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await res.text();
  const events = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => {
    try { return JSON.parse(l.slice(6)); } catch { return null; }
  }).filter(Boolean);
  const types = [...new Set(events.map((e) => e.type))];
  const tuStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
  const jsonParts = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
    .map((e) => e.delta.partial_json).join('');
  let inputOk = false;
  try { JSON.parse(jsonParts || '{}'); inputOk = true; } catch { /* 拼不回 */ }
  const stop = events.find((e) => e.type === 'message_delta')?.delta?.stop_reason;
  check('6 流式 tool_use 分片', res.status === 200 && !!tuStart && inputOk && stop === 'tool_use',
    `${res.status} ${Date.now() - t0}ms 事件类型=[${types.join(',')}] stop=${stop} input拼回=${inputOk}`);
}

// ---------- 7. count_tokens 端点 ----------
{
  const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '数一数' }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const t = await res.text();
  check('7 count_tokens', res.status === 200, `${res.status}「${t.slice(0, 100)}」（非 200 则接入侧继续本地伪造）`);
}

// ---------- 汇总 ----------
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${MODEL}: ${results.length - bad.length}/${results.length} 项通过 =====`);
if (bad.length) { console.log('未过：' + bad.map((b) => b.name).join('、')); process.exitCode = 1; }
