import { describe, it, expect } from 'vitest';
import { projector, MAP_W, MAP_H } from './Minimap.jsx';

/**
 * 小地图的投影数学。
 *
 * 会骗人的地图比没有地图糟：**等比缩 + 居中**这两条一旦破了，用户按小地图
 * 上的相对位置去点，跳过去的地方就是错的，而且错得很难描述（"感觉偏了一点"）。
 * 所以把不变量钉死在这里，别等到肉眼在 168×116 的框里去发现。
 */
describe('projector', () => {
  const WIDE = { x: -200, y: 0, w: 4000, h: 1000 };   // 扁的
  const TALL = { x: 0, y: -50, w: 800, h: 3000 };     // 高的

  it('两个方向共用同一个缩放系数（不拉伸）', () => {
    for (const b of [WIDE, TALL]) {
      const p = projector(b);
      const a = p.toMap(b.x, b.y);
      const c = p.toMap(b.x + b.w, b.y + b.h);
      expect((c.x - a.x) / b.w).toBeCloseTo((c.y - a.y) / b.h, 6);
    }
  });

  it('整块内容装得进框里，且居中', () => {
    for (const b of [WIDE, TALL]) {
      const p = projector(b);
      const a = p.toMap(b.x, b.y);
      const c = p.toMap(b.x + b.w, b.y + b.h);
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(MAP_W + 0.001);
      expect(c.y).toBeLessThanOrEqual(MAP_H + 0.001);
      // 居中 = 两侧余量相等
      expect(a.x).toBeCloseTo(MAP_W - c.x, 6);
      expect(a.y).toBeCloseTo(MAP_H - c.y, 6);
    }
  });

  it('toMap / toWorld 是一对逆运算（点哪儿跳哪儿的前提）', () => {
    const p = projector(WIDE);
    for (const pt of [{ x: 0, y: 0 }, { x: 1234, y: 567 }, { x: -200, y: 1000 }]) {
      const m = p.toMap(pt.x, pt.y);
      const back = p.toWorld(m.x, m.y);
      expect(back.x).toBeCloseTo(pt.x, 6);
      expect(back.y).toBeCloseTo(pt.y, 6);
    }
  });

  it('退化的 bounds（宽或高为 0）不产生 NaN / Infinity', () => {
    const p = projector({ x: 0, y: 0, w: 0, h: 0 });
    const m = p.toMap(0, 0);
    expect(Number.isFinite(m.x)).toBe(true);
    expect(Number.isFinite(m.y)).toBe(true);
    expect(Number.isFinite(p.k)).toBe(true);
  });
});
