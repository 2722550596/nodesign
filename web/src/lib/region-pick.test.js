import { describe, it, expect } from 'vitest';
import {
  intersectArea, pickRegionElements, normalizeRect, isMeaningfulRegion, CONTAINER_RATIO,
  pickRegionContainer,
} from './region-pick.js';

/** 假元素：用一棵手写的包含关系代替 DOM */
const tree = {};
const node = (name, children = []) => {
  const n = { name, children };
  tree[name] = n;
  return n;
};
const contains = (a, b) => {
  if (a === b) return false;
  const walk = (x) => x.children.some(c => c === b || walk(c));
  return walk(a);
};
const R = (x, y, w, h) => ({ x, y, w, h });

describe('相交面积', () => {
  it('不挨着 = 0', () => {
    expect(intersectArea(R(0, 0, 10, 10), R(20, 20, 10, 10))).toBe(0);
  });
  it('只碰到边也算 0（边界相切不是相交）', () => {
    expect(intersectArea(R(0, 0, 10, 10), R(10, 0, 10, 10))).toBe(0);
  });
  it('部分重叠取重叠那块', () => {
    expect(intersectArea(R(0, 0, 10, 10), R(5, 5, 10, 10))).toBe(25);
  });
  it('完全包住取被包的那个', () => {
    expect(intersectArea(R(0, 0, 100, 100), R(10, 10, 5, 5))).toBe(25);
  });
});

describe('圈选到底指哪些元素', () => {
  it('圈外的一概不进来', () => {
    const a = node('a'); const b = node('b');
    const got = pickRegionElements([
      { el: a, rect: R(0, 0, 50, 50) },
      { el: b, rect: R(500, 500, 50, 50) },
    ], R(0, 0, 60, 60), { contains });
    expect(got.map(g => g.el.name)).toEqual(['a']);
  });

  it('比圈大太多的容器不算 —— 圈的是里面的东西不是它', () => {
    const page = node('page'); const title = node('title');
    const region = R(100, 100, 40, 20);   // 800 面积
    const got = pickRegionElements([
      { el: page, rect: R(0, 0, 1000, 1000) },
      { el: title, rect: R(100, 100, 40, 20) },
    ], region, { contains });
    expect(got.map(g => g.el.name)).toEqual(['title']);
  });

  it('刚好到阈值的容器还留着（严格大于才排除）', () => {
    const box = node('box');
    const region = R(0, 0, 10, 10);       // 100
    const got = pickRegionElements(
      [{ el: box, rect: R(0, 0, 10, 10 * CONTAINER_RATIO) }],   // 300 = 3×
      region, { contains },
    );
    expect(got).toHaveLength(1);
  });

  /** 用户看见的是最里面那个具体的东西，不是包着它的三层 div */
  it('祖先让位给后代', () => {
    const inner = node('inner');
    const mid = node('mid', [inner]);
    const outer = node('outer', [mid]);
    const got = pickRegionElements([
      { el: outer, rect: R(0, 0, 100, 100) },
      { el: mid, rect: R(10, 10, 80, 80) },
      { el: inner, rect: R(20, 20, 60, 60) },
    ], R(0, 0, 120, 120), { contains });
    expect(got.map(g => g.el.name)).toEqual(['inner']);
  });

  it('并列的兄弟都留着', () => {
    const a = node('a'); const b = node('b');
    const got = pickRegionElements([
      { el: a, rect: R(0, 0, 40, 40) },
      { el: b, rect: R(50, 0, 40, 40) },
    ], R(0, 0, 100, 60), { contains });
    expect(got.map(g => g.el.name).sort()).toEqual(['a', 'b']);
  });

  /**
   * 圈了整页的时候三条规则会把所有人都筛掉。这时候不能返回空 ——
   * 用户圈了半天得到「没圈到东西」是最糟的结果。
   */
  it('全被筛光时退回最内层的那个容器，不是相交最多的', () => {
    const inner = node('inner');
    const body = node('body', [inner]);
    // 两个都比圈大 → 规则 2 全排除。body 相交面积更大，但答「在 body 里」
    // 等于没说；要的是包着这块地方的最内层那个。
    const got = pickRegionElements([
      { el: body, rect: R(0, 0, 2000, 2000) },
      { el: inner, rect: R(0, 0, 900, 900) },
    ], R(100, 100, 300, 300), { contains });
    expect(got.map(g => g.el.name)).toEqual(['inner']);
  });

  it('被圈得越完整排越前', () => {
    const full = node('full'); const edge = node('edge');
    const got = pickRegionElements([
      { el: edge, rect: R(90, 0, 100, 50) },   // 只有 10/100 宽进了圈
      { el: full, rect: R(10, 10, 50, 30) },   // 整个在圈里
    ], R(0, 0, 100, 100), { contains });
    expect(got[0].el.name).toBe('full');
    expect(got[0].coverage).toBe(1);
    expect(got[1].coverage).toBeLessThan(0.5);
  });

  it('数量封顶', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      el: node(`n${i}`), rect: R(i, 0, 5, 5),
    }));
    expect(pickRegionElements(many, R(0, 0, 200, 50), { contains, max: 6 })).toHaveLength(6);
  });

  it('零面积的圈不返回任何东西（除零保护）', () => {
    expect(pickRegionElements([{ el: node('x'), rect: R(0, 0, 10, 10) }], R(5, 5, 0, 0), { contains }))
      .toEqual([]);
  });
});

describe('框本身', () => {
  it('往回拖也得到正的宽高', () => {
    expect(normalizeRect({ x: 100, y: 80 }, { x: 20, y: 10 })).toEqual({ x: 20, y: 10, w: 80, h: 70 });
  });
  it('手抖点一下不算框', () => {
    expect(isMeaningfulRegion({ x: 0, y: 0, w: 2, h: 2 })).toBe(false);
    expect(isMeaningfulRegion({ x: 0, y: 0, w: 100, h: 3 })).toBe(false);
    expect(isMeaningfulRegion(null)).toBe(false);
  });
  it('细长条是有意义的框（一行标题就是这个形状）', () => {
    expect(isMeaningfulRegion({ x: 0, y: 0, w: 300, h: 10 })).toBe(true);
  });
});

describe('圈在谁里面', () => {
  it('取完整包住圈的最内层元素', () => {
    const body = node('body'); const card = node('card'); const aside = node('aside');
    const got = pickRegionContainer([
      { el: body, rect: R(0, 0, 1000, 1000) },
      { el: card, rect: R(50, 50, 400, 300) },
      { el: aside, rect: R(600, 0, 300, 300) },
    ], R(100, 100, 100, 80));
    expect(got.el.name).toBe('card');
  });

  it('只包住一半的不算包住', () => {
    const half = node('half');
    expect(pickRegionContainer([{ el: half, rect: R(0, 0, 100, 100) }], R(50, 50, 100, 100))).toBeNull();
  });

  it('谁都没包住就没有', () => {
    expect(pickRegionContainer([], R(0, 0, 10, 10))).toBeNull();
  });
});
