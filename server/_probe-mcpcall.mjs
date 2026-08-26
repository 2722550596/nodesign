// _probe-mcpcall.mjs — 用 SDK 的 mcp_call 控制通道直接调 boot_memory（绕过模型回合），
// 量 SDK MCP client 层返回的文本长度，判断截断是否发生在这层。
//   node --env-file=.env server/_probe-mcpcall.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import { externalMcpServers } from './engine/mcp/external.js';

const q = query({
  prompt: '（探针）',
  options: {
    maxTurns: 0,
    mcpServers: externalMcpServers(),
    permissionMode: 'bypassPermissions',
    env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'probe', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  },
});

// 消费主流 + 捕捉 mcp_call 相关事件
const events = [];
(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') { events.push(m); break; }
  }
})();

// 等 init 出现
const deadline = Date.now() + 15000;
while (!events.some((e) => e.subtype === 'init')) {
  if (Date.now() > deadline) { console.log('✗ init 未出现'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}
console.log('init OK，发起 mcp_call ...');

try {
  const res = await q.request({ subtype: 'mcp_call', tool: 'mcp__nocturne_memory__boot_memory', arguments: { action: 'list' } });
  console.log('request 返回类型:', typeof res, Array.isArray(res) ? 'array' : (res?.constructor?.name || ''), res && typeof res === 'object' ? Object.keys(res).slice(0, 10).join(',') : '');
  console.log('request 返回（截断 400 字）:', JSON.stringify(res).slice(0, 400));
} catch (e) {
  console.log('✗ mcp_call 抛错:', e?.message || String(e).slice(0, 300));
}
await q.interrupt().catch(() => {});
setTimeout(() => process.exit(0), 500);