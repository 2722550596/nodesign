import { describe, it, expect } from 'vitest';
import { orderByRelations } from './relation-order.js';

const b = (type, from, to) => ({ type, from, to, by: 'user' });

describe('orderByRelations', () => {
  it('没有关系时原样返回（引用都不变）', () => {
    const ids = ['a', 'b', 'c'];
    expect(orderByRelations(ids, {})).toBe(ids);
    expect(orderByRelations(ids, { x: b('contrast', 'a', 'z') })).toBe(ids);  // 半截在外
  });

  it('对照凑相邻，组外顺序不动', () => {
    const out = orderByRelations(['a', 'b', 'c', 'd'], { x: b('contrast', 'a', 'c') });
    expect(out).toEqual(['a', 'c', 'b', 'd']);
  });

  it('接着按正向展开（分镜读序）', () => {
    const out = orderByRelations(['p1', 'p2', 'p3', 'x'], {
      e1: b('flow', 'p2', 'p3'),
      e2: b('flow', 'p1', 'p2'),
    });
    expect(out).toEqual(['p1', 'p2', 'p3', 'x']);
  });

  it('改自反向展开：from=新 to=旧，排出来旧在前（时间轴读序）', () => {
    const out = orderByRelations(['v1', 'v2', 'v3'], {
      e1: b('derives-from', 'v2', 'v1'),
      e2: b('derives-from', 'v3', 'v2'),
    });
    expect(out).toEqual(['v1', 'v2', 'v3']);
  });

  it('取材（affinity=null）不影响顺序', () => {
    const ids = ['a', 'b', 'c'];
    expect(orderByRelations(ids, { x: b('ref', 'a', 'c') })).toBe(ids);
  });

  it('环不死循环，成员全都在', () => {
    const out = orderByRelations(['a', 'b'], {
      e1: b('flow', 'a', 'b'),
      e2: b('flow', 'b', 'a'),
    });
    expect([...out].sort()).toEqual(['a', 'b']);
    expect(out).toHaveLength(2);
  });

  it('分叉保守：一进一出，多余的边放弃但成员不丢', () => {
    const out = orderByRelations(['a', 'b', 'c'], {
      e1: b('flow', 'a', 'b'),
      e2: b('flow', 'a', 'c'),   // a 已有出边，放弃
    });
    expect(out.slice(0, 2)).toEqual(['a', 'b']);
    expect(out).toHaveLength(3);
  });

  it('两次调用结果一致（整理必须可预期）', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const bs = { x: b('contrast', 'b', 'd'), y: b('link', 'a', 'e') };
    expect(orderByRelations(ids, bs)).toEqual(orderByRelations(ids, bs));
  });
});
