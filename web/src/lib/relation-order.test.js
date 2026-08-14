import { describe, it, expect } from 'vitest';
import { orderByRelations, orderWithGroups } from './relation-order.js';
import { packRow, COL_W } from './board-geometry.js';

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

describe('orderWithGroups / packRow 块边界', () => {
  it('多成员组标记组头与组后第一个；无关系时空集且引用不变', () => {
    const { order, breakBefore } = orderWithGroups(['a', 'b', 'c', 'd'], { x: b('contrast', 'b', 'c') });
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect([...breakBefore].sort()).toEqual(['b', 'd']);   // 组头 b、组后 d
    const ids = ['a', 'b'];
    const r = orderWithGroups(ids, {});
    expect(r.order).toBe(ids);
    expect(r.breakBefore.size).toBe(0);
  });

  it('packRow：breakBefore 强制换行，行首 noop', () => {
    const m = (id, brk) => ({ id, w: COL_W, h: 100, breakBefore: !!brk });
    const { slots } = packRow([m('a'), m('b', true), m('c')], { width: COL_W * 4, xMin: 0, yTop: 0 });
    const y = Object.fromEntries(slots.map(s2 => [s2.id, s2.y]));
    expect(y.b).toBeGreaterThan(y.a);          // b 前强制换行
    expect(y.c).toBe(y.b);                     // c 跟 b 同行
    const first = packRow([m('a', true), m('x')], { width: COL_W * 4, xMin: 0, yTop: 0 });
    expect(first.slots[0].y).toBe(0);          // 行首 breakBefore 不空转
  });
});
