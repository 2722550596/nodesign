// _probe-ns.mjs — SSE MCP 客户端：验证 X-Namespace header 是否作用到查询。
// 对比：带 header (elias) vs 不带 header（默认空间）各调一次 recent_memories，
// 看返回内容是否落在不同 namespace（对照 DB 里 namespace 列的真实归属）。
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:8233';

async function sseCall(headerNs, toolName, args, timeoutMs = 20000) {
  const headers = { 'Accept': 'text/event-stream' };
  if (headerNs) headers['X-Namespace'] = headerNs;
  const res = await fetch(`${BASE}/sse`, { headers });
  if (!res.ok) throw new Error(`GET /sse -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let endpointSession = null;
  const pending = new Map();          // id -> resolve
  const t0 = Date.now();

  const send = (id, method, params) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return fetch(`${BASE}/messages/?session_id=${endpointSession}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  };

  // initialize 在 endpoint session 确定后发
  const initReady = new Promise((resolve) => { pending._initReady = resolve; });

  const loop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = {}; let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (ev.event === 'endpoint') {
          endpointSession = data.split('session_id=')[1]?.trim();
          pending._initReady(endpointSession);
        } else if (ev.event === 'message' && data) {
          let msg; try { msg = JSON.parse(data); } catch { continue; }
          if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        }
      }
      if (Date.now() - t0 > timeoutMs) break;
    }
  })();

  await initReady;
  // initialize + initialized 通知 + 工具调用
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    send(myId, method, params).then((r) => { if (!r.ok) reject(new Error(`POST ${r.status}`)); }).catch(reject);
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout')); } }, timeoutMs);
  });
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ns-probe', version: '1' } });
  // ⚠️ initialized 通知必须：无 id（有 id = 被当 request 解析 → 永不初始化）且先于工具请求到达
  await fetch(`${BASE}/messages/?session_id=${endpointSession}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const tool = await call('tools/call', { name: toolName, arguments: args });
  reader.cancel().catch(() => {});
  return { init: init.result?.serverInfo, raw: tool.result ?? tool.error };
}

const textOf = (r) => JSON.stringify(r).slice(0, 500);

try {
  const a = await sseCall('elias', 'recent_memories', { limit: 5 });
  console.log('── 带 X-Namespace: elias ──');
  console.log(textOf(a.raw));
  const b = await sseCall(null, 'recent_memories', { limit: 5 });
  console.log('── 不带 header（默认空间）──');
  console.log(textOf(b.raw));
} catch (e) {
  console.log('✗', e.message);
  process.exit(1);
}