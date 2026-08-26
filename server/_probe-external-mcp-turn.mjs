// _probe-external-mcp-turn.mjs — 真回合验证：生产同款 ingress 接入，模型只列 MCP 服务器与工具名（不调用）。
// 断言：init 的 mcp_servers 含 nocturne_memory，回复里出现 mcp__nocturne_memory__ 前缀工具名。
//   node --env-file=.env server/_probe-external-mcp-turn.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartIngress, registerIngressSession, stopIngress } from './lib/model-ingress.js';
import { resolveModelRoute, pickThinkingConfig } from './engine/agent/model-context.js';
import { externalMcpServers, externalMcpAllowRules } from './engine/mcp/external.js';

const APP = process.argv[2] || 'ox-alpha';
const route = resolveModelRoute(APP);
const { baseUrl } = await getOrStartIngress();
const SID = `mcpProbe-${Date.now()}`;
registerIngressSession(SID, APP);
console.log(`路由: ${APP} → ${route.sdkAlias} via ${baseUrl} | 外部 servers/allow:`, JSON.stringify(externalMcpServers()), JSON.stringify(externalMcpAllowRules()));

let initMcp = null; let finalText = ''; let sawMcpTool = false;
try {
  const q = query({
    prompt: '不要调用任何工具。列出你的 mcpServers（init 信息里的服务器名），以及其中名字带 nocturne 的前缀工具名（形如 mcp__<服务器>__<工具>）。',
    options: {
      model: route.sdkAlias,
      thinking: pickThinkingConfig(APP),
      env: { ...process.env, ANTHROPIC_BASE_URL: `${baseUrl}/__nd/${encodeURIComponent(SID)}`, ANTHROPIC_API_KEY: 'nd-ingress-managed', ANTHROPIC_SMALL_FAST_MODEL: route.fastModel, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(route.window) },
      mcpServers: externalMcpServers(),
      permissionMode: 'bypassPermissions',
      maxTurns: 1,
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') { initMcp = m.mcpServers || null; }
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) finalText = b.text;
        if (b.type === 'tool_use' && b.name?.startsWith('mcp__nocturne_memory__')) sawMcpTool = true;
      }
    }
  }
} catch (e) { console.log('✗ SDK 循环抛错：', e?.message || e); }

console.log('init.mcp_servers =', JSON.stringify(initMcp));
console.log('模型回复（前 400 字）：\n' + finalText.slice(0, 400));
console.log(`✓ init 已带 nocturne_memory server: ${JSON.stringify(initMcp)?.includes('nocturne_memory')}`);
console.log(`✓ 回复出现 mcp__nocturne_memory__ 前缀: ${/mcp__nocturne_memory__/.test(finalText)}`);
await stopIngress();
process.exit(/mcp__nocturne_memory__/.test(finalText) && JSON.stringify(initMcp)?.includes('nocturne_memory') ? 0 : 1);