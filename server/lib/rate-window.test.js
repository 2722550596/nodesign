import { describe, it, expect } from 'vitest';
import { makeRateWindow } from './rate-window.js';

describe('滑动窗口限流', () => {
  it('窗口内到上限就拒，retryAfter 指向最老命中滑出的时刻', () => {
    const w = makeRateWindow({ limit: 3, windowMs: 60_000 });
    expect(w.take('u', 1000).ok).toBe(true);
    expect(w.take('u', 2000).ok).toBe(true);
    expect(w.take('u', 3000).ok).toBe(true);
    const r = w.take('u', 4000);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(60_000 - 3000);   // 1000 那条滑出还要 57s
  });

  it('老命中滑出窗口后放行；不同 key 互不影响', () => {
    const w = makeRateWindow({ limit: 2, windowMs: 10_000 });
    w.take('a', 0); w.take('a', 1000);
    expect(w.take('a', 5000).ok).toBe(false);
    expect(w.take('a', 10_001).ok).toBe(true);    // t=0 的滑出了
    expect(w.take('b', 5000).ok).toBe(true);
  });
});
