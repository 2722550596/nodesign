/**
 * server/_probe-gemini-sdk.mjs — Phase 2：真 claude-agent-sdk 循环打中转站 Gemini。
 *
 * 验的是裸协议探针（_probe-gemini-relay.mjs）验不了的三件事：
 *   1. SDK binary 对 count_tokens 404 的反应（中转站没这端点，生产上我们的
 *      binary-fixup-proxy 会本地伪造；这里故意裸连，看不伪造会不会死）。
 *   2. 反重力通道流式 stop_reason=end_turn 的 bug，SDK 到底认块还是认 stop_reason
 *      —— 认块则工具照跑，认 stop_reason 则循环断在第一轮。
 *   3. 我们 zod 生成的工具 schema + 整段 Claude Code 系统提示词，Gemini 吃不吃。
 *
 * 用法：node server/_probe-gemini-sdk.mjs [modelId]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

function resolveTarget() {
  if (process.env.PROBE_BASE) {
    return { BASE: process.env.PROBE_BASE.replace(/\/+$/, ''), KEY: process.env.PROBE_KEY || 'no-auth' };
  }
  const lines = fs.readFileSync(path.join(os.homedir(), 'apikey/gemini_bangongyi.txt'), 'utf8').split('\n');
  return { BASE: lines[0].trim().replace(/\/+$/, ''), KEY: lines[2].trim() };
}
const { BASE, KEY } = resolveTarget();
const MODEL = process.argv[2] || '中转-gemini-3.1-pro-preview';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
  <rect width="480" height="320" fill="#102040"/>
  <polygon points="240,40 120,220 360,220" fill="#ffd21e"/>
  <text x="240" y="285" font-size="44" font-family="monospace" fill="#ffffff" text-anchor="middle">ND-7342</text>
</svg>`;
const pngB64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');

let toolCalled = 0;
const probeServer = createSdkMcpServer({
  name: 'probe',
  version: '1.0.0',
  tools: [
    tool('peek_screen', 'Take a screenshot of the current screen and return it as an image.', {}, async () => {
      toolCalled += 1;
      return { content: [{ type: 'image', data: pngB64, mimeType: 'image/png' }] };
    }),
  ],
});

console.log(`===== SDK e2e: ${MODEL} @ ${BASE} =====`);
const t0 = Date.now();
let finalText = '';
let resultMsg = null;

try {
  const q = query({
    prompt: '调用 peek_screen 工具看一眼屏幕，然后告诉我：图片里写着什么文字、画的是什么形状、什么颜色。',
    options: {
      model: MODEL,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: BASE,
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_SMALL_FAST_MODEL: MODEL,
      },
      mcpServers: { probe: probeServer },
      allowedTools: ['mcp__probe__peek_screen'],
      permissionMode: 'bypassPermissions',
      maxTurns: 4,
    },
  });

  for await (const m of q) {
    if (m.type === 'assistant') {
      const kinds = (m.message?.content || []).map((b) => b.type).join(',');
      const stop = m.message?.stop_reason;
      console.log(`  [assistant] blocks=[${kinds}] stop=${stop}`);
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) finalText = b.text;
        if (b.type === 'tool_use') console.log(`    tool_use → ${b.name}`);
      }
    } else if (m.type === 'result') {
      resultMsg = m;
    } else if (m.type === 'system' && m.subtype === 'init') {
      console.log(`  [init] model=${m.model} tools=${(m.tools || []).length}`);
    } else {
      console.log(`  [${m.type}${m.subtype ? '/' + m.subtype : ''}]`);
    }
  }
} catch (e) {
  console.log('✗ SDK 循环抛错：', e?.message || e);
  process.exit(1);
}

const ms = Date.now() - t0;
const sawText = /7342/.test(finalText);
const sawShape = /(三角|triangle)/i.test(finalText);
console.log(`\n工具被真调了 ${toolCalled} 次；总耗时 ${Math.round(ms / 1000)}s`);
console.log(`最终回答（前 160 字）：「${finalText.slice(0, 160)}」`);
console.log(`${toolCalled > 0 ? '✓' : '✗'} SDK 循环进了工具`);
console.log(`${sawText && sawShape ? '✓' : '✗'} 回答对上真值（文字${sawText ? '✓' : '✗'} 形状${sawShape ? '✓' : '✗'}）— 注意 SDK 原样透传 tool_result 图片时这里预期是✗（桥会丢图），✓ 反而说明桥修好了`);
if (resultMsg) {
  console.log(`result: subtype=${resultMsg.subtype} turns=${resultMsg.num_turns} cost=$${resultMsg.total_cost_usd}`);
  console.log('modelUsage:', JSON.stringify(resultMsg.modelUsage || {}, null, 0).slice(0, 400));
}
