/**
 * _probe-ingress-abort.mjs — 就地重发的两条边界（08-21 夜评审 P1/P2/P3/P4），直连 ingress 不起 CLI。
 *
 * 场景：
 *   abort   客户端收到首批字节就断开 → ingress 必须停手，别再打上游（烧 token 还没人收）
 *   retry5xx 第一发只想不说、重发那发回 429 → 客户端只该收到**一条** error 事件、带人话、然后收场
 *   midErr  上游流中途吐 error 体 → 不许再重发（那条流已经死了）
 *
 * 跑法：node server/_probe-ingress-abort.mjs [abort|retry5xx|midErr|all]
 */
import http from 'node:http';

const PORT = 45241;
const USAGE = { prompt_tokens: 5000, completion_tokens: 300 };
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta, finish = null) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'ox-alpha-free', choices: [{ index: 0, delta, finish_reason: finish }] });

let mode = 'abort';
let calls = 0;
const fake = http.createServer((req, res) => {
  const bufs = [];
  req.on('data', (c) => bufs.push(c));
  req.on('end', () => {
    calls += 1;
    const n = calls;
    if (mode === 'retry5xx' && n >= 2) {
      console.log(`  [fake] #${n} → HTTP 429`);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    if (mode === 'midErr' && n === 1) {
      console.log(`  [fake] #${n} → 流中途 error 体`);
      sse(res, chunk({ role: 'assistant', reasoning_content: '想…' }));
      sse(res, { error: { message: '上游内部错误' } });
      res.end();
      return;
    }
    console.log(`  [fake] #${n} → 只想了没说就断`);
    sse(res, chunk({ role: 'assistant', reasoning_content: '让我想想…' }));
    sse(res, { ...chunk({}, null), usage: USAGE });
    setTimeout(() => { try { res.end(); } catch { /* */ } }, 30);
  });
});
await new Promise((r) => fake.listen(PORT, '127.0.0.1', r));

process.env.NODESIGN_UPSTREAM_ZEN_GO_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.NODESIGN_UPSTREAM_ZEN_KEY = 'probe-fake-key';
const { getOrStartIngress, registerIngressSession, stopIngress } = await import('./lib/model-ingress.js');
const { baseUrl } = await getOrStartIngress();

const ask = (sid, { abortAfterFirstChunk = false } = {}) => new Promise((resolve) => {
  registerIngressSession(sid, 'ox-alpha');
  const body = JSON.stringify({
    model: 'claude-opus-4-8[1m]', stream: true, max_tokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: '说一句话' }] }],
  });
  const u = new URL(`${baseUrl}/__nd/${encodeURIComponent(sid)}/v1/messages`);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let raw = '';
    res.on('data', (c) => {
      raw += c.toString();
      if (abortAfterFirstChunk) { req.destroy(); resolve({ status: res.statusCode, raw, aborted: true }); }
    });
    res.on('end', () => resolve({ status: res.statusCode, raw, aborted: false }));
    res.on('error', () => resolve({ status: res.statusCode, raw, aborted: true }));
  });
  req.on('error', () => resolve({ status: 0, raw: '', aborted: true }));
  req.write(body); req.end();
});

const events = (raw) => (raw.match(/event: (\w+)/g) || []).map((s) => s.slice(7));
const pf = (b) => (b ? 'PASS' : 'FAIL');
const which = process.argv[2] || 'all';
const results = [];

for (const m of which === 'all' ? ['abort', 'retry5xx', 'midErr'] : [which]) {
  mode = m; calls = 0;
  console.log(`\n===== ${m} =====`);
  const r = await ask(`probe-${m}-${Date.now()}`, { abortAfterFirstChunk: m === 'abort' });
  await new Promise((res) => setTimeout(res, 4000));   // 给"还在偷偷重发"留出暴露时间
  const evs = events(r.raw);
  console.log(`  上游被打 ${calls} 发；客户端事件 [${evs.join(',')}]`);
  let checks;
  if (m === 'abort') {
    checks = [['⛔ 客户端一走就停手（上游只该 1 发）', calls === 1]];
  } else if (m === 'retry5xx') {
    const errs = evs.filter((e) => e === 'error').length;
    const msg = (r.raw.match(/"message":"([^"]*)"/) || [])[1] || '';
    console.log(`  错误文案：${msg.slice(0, 80)}`);
    checks = [
      ['重发那发 429 → 只发一条 error 事件（不是两条）', errs === 1],
      ['文案是人话不是原始 JSON', !msg.includes('\\"error\\"') && msg.includes('rate limited')],
      ['上游一共 2 发（1 + 1 次重发就撞 429 收场）', calls === 2],
    ];
  } else {
    checks = [
      ['⛔ 流中途 error 之后不再重发（上游只该 1 发）', calls === 1],
      ['客户端收到 error 事件', evs.includes('error')],
      ['error 之后不再补 message_stop（协议上流已结束）', !evs.slice(evs.indexOf('error')).includes('message_stop')],
    ];
  }
  for (const [name, ok] of checks) console.log(`  [${pf(ok)}] ${name}`);
  results.push(checks.every(([, ok]) => ok));
}

await stopIngress();
fake.close();
console.log(`\nOVERALL: ${results.every(Boolean) ? 'PASS' : 'FAIL'}`);
process.exit(results.every(Boolean) ? 0 : 2);
