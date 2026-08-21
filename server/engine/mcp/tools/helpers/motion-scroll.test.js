import { describe, it, expect } from 'vitest';
import { elementMotionReport, elementMotionLines } from './motion-scroll.js';

// 样本格式 [tMs, docX, docY, opacity, scale]
const seq = (sel, rows, extra = {}) => ({ sel, samples: rows, ...extra });

describe('elementMotionReport', () => {
  it('不动的不报；入场（位移+透明度）、视差、固定元素分得开', () => {
    const scrolledPx = 900;
    const rep = elementMotionReport([
      seq('section.static', [[0, 0, 1000, 1, 1], [300, 0, 1000, 1, 1], [600, 0, 1000, 1, 1]]),
      // 入场：从 y+40 / 0 透明度 → 原位 / 1，跟滚动量无关
      seq('.card', [[0, 100, 1240, 0, 1], [200, 100, 1220, 0.4, 1], [400, 100, 1200, 1, 1], [600, 100, 1200, 1, 1]]),
      // 视差：文档坐标随滚动量的 30% 走
      seq('.bg', [[0, 0, 500, 1, 1], [300, 0, 635, 1, 1], [600, 0, 770, 1, 1]]),
      // 固定元素：文档坐标位移 ≈ 滚动量
      seq('header.nav', [[0, 0, 0, 1, 1], [300, 0, 450, 1, 1], [600, 0, 900, 1, 1]], { fixed: true }),
      // 缩放
      seq('img.hero', [[0, 0, 200, 1, 1], [300, 0, 200, 1, 1.05], [600, 0, 200, 1, 1.1]]),
    ], { scrolledPx });
    expect(rep.total).toBe(5);
    expect(rep.moving).toBe(4);
    const by = Object.fromEntries(rep.items.map(i => [i.sel, i.tags.join(' | ')]));
    expect(by['.card']).toMatch(/位移 40px/);
    expect(by['.card']).toMatch(/透明度 0→1/);
    expect(by['.bg']).toMatch(/视差（位移≈滚动量的 30%）/);
    expect(by['header.nav']).toMatch(/fixed\/sticky/);
    expect(by['img.hero']).toMatch(/缩放 1→1.1/);
    const card = rep.items.find(i => i.sel === '.card');
    expect(card.startMs).toBe(200);
    expect(card.endMs).toBe(600);
  });
  it('elementMotionLines：空/无动/有动三种口径', () => {
    expect(elementMotionLines({ total: 0 })[0]).toMatch(/no elements sampled/);
    expect(elementMotionLines({ total: 5, moving: 0, items: [] })[0]).toMatch(/none moved/);
    const rep = elementMotionReport([seq('.a', [[0, 0, 0, 0, 1], [100, 0, 0, 1, 1], [200, 0, 0, 1, 1]])]);
    const lines = elementMotionLines(rep);
    expect(lines[0]).toMatch(/1 of 1 watched elements moved/);
    expect(lines[1]).toMatch(/\.a  透明度 0→1  \[100→200ms\]/);   // end = 最后一个和起点不同的样本
  });
});
