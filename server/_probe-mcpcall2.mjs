import { query } from '@anthropic-ai/claude-agent-sdk';
const { externalMcpServers } = await import('./engine/mcp/external.js');
const q = query({ prompt: '（探针）', options: { maxTurns: 0, mcpServers: externalMcpServers(), permissionMode: 'bypassPermissions',
  env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'probe', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } } });
const stream = (async () => { for await (const m of q) { /* drain */ } })();
await new Promise(r => setTimeout(r, 6000));   // 等 transport 完全 ready
try {
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 20000);
    q.request({ subtype: 'mcp_call', tool: 'mcp__nocturne_memory__boot_memory', arguments: { action: 'list' } })
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
  const txt = typeof res === 'string' ? res : JSON.stringify(res);
  console.log('mcp_call 返回类型:', typeof res, '| 原始 JSON 长度:', txt.length);
  console.log('前 200 字:', JSON.stringify(txt.slice(0, 200)));
} catch (e) { console.log('✗', e?.message || String(e).slice(0, 400)); }
q.interrupt?.().catch(() => {});
setTimeout(() => process.exit(0), 400);
