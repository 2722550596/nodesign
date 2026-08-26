/**
 * turn-relay：M1 pi-rp 严格串行语义（一条消息 = 一个 turn）。
 *
 * 被钉住的语义（机制全文见 turn-relay.js 文件头）：
 *   - push 时 idle → 立即成为 current（queued=false），depth 0
 *   - push 时 busy（有 current 或有 pending）→ 排队（queued=true），depth +1，FIFO
 *   - takeNextRunId 按入队顺序提升队头；队列空 → current 置 null
 *   - drainSession 把排队的 run 标 failed 并清空 pending
 *   - 不再有 uuid / claim / merge（SDK 并轮机制作废）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AsyncQueue } from '../../lib/async-queue.js';
import { registerQuerySession, unregisterQuerySession, getCurrentTurnRunId } from './active-runs.js';
import { createRun, getRun } from './store.js';
import {
  pushUserMessage, takeNextRunId, getPendingRunCount, getQueueDepth, drainSession,
} from './turn-relay.js';

const SID = 'test-session-serial';
let queue;
const msg = (text = 'hi') => ({ text, images: [] });

beforeEach(() => {
  queue = new AsyncQueue();
  registerQuerySession(SID, { abortController: new AbortController(), inputQueue: queue });
});
afterEach(() => { unregisterQuerySession(SID); });

describe('pushUserMessage', () => {
  it('idle 时直设 current，queued=false，depth 0', () => {
    expect(pushUserMessage(SID, 'run-1', msg())).toEqual({ queued: false });
    expect(getCurrentTurnRunId(SID)).toBe('run-1');
    expect(getPendingRunCount(SID)).toBe(0);
    expect(getQueueDepth(SID)).toBe(0);
  });

  it('turn 进行中 push → 排队 queued=true，不抢占 current，depth +1', () => {
    pushUserMessage(SID, 'run-1', msg());
    expect(pushUserMessage(SID, 'run-2', msg())).toEqual({ queued: true });
    expect(getCurrentTurnRunId(SID)).toBe('run-1');
    expect(getPendingRunCount(SID)).toBe(1);
    expect(getQueueDepth(SID)).toBe(1);
  });

  it('current 空但有人排队 → 新 push 也排队，不插队', () => {
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', msg());
    takeNextRunId(SID);                        // run-1 结束 → run-2 上位
    expect(pushUserMessage(SID, 'run-3', msg())).toEqual({ queued: true });
    expect(getCurrentTurnRunId(SID)).toBe('run-2');
    expect(getPendingRunCount(SID)).toBe(1);
  });

  it('进队的消息带 runId/text/images（session-loop 消费的载荷形状）', async () => {
    pushUserMessage(SID, 'run-1', { text: '画一只猫', images: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] });
    const item = await queue.next();
    expect(item.done).toBe(false);
    expect(item.value).toEqual({
      runId: 'run-1',
      text: '画一只猫',
      images: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
    });
  });

  it('session 不存在 / 已 abort → false', () => {
    expect(pushUserMessage('no-such-session', 'run-x', msg())).toBe(false);
    const ac = new AbortController();
    registerQuerySession('sid-aborted', { abortController: ac, inputQueue: new AsyncQueue() });
    ac.abort('test');
    expect(pushUserMessage('sid-aborted', 'run-x', msg())).toBe(false);
    unregisterQuerySession('sid-aborted');
  });
});

describe('takeNextRunId（FIFO 提升）', () => {
  it('按入队顺序出；队列空 → null 且 current 置空', () => {
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', msg());
    pushUserMessage(SID, 'run-3', msg());
    expect(takeNextRunId(SID)).toBe('run-2');
    expect(getCurrentTurnRunId(SID)).toBe('run-2');
    expect(getPendingRunCount(SID)).toBe(1);
    expect(takeNextRunId(SID)).toBe('run-3');
    expect(getPendingRunCount(SID)).toBe(0);
    expect(takeNextRunId(SID)).toBe(null);
    expect(getCurrentTurnRunId(SID)).toBe(null);
  });

  it('session 不存在 → null', () => {
    expect(takeNextRunId('no-such-session')).toBe(null);
  });
});

describe('drainSession', () => {
  it('排队的 run 标 failed 并清空 pending；正在跑的 current 不动', () => {
    const r1 = createRun({ skillId: 's', brief: 'b1' });
    const r2 = createRun({ skillId: 's', brief: 'b2' });
    const r3 = createRun({ skillId: 's', brief: 'b3' });
    pushUserMessage(SID, r1.id, msg());   // current
    pushUserMessage(SID, r2.id, msg());   // pending
    pushUserMessage(SID, r3.id, msg());   // pending
    drainSession(SID);
    expect(getPendingRunCount(SID)).toBe(0);
    expect(getCurrentTurnRunId(SID)).toBe(r1.id);   // current 不归 drain 管
    expect(getRun(r1.id).status).toBe('pending');    // 还没开跑，状态由 session-loop 推进
    expect(getRun(r2.id).status).toBe('failed');
    expect(getRun(r3.id).status).toBe('failed');
  });

  it('幂等：重复调 / 无 session 不抛', () => {
    expect(() => drainSession(SID)).not.toThrow();
    expect(() => drainSession(SID)).not.toThrow();
    expect(() => drainSession('no-such-session')).not.toThrow();
  });
});
