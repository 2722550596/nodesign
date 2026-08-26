// _probe-ns-debug.mjs
const BASE = 'http://127.0.0.1:8233';
const res = await fetch(`${BASE}/sse`, { headers: { 'Accept': 'text/event-stream', 'X-Namespace': 'elias' } });
console.log('GET /sse ->', res.status);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = ''; let session = null;
const t0 = Date.now();
const timer = setInterval(() => { if (Date.now() - t0 > 8000) { console.log('✗ 8s 内没拿到 endpoint'); process.exit(1); } }, 1000);
while (!session) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  console.log('chunk:', JSON.stringify(buf.slice(-200)));
  if (buf.includes('session_id=')) {
    session = buf.split('session_id=')[1].split(/[^0-9a-f]/)[0];
  }
}
clearInterval(timer);
console.log('session =', session);
const r = await fetch(`${BASE}/messages/?session_id=${session}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dbg', version: '1' } } }) });
console.log('POST initialize ->', r.status);
reader.cancel().catch(() => {});
process.exit(0);