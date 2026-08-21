/**
 * upstream-fail-streak.test.js —— 会话连续失败计数 + 转发层真报结果（本地假上游）。
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { FailStreaks, exhaustedErrorBody, failStreakMax } from './upstream-fail-streak.js';
import { forwardOpenAIChat } from './forward-openai-chat.js';

describe('FailStreaks', () => {
  it('累加、成功清零、到上限 exhausted、consume 归零', () => {
    const s = new FailStreaks({ max: 3 });
    expect(s.exhausted('a')).toBe(false);
    expect(s.note('a', false, 'HTTP 503')).toBe(1);
    expect(s.note('a', false, 'HTTP 503')).toBe(2);
    expect(s.exhausted('a')).toBe(false);
    expect(s.note('a', true)).toBe(0);          // 一次成功清零
    expect(s.note('a', false, 'x')).toBe(1);
    expect(s.note('a', false, 'y')).toBe(2);
    expect(s.note('a', false, 'z')).toBe(3);
    expect(s.exhausted('a')).toBe(true);
    expect(s.exhausted('b')).toBe(false);       // 别的会话不受影响
    expect(s.consume('a')).toMatchObject({ n: 3, reason: 'z' });
    expect(s.exhausted('a')).toBe(false);       // 消费后归零，下次有新机会
    expect(s.note(null, false, 'no sid')).toBe(0);
  });
  it('超过衰减窗没有新失败 → 清零', () => {
    let t = 1000; const s = new FailStreaks({ max: 2, decayMs: 100, now: () => t });
    s.note('a', false, '1'); s.note('a', false, '2');
    expect(s.exhausted('a')).toBe(true);
    t += 200;
    expect(s.exhausted('a')).toBe(false);
    expect(s.note('a', false, '3')).toBe(1);    // 重新从 1 数
  });
  it('上限读 env，非法值回默认 4；拒绝体是 400 该有的 invalid_request_error 形状', () => {
    expect(failStreakMax({})).toBe(4);
    expect(failStreakMax({ NODESIGN_UPSTREAM_FAIL_STREAK: '7' })).toBe(7);
    expect(failStreakMax({ NODESIGN_UPSTREAM_FAIL_STREAK: '0' })).toBe(4);
    const b = exhaustedErrorBody({ label: 'Zen', n: 4, reason: 'HTTP 503' });
    expect(b.error.type).toBe('invalid_request_error');
    expect(b.error.message).toMatch(/Zen 连续 4 次/);
  });
});

// ── 转发层：每种结局都报 onOutcome ──

function fakeUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function fakeRes() {
  const pt = new PassThrough();
  const out = { status: null, chunks: [] };
  pt.writeHead = (status) => { out.status = status; };
  pt.on('data', (c) => out.chunks.push(c.toString()));
  const done = new Promise((r) => pt.on('finish', r));
  return { res: pt, out, done };
}
async function runForward({ port, stream }) {
  const outcomes = [];
  const { res, out, done } = fakeRes();
  forwardOpenAIChat({
    parsed: { model: 'm', stream, messages: [{ role: 'user', content: 'hi' }] },
    wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } },
    key: 'k', res, sidShort: 'test', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false,
    onOutcome: (ok, reason) => outcomes.push([ok, reason]),
  });
  await done;
  return { outcomes, out };
}

describe('forwardOpenAIChat 报结果', () => {
  it('上游 503 → onOutcome(false, "HTTP 503")', async () => {
    const { srv, port } = await fakeUpstream((req, res) => { res.writeHead(503); res.end(''); });
    try {
      const { outcomes, out } = await runForward({ port, stream: false });
      expect(out.status).toBe(503);
      expect(outcomes).toEqual([[false, 'HTTP 503']]);
    } finally { srv.close(); }
  });
  it('流式：私货 finish_reason 且零可见输出 → false；有正文 → true', async () => {
    const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const { srv, port } = await fakeUpstream((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (/WANTTEXT/.test(body)) {
          sse(res, { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '好' }, finish_reason: null }] });
          sse(res, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else {
          sse(res, { id: 'x', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'network_error' }] });
        }
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    try {
      const bad = await runForward({ port, stream: true });
      expect(bad.outcomes.length).toBe(1);
      expect(bad.outcomes[0][0]).toBe(false);
      expect(bad.outcomes[0][1]).toMatch(/network_error/);
      expect(bad.out.chunks.join('')).toMatch(/event: error/);

      const outcomes = [];
      const { res, out, done } = fakeRes();
      forwardOpenAIChat({
        parsed: { model: 'm', stream: true, messages: [{ role: 'user', content: 'WANTTEXT' }] },
        wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } },
        key: 'k', res, sidShort: 'test', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false,
        onOutcome: (ok, reason) => outcomes.push([ok, reason]),
      });
      await done;
      expect(outcomes).toEqual([[true, '']]);
      expect(out.chunks.join('')).toMatch(/message_stop/);
    } finally { srv.close(); }
  });
  it('非流式：200 但零 choices → false；有内容 → true', async () => {
    const { srv, port } = await fakeUpstream((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(/WANTTEXT/.test(body)
          ? { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: {} }
          : { id: 'x', choices: [], usage: {} }));
      });
    });
    try {
      const bad = await runForward({ port, stream: false });
      expect(bad.out.status).toBe(502);
      expect(bad.outcomes[0][0]).toBe(false);
      const outcomes = [];
      const { res, out, done } = fakeRes();
      forwardOpenAIChat({
        parsed: { model: 'm', stream: false, messages: [{ role: 'user', content: 'WANTTEXT' }] },
        wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } },
        key: 'k', res, sidShort: 'test', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false,
        onOutcome: (ok, reason) => outcomes.push([ok, reason]),
      });
      await done;
      expect(out.status).toBe(200);
      expect(outcomes).toEqual([[true, undefined]]);
    } finally { srv.close(); }
  });
  it('连不上上游 → onOutcome(false, "forward: …")', async () => {
    const { srv, port } = await fakeUpstream(() => {});
    srv.close();
    const { outcomes, out } = await runForward({ port, stream: false });
    expect(out.status).toBe(502);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0][0]).toBe(false);
    expect(outcomes[0][1]).toMatch(/^forward: /);
  });
});
