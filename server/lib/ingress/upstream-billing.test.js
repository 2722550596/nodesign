import { describe, it, expect } from 'vitest';
import { UpstreamBilling } from './upstream-billing.js';

describe('UpstreamBilling', () => {
  it('按会话×模型累加 cost 与 usage；take 取走清零；没报 cost 且没 usage 不记', () => {
    const b = new UpstreamBilling();
    b.note('s1', 'ox-alpha', { costUsd: '0.001', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 5 } } });
    b.note('s1', 'ox-alpha', { costUsd: 0.002, usage: { prompt_tokens: 50, completion_tokens: 10 } });
    b.note('s1', 'ox-alpha-helper', { costUsd: '0', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    b.note('s1', 'ox-alpha', {});                                   // 空 → 不记
    b.note('s2', 'ox-alpha', { costUsd: null, usage: { prompt_tokens: 1 } });   // 没 cost 但有 usage → 记 usage，cost 保持 null
    const t = b.take('s1');
    expect(t['ox-alpha']).toMatchObject({ responses: 2, promptTokens: 150, completionTokens: 30, cachedTokens: 64, reasoningTokens: 5 });
    expect(t['ox-alpha'].costUsd).toBeCloseTo(0.003, 9);
    expect(t['ox-alpha-helper']).toMatchObject({ responses: 1, costUsd: 0 });
    expect(b.take('s1')).toBeNull();
    expect(b.peek('s2')['ox-alpha'].costUsd).toBeNull();
    expect(b.take('nope')).toBeNull();
  });
});
