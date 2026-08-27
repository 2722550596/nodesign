/**
 * AskUserQuestion 挂起态回归（M2 方案 A）：
 *   - ask-registry：register/answer/cancel 生命周期 + 重复 register 拒绝
 *   - sidecar /ask：鉴权、参数校验、长轮询阻塞到 answer、run.ask_user_question 事件、
 *     连接断开清挂起态
 * 不碰生产库：pid 用不存在的 id；DB_PATH 由 vitest.server.config.js 指 tmp。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createSidecarRouter, sidToken } from './sidecar.js';
import {
  registerAsk, getPendingAsk, answerAsk, cancelAsksForSession, cancelAskById, _pendingAskCount,
} from './ask-registry.js';

process.env.NODESIGN_SIDECAR_SECRET = 'test-ask-secret';

const SID = 'sess_ask_t1';
const PID = 'proj_nonexistent_ask';
const TOKEN = sidToken(SID);

const published = [];
const stubBus = { publish: (e) => published.push(e) };
const app = express();
app.use(express.json());
app.use('/__nd-sidecar', createSidecarRouter({ getBus: () => stubBus }));

let server;
let base;

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/__nd-sidecar`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  // 清残留挂起（用例间隔离）
  for (const sid of [SID, 'sess_ask_t2']) cancelAsksForSession(sid, 'test_reset');
  published.length = 0;
});

// ── ask-registry 单元 ──

describe('ask-registry', () => {
  it('register → pending 可查；answer → resolve + 清挂起', async () => {
    const entry = registerAsk({ sid: SID, runId: 'run_1', questions: { q: 1 } });
    expect(entry.askId).toMatch(/^ask_/);
    expect(getPendingAsk(SID)).toMatchObject({ askId: entry.askId, runId: 'run_1' });

    expect(answerAsk(SID, [{ selectedLabels: ['A'] }])).toBe(true);
    await expect(entry.promise).resolves.toEqual([{ selectedLabels: ['A'] }]);
    expect(getPendingAsk(SID)).toBeNull();
    expect(answerAsk(SID, {})).toBe(false);   // 已答过，二次 answer 无效
  });

  it('同 sid 重复 register 拒绝', () => {
    expect(registerAsk({ sid: SID, questions: {} })).toBeTruthy();
    expect(registerAsk({ sid: SID, questions: {} })).toBeNull();
    cancelAsksForSession(SID);
  });

  it('cancelAsksForSession reject 挂起 Promise', async () => {
    const entry = registerAsk({ sid: SID, questions: {} });
    expect(cancelAsksForSession(SID, 'user_cancel')).toBe(1);
    await expect(entry.promise).rejects.toThrow(/user_cancel/);
    expect(cancelAsksForSession(SID)).toBe(0);   // 幂等
  });

  it('cancelAskById 只中对应 ask', async () => {
    const e1 = registerAsk({ sid: 'sess_ask_t2', questions: {} });
    expect(cancelAskById(e1.askId)).toBe(true);
    await expect(e1.promise).rejects.toThrow(/connection_closed/);
    expect(cancelAskById('ask_nonexistent')).toBe(false);
  });
});

// ── sidecar /ask HTTP 层 ──

describe('sidecar /ask', () => {
  it('无 token → 401', async () => {
    const res = await fetch(`${base}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: SID, pid: PID, questions: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('questions 缺失 → 400', async () => {
    const res = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID, pid: PID }),
    });
    expect(res.status).toBe(400);
  });

  it('长轮询：阻塞到 answer 才返回 + emit run.ask_user_question', async () => {
    const askPromise = fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID, pid: PID, questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] }),
    }).then(async (res) => ({ status: res.status, data: await res.json() }));

    // 事件已发（/ask 挂起前 publish）
    await new Promise((r) => setTimeout(r, 50));
    const evt = published.find((e) => e.type === 'run.ask_user_question');
    expect(evt).toBeTruthy();
    expect(evt.sessionId).toBe(SID);
    expect(evt.askId).toMatch(/^ask_/);
    expect(evt.questions).toHaveLength(1);

    // 还没答：promise 未 settle
    let settled = false;
    askPromise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    // 答 → 返回 answers
    expect(answerAsk(SID, [{ selectedLabels: ['B'] }])).toBe(true);
    const { status, data } = await askPromise;
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.answers).toEqual([{ selectedLabels: ['B'] }]);
  });

  it('挂起被 cancel → 503', async () => {
    const askPromise = fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID, pid: PID, questions: [{ question: 'q' }] }),
    }).then(async (res) => ({ status: res.status, data: await res.json() }));

    await new Promise((r) => setTimeout(r, 50));
    cancelAsksForSession(SID, 'user_cancel');
    const { status } = await askPromise;
    expect(status).toBe(503);
  });

  it('并发第二个 ask → 409', async () => {
    const first = fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID, pid: PID, questions: [{ question: 'q1' }] }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID, pid: PID, questions: [{ question: 'q2' }] }),
    });
    expect(res2.status).toBe(409);

    answerAsk(SID, []);
    await first;
  });

  it('HTTP 连接断开 → 挂起态清掉', async () => {
    const controller = new AbortController();
    const fetchPromise = fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sid: SID, pid: PID, questions: [{ question: 'q' }] }),
      signal: controller.signal,
    }).catch(() => 'aborted');

    await new Promise((r) => setTimeout(r, 50));
    expect(getPendingAsk(SID)).toBeTruthy();
    controller.abort();
    await fetchPromise;
    await new Promise((r) => setTimeout(r, 50));   // req 'close' 事件异步到达
    expect(getPendingAsk(SID)).toBeNull();
    expect(_pendingAskCount()).toBe(0);
  });
});
