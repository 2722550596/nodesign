import { describe, it, expect } from 'vitest';
import { lineageFolds } from './lineage.js';

const df = (from, to) => ({ type: 'derives-from', from, to, by: 'user' });

describe('lineageFolds', () => {
  it('链收叠：旧版全藏、链尾带计数', () => {
    const { hidden, stacks } = lineageFolds(['v1', 'v2', 'v3', 'x'], {
      a: df('v2', 'v1'), b: df('v3', 'v2'),
    });
    expect([...hidden].sort()).toEqual(['v1', 'v2']);
    expect(stacks.get('v3')).toEqual({ count: 2, open: false });
    expect(hidden.has('x')).toBe(false);
  });

  it('展开集里的链不藏，但链尾仍带徽标（能收回去）', () => {
    const { hidden, stacks } = lineageFolds(['v1', 'v2'], { a: df('v2', 'v1') }, new Set(['v2']));
    expect(hidden.size).toBe(0);
    expect(stacks.get('v2')).toEqual({ count: 1, open: true });
  });

  it('分叉不折叠（两个链尾=歧义），环不折叠', () => {
    const fork = lineageFolds(['a', 'b', 'c'], { e1: df('b', 'a'), e2: df('c', 'a') });
    expect(fork.hidden.size).toBe(0);
    expect(fork.stacks.size).toBe(0);
    const cycle = lineageFolds(['a', 'b'], { e1: df('a', 'b'), e2: df('b', 'a') });
    expect(cycle.hidden.size).toBe(0);
  });

  it('半截在层外的边不参与（端点必须都在场）', () => {
    const { hidden } = lineageFolds(['v2'], { a: df('v2', 'v1') });
    expect(hidden.size).toBe(0);
  });

  it('其他类型的边不触发收叠', () => {
    const { hidden } = lineageFolds(['a', 'b'], { e: { type: 'contrast', from: 'a', to: 'b' } });
    expect(hidden.size).toBe(0);
  });
});
