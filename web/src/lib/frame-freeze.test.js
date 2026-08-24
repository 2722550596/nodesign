/**
 * frame-freeze 单测（08-24 站点卡性能案）。关键语义：冻结是"排队"不是
 * "掐死"—— rAF 链靠回调里再约下一帧活着，no-op 会让解冻后永远不动。
 */
import { describe, it, expect } from 'vitest';
import { freezeWin, thawWin } from './frame-freeze.js';

/** 假窗：orig rAF 同步记账（不真跑帧，只看调度进了哪条队） */
function mkWin() {
  const w = { scheduled: [] };
  w.requestAnimationFrame = (cb) => { w.scheduled.push(cb); return w.scheduled.length; };
  return w;
}

describe('freezeWin / thawWin', () => {
  it('冻结后 rAF 只排队不执行；解冻补发，链原地续上', () => {
    const w = mkWin();
    expect(freezeWin(w)).toBe(true);
    const cb = () => {};
    const id = w.requestAnimationFrame(cb);
    expect(id).toBe(-1);                    // 假 id，cancelAnimationFrame(-1) 无害
    expect(w.scheduled).toHaveLength(0);    // 没进真调度
    expect(thawWin(w)).toBe(true);
    expect(w.scheduled).toEqual([cb]);      // 解冻补发 → 链续上
  });

  it('重复冻结/解冻幂等；解冻后 rAF 恢复直通', () => {
    const w = mkWin();
    expect(freezeWin(w)).toBe(true);
    expect(freezeWin(w)).toBe(false);       // 已冻不重复包（否则 orig 被包两层）
    thawWin(w);
    expect(thawWin(w)).toBe(false);
    const cb = () => {};
    w.requestAnimationFrame(cb);
    expect(w.scheduled).toContain(cb);
  });

  it('死窗/空窗/无 rAF 的窗静默不冻（跨源 iframe 抛异常也一样）', () => {
    expect(freezeWin(null)).toBe(false);
    expect(freezeWin({})).toBe(false);
    expect(thawWin(null)).toBe(false);
    const hostile = new Proxy({}, { get() { throw new Error('cross-origin'); } });
    expect(freezeWin(hostile)).toBe(false);
    expect(thawWin(hostile)).toBe(false);
  });
});
