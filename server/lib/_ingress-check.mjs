/**
 * server/lib/_ingress-check.mjs — model-ingress 真跑校验。
 *
 * 对照组 = 08-19 探针（server/_probe-gemini-relay.mjs）的已知结论：
 * 中转站 Gemini 桥会把 tool_result 里的图转成文本（模型只能瞎编）。
 * 本校验把同样的请求穿过新入口 —— lift 修补生效则模型答出 ND-7342/三角/黄。
 *
 * 用法：node server/lib/_ingress-check.mjs [--sdk]
 *   默认只跑裸 HTTP 半（快、便宜）；--sdk 追加真 claude-agent-sdk 端到端
 *  （验证 helper/fastModel/alias 全链路，一次约 $0.2-0.4 中转站消耗）。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ⛔ 先把库指走再 import 任何 server 模块（测试写生产库旧案）。本脚本的
// import 链目前不含 store.js，但军规不赌 import 链的未来。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-ingress-check-'));
process.env.DB_PATH = path.join(TMP, 'check.db');

// 上游钥匙：生产走 .env；校验脚本直接从钥匙文件读，不依赖 .env 配好
if (!process.env.NODESIGN_UPSTREAM_LAMENT_KEY) {
  const lines = fs.readFileSync(path.join(os.homedir(), 'apikey/gemini_bangongyi.txt'), 'utf8').split('\n');
  process.env.NODESIGN_UPSTREAM_LAMENT_KEY = lines[2].trim();
}

const { getOrStartIngress, stopIngress, registerIngressSession } = await import('./model-ingress.js');
const { resolveSdkSpoofModel } = await import('../engine/agent/model-context.js');
const sharp = (await import('sharp')).default;

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`);
}

// 已知真值测试图（同探针）：深蓝底 + 黄三角 + ND-7342
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
  <rect width="480" height="320" fill="#102040"/>
  <polygon points="240,40 120,220 360,220" fill="#ffd21e"/>
  <text x="240" y="285" font-size="44" font-family="monospace" fill="#ffffff" text-anchor="middle">ND-7342</text>
</svg>`;
const pngB64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');

const ingress = await getOrStartIngress();
const BASE = `${ingress.baseUrl}/__nd/${encodeURIComponent('ingress-check-session')}`;

async function viaIngress(body, subPath = '') {
  const res = await fetch(`${BASE}/v1/messages${subPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'nd-ingress-managed', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE / plain */ }
  return { status: res.status, json, text };
}
const textOf = (j) => (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

const ALIAS_STRIPPED = resolveSdkSpoofModel('gemini-3.1-pro').replace(/\[1m\]$/i, '');
const PEEK_TOOL = {
  name: 'peek_screen',
  description: 'Take a screenshot of the current screen and return it as an image.',
  input_schema: { type: 'object', properties: {} },
};

// ── 1. 死案复活：tool_result 图片穿入口（alias 形态的 model 名）──
{
  const r1 = await viaIngress({
    model: ALIAS_STRIPPED, max_tokens: 1500, tools: [PEEK_TOOL],
    messages: [{ role: 'user', content: '调用 peek_screen 看一眼屏幕，然后告诉我图里的文字、形状、颜色。' }],
  });
  const toolUse = (r1.json?.content || []).find((b) => b.type === 'tool_use');
  check('1a alias 路由 + tool_use 发起', r1.status === 200 && !!toolUse, `${r1.status} stop=${r1.json?.stop_reason}`);

  if (toolUse) {
    const r2 = await viaIngress({
      model: ALIAS_STRIPPED, max_tokens: 4000, tools: [PEEK_TOOL],
      messages: [
        { role: 'user', content: '调用 peek_screen 看一眼屏幕，然后告诉我图里的文字、形状、颜色。' },
        { role: 'assistant', content: r1.json.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: toolUse.id,
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } }],
          }],
        },
      ],
    });
    const out = textOf(r2.json);
    check('1b ⭐死案复活：入口 lift 后模型看见真图',
      r2.status === 200 && /7342/.test(out) && /(三角|triangle)/i.test(out),
      `${r2.status}「${out.slice(0, 80)}」`);
  } else {
    check('1b ⭐死案复活：入口 lift 后模型看见真图', false, '1a 未发起工具调用');
  }
}

