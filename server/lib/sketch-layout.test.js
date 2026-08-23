import { describe, it, expect } from 'vitest';
import { shapePath, layoutNodes, findSpot, textBox, UNIT } from './sketch-layout.js';

const PATH_RE = /^[\dMLQCZ ,.\-eE]+$/;   // = board-sanitize 的涂鸦字符白名单

describe('sketch-layout', () => {
  it('每种形状的路径都过涂鸦白名单、确定性、尺寸含 pad', () => {
    for (const kind of ['rect', 'ellipse', 'circle', 'line', 'arrow', 'underline']) {
      const a = shapePath(kind, { w: 120, h: 60, to: { x: 120, y: 30 } }, 's1');
      const b = shapePath(kind, { w: 120, h: 60, to: { x: 120, y: 30 } }, 's1');
      expect(a.d, kind).toMatch(PATH_RE);
      expect(a.d, kind).toBe(b.d);
      expect(a.w, kind).toBeGreaterThan(0);
      expect(a.h, kind).toBeGreaterThan(0);
    }
    expect(shapePath('rect', { w: 100, h: 50 }, 'x').d).not.toBe(shapePath('rect', { w: 100, h: 50 }, 'y').d);
    expect(shapePath('blob', {}, 'x')).toBeNull();
  });
  it('模板：column 竖排不重叠；grid 按列；mindmap 第一个居中其余环绕；free 认网格', () => {
    const nodes = [1, 2, 3, 4, 5].map(i => ({ key: `n${i}`, w: 100, h: 40 }));
    const col = layoutNodes(nodes, { template: 'column' });
    expect(col.get('n2').y).toBeGreaterThanOrEqual(40);
    const grid = layoutNodes(nodes, { template: 'grid', cols: 2 });
    expect(grid.get('n3').y).toBeGreaterThan(0);
    expect(grid.get('n2').x).toBeGreaterThan(0);
    const mm = layoutNodes(nodes, { template: 'mindmap' });
    const c = mm.get('n1');
    const others = ['n2', 'n3', 'n4', 'n5'].map(k => mm.get(k));
    for (const o of others) expect(Math.hypot(o.x - c.x, o.y - c.y)).toBeGreaterThan(80);
    const free = layoutNodes([{ key: 'a', w: 50, h: 20, at: { x: 2, y: 3 } }, { key: 'b', w: 50, h: 20 }], { template: 'free' });
    expect(free.get('a')).toEqual({ x: 2 * UNIT, y: 3 * UNIT });
    expect(free.get('b').y).toBeGreaterThan(3 * UNIT + 20);
  });
  it('findSpot：锚右侧优先、撞了往下让、没锚排内容底下', () => {
    const near = { x: 0, y: 0, w: 200, h: 100 };
    const s1 = findSpot({ w: 100, h: 50, near, obstacles: [near] });
    expect(s1.side).toBe('right');
    const s2 = findSpot({ w: 100, h: 50, near, obstacles: [near, { x: 232, y: 0, w: 100, h: 300 }] });
    expect(s2.y).toBeGreaterThan(0);
    const s3 = findSpot({ w: 100, h: 50, contentBottom: 500 });
    expect(s3.y).toBeGreaterThan(500);
  });
  it('textBox：md 比 plain 宽、按行估高', () => {
    const p = textBox('短句', 'md');
    const m = textBox('# 标题\n- 一\n- 二\n- 三', 'md', { md: true });
    expect(m.w).toBeGreaterThan(p.w);
    expect(m.h).toBeGreaterThan(p.h);
  });
});
