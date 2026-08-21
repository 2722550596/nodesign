import { describe, it, expect } from 'vitest';
import { UpstreamTruncation } from './upstream-truncation.js';
import { truncationReason, truncationOfChatResponse } from './openai-chat.js';

describe('truncationReason —— 什么算「说到一半被掐」', () => {
  it('有正文 + 没有 finish_reason = 半截', () => {
    expect(truncationReason({ finish: null, sawText: true, sawToolCall: false })).toBe('no finish_reason');
  });
  it('有正文 + 私货 finish（network_error）= 半截', () => {
    expect(truncationReason({ finish: 'network_error', sawText: true, sawToolCall: false }))
      .toBe("finish_reason='network_error'");
  });
  it('⭐ 发了 [DONE] 只是末块没 finish_reason = 收完了，不算半截（否则换一家这脾气的上游就每轮平白续接到封顶）', () => {
    expect(truncationReason({ finish: null, sawText: true, sawToolCall: false, doneSeen: true })).toBeNull();
  });
  it('私货 finish 即便见过 [DONE] 也算半截（那是上游自己说链路出错了）', () => {
    expect(truncationReason({ finish: 'network_error', sawText: true, sawToolCall: false, doneSeen: true }))
      .toBe("finish_reason='network_error'");
  });
  it('有正文 + 正常收尾 = 不是半截', () => {
    expect(truncationReason({ finish: 'stop', sawText: true, sawToolCall: false })).toBeNull();
    expect(truncationReason({ finish: 'length', sawText: true, sawToolCall: false })).toBeNull();
  });
  it('零正文（thinking-only 早断流）不走续接 —— 那条已经发 error 事件让 CLI 自己重试', () => {
    expect(truncationReason({ finish: null, sawText: false, sawToolCall: false })).toBeNull();
    expect(truncationReason({ finish: 'network_error', sawText: false, sawToolCall: false })).toBeNull();
  });
  it('⛔ 出过 tool_call 的半截不算 —— CLI 自己会治（坏 JSON → InputValidationError → 模型重来），叠加续接反而把回合拖进 max_turns', () => {
    expect(truncationReason({ finish: null, sawText: true, sawToolCall: true })).toBeNull();
    expect(truncationReason({ finish: 'network_error', sawText: true, sawToolCall: true })).toBeNull();
  });
});

describe('truncationOfChatResponse —— 非流式与流式同一张判据', () => {
  const wrap = (message, finish) => ({ choices: [{ message, finish_reason: finish }] });
  it('正文 + 无 finish = 半截', () => {
    expect(truncationOfChatResponse(wrap({ content: '说到一半' }, null))).toBe('no finish_reason');
  });
  it('正文 + stop = 完整', () => {
    expect(truncationOfChatResponse(wrap({ content: '说完了' }, 'stop'))).toBeNull();
  });
  it('带 tool_calls 的不算', () => {
    expect(truncationOfChatResponse(wrap({ content: 'x', tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{}' } }] }, null))).toBeNull();
  });
  it('refusal 也算正文（转换层把它当文本读）', () => {
    expect(truncationOfChatResponse(wrap({ refusal: '不行' }, null))).toBe('no finish_reason');
  });
  it('没有 choices → null（那条走的是"空响应"分支，不是半截）', () => {
    expect(truncationOfChatResponse({ choices: [] })).toBeNull();
    expect(truncationOfChatResponse(null)).toBeNull();
  });
});

describe('UpstreamTruncation —— 只记最近一次，取走即清', () => {
  it('记了能取到，取走就没了', () => {
    const t = new UpstreamTruncation();
    t.note('sid1', 'no finish_reason', { appModel: 'ox-alpha' });
    expect(t.take('sid1')).toMatchObject({ reason: 'no finish_reason', appModel: 'ox-alpha' });
    expect(t.take('sid1')).toBeNull();
  });
  it('后面一次收得完整就把标记清掉（一个回合里多次往返，只有收尾那次算数）', () => {
    const t = new UpstreamTruncation();
    t.note('sid1', 'no finish_reason');
    t.note('sid1', null);
    expect(t.take('sid1')).toBeNull();
  });
  it('会话之间互不干扰', () => {
    const t = new UpstreamTruncation();
    t.note('a', 'no finish_reason');
    expect(t.take('b')).toBeNull();
    expect(t.take('a')).not.toBeNull();
  });
  it('没 sid 不炸', () => {
    const t = new UpstreamTruncation();
    expect(() => t.note(null, 'x')).not.toThrow();
    expect(t.take(null)).toBeNull();
  });
});