// ── 2. appModel 形态直呼（SMALL_FAST_MODEL 走的路）──
{
  const r = await viaIngress({
    model: 'gemini-3.1-pro', max_tokens: 200,
    messages: [{ role: 'user', content: '只回两个字：收到' }],
  });
  check('2 appModel 直呼路由', r.status === 200 && /收到/.test(textOf(r.json)), `${r.status}`);
}

// ── 3. count_tokens 本地短路（lament 表内标了没有该端点）──
{
  const r = await viaIngress({ model: ALIAS_STRIPPED, messages: [{ role: 'user', content: 'hello '.repeat(500) }] }, '/count_tokens');
  const n = r.json?.input_tokens;
  check('3 count_tokens 本地估算', r.status === 200 && n > 300 && n < 3000, `${r.status} input_tokens=${n}`);
}

// ── 4. 未知模型 fail-loud（未注册会话）──
{
  const r = await viaIngress({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
  check('4 未注册会话的未知名 502 拒绝（不盲转发）', r.status === 502 && /no route/.test(r.text), `${r.status}`);
}

// ── 4b. 注册过的会话：未知 Claude 名走 fast 兜底（SDK helper 复活的机制）──
{
  registerIngressSession('ingress-check-session', 'gemini-3.1-pro');
  const r = await viaIngress({
    model: 'claude-sonnet-5', max_tokens: 200,
    messages: [{ role: 'user', content: '只回两个字：好的' }],
  });
  check('4b 会话 fast 兜底路由（helper 名改道）', r.status === 200 && /好的/.test(textOf(r.json)), `${r.status}「${textOf(r.json).slice(0, 20)}」`);
}

// ── 5.（--sdk）真 SDK 端到端：alias 喂 SDK、helper 走 appModel、工具回图 ──
if (process.argv.includes('--sdk')) {
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  let toolCalled = 0;
  const probeServer = createSdkMcpServer({
    name: 'probe', version: '1.0.0',
    tools: [tool('peek_screen', 'Take a screenshot of the current screen and return it as an image.', {}, async () => {
      toolCalled += 1;
      return { content: [{ type: 'image', data: pngB64, mimeType: 'image/png' }] };
    })],
  });
  let finalText = '';
  let resultMsg = null;
  try {
    const q = query({
      prompt: '调用 peek_screen 工具看一眼屏幕，然后告诉我：图片里写着什么文字、什么形状、什么颜色。',
      options: {
        model: resolveSdkSpoofModel('gemini-3.1-pro'),
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: BASE,
          ANTHROPIC_API_KEY: 'nd-ingress-managed',
          ANTHROPIC_SMALL_FAST_MODEL: 'gemini-3.1-pro',
        },
        mcpServers: { probe: probeServer },
        allowedTools: ['mcp__probe__peek_screen'],
        permissionMode: 'bypassPermissions',
        maxTurns: 4,
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) finalText = b.text;
        }
      } else if (m.type === 'result') resultMsg = m;
    }
    check('5a SDK 循环穿入口进工具', toolCalled > 0, `调了 ${toolCalled} 次`);
    check('5b ⭐SDK 端到端看见真图（对照：直连时此项恒✗）',
      /7342/.test(finalText) && /(三角|triangle)/i.test(finalText),
      `「${finalText.slice(0, 80)}」`);
    const usedModels = Object.keys(resultMsg?.modelUsage || {});
    console.log(`   modelUsage keys=[${usedModels.join(', ')}] cost(SDK虚价)=$${resultMsg?.total_cost_usd}`);
  } catch (e) {
    check('5a SDK 循环穿入口进工具', false, e?.message || String(e));
    check('5b ⭐SDK 端到端看见真图（对照：直连时此项恒✗）', false, '同上');
  }
}

await stopIngress();
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ingress-check: ${results.length - bad.length}/${results.length} 通过 =====`);
if (bad.length) process.exitCode = 1;
