import { describe, it, expect } from 'vitest';
import {
  BINDING_STYLES, BINDING_STYLE_IDS, bindingStyle,
  edgePoints, bindingPath, bindingMidpoint,
} from './board-bindings.js';
import { BINDING_TYPES, BINDING_TYPE_IDS, isBindingType } from '../../../server/lib/binding-types.js';

/**
 * 关系线：语义表（服务端，校验方）与视觉表（前端，渲染方）的一致性 + 几何。
 *
 * 跨目录 import 服务端那份是有意的：**两份表必须一一对应**，而唯一能自动
 * 保证这件事的办法就是在同一个测试里同时读它们。加了语义忘了给视觉、或者
 * 反过来，这里直接红。两个文件都是纯 ESM 无依赖，vitest 能直接吃。
 */

describe('语义表 ↔ 视觉表 parity', () => {
  it('两边的 id 集合完全相同', () => {
    expect([...BINDING_STYLE_IDS].sort()).toEqual([...BINDING_TYPE_IDS].sort());
  });

  it('每种都有画得出来的样式（颜色 + 线宽 + 端头）', () => {
    for (const id of BINDING_TYPE_IDS) {
      const s = BINDING_STYLES[id];
      expect(s, `${id} 缺视觉定义`).toBeTruthy();
      expect(typeof s.stroke, `${id}.stroke`).toBe('string');
      expect(s.width, `${id}.width`).toBeGreaterThan(0);
      expect(s.head || s.tail, `${id} 两端都没有端头，画出来分不清方向`).toBeTruthy();
    }
  });

  it('中文名两边一致（线上标签和 agent 看到的词得是同一个）', () => {
    for (const id of BINDING_TYPE_IDS) {
      expect(BINDING_STYLES[id].label, id).toBe(BINDING_TYPES[id].label);
    }
  });

  it('无向的关系两端端头对称，有向的不对称', () => {
    for (const id of BINDING_TYPE_IDS) {
      const directed = BINDING_TYPES[id].directed;
      const s = BINDING_STYLES[id];
      if (directed) expect(s.tail, `${id} 是有向的，尾端不该有端头`).toBeFalsy();
      else expect(s.tail, `${id} 是无向的，两端要对称`).toBe(s.head);
    }
  });

  it('未知 type 拿不到样式（跟服务端一样宁可不画）', () => {
    expect(bindingStyle('wat')).toBeNull();
    expect(isBindingType('wat')).toBe(false);
  });
});

describe('端点贴边（不从中心画）', () => {
  const A = { x: 0, y: 0, w: 100, h: 100 };      // 中心 (50,50)
  const B = { x: 300, y: 0, w: 100, h: 100 };    // 中心 (350,50)

  it('水平相邻：从右边框出发，到左边框结束', () => {
    const p = edgePoints(A, B, 0);
    expect(p.from.x).toBeCloseTo(100);   // A 的右边
    expect(p.from.y).toBeCloseTo(50);
    expect(p.to.x).toBeCloseTo(300);     // B 的左边
    expect(p.to.y).toBeCloseTo(50);
  });

  it('gap 把端点再往外推，箭头不埋在卡片底下', () => {
    const p = edgePoints(A, B, 8);
    expect(p.from.x).toBeCloseTo(108);
    expect(p.to.x).toBeCloseTo(292);
  });

  it('垂直相邻：走上下边框不走左右', () => {
    const C = { x: 0, y: 300, w: 100, h: 100 };
    const p = edgePoints(A, C, 0);
    expect(p.from.y).toBeCloseTo(100);
    expect(p.to.y).toBeCloseTo(300);
    expect(p.from.x).toBeCloseTo(50);
  });

  it('对角：先撞到哪条边就走哪条（正方形对角线撞角点）', () => {
    const D = { x: 300, y: 300, w: 100, h: 100 };
    const p = edgePoints(A, D, 0);
    expect(p.from.x).toBeCloseTo(100);
    expect(p.from.y).toBeCloseTo(100);
  });

  it('扁矩形对角：横向分量大就走竖边', () => {
    const wide = { x: 0, y: 0, w: 400, h: 40 };        // 中心 (200,20)
    const far = { x: 600, y: 60, w: 40, h: 40 };       // 中心 (620,80)
    const p = edgePoints(wide, far, 0);
    // dx=420 dy=60，tx=200/420≈0.476，ty=20/60≈0.333 → ty 小，走横边（下边）
    expect(p.from.y).toBeCloseTo(40);
  });

  it('端点缺失或中心重合都返回 null（不画一条退化的线）', () => {
    expect(edgePoints(null, B)).toBeNull();
    expect(edgePoints(A, null)).toBeNull();
    expect(edgePoints(A, { x: 0, y: 0, w: 100, h: 100 })).toBeNull();
  });
});

describe('路径与标签位', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 0 };

  it('起点终点原样落在 path 上', () => {
    const d = bindingPath(from, to);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('200 0')).toBe(true);
  });

  it('起拱量有上限，远距离不会拱成一个圈', () => {
    const near = bindingPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    const far = bindingPath({ x: 0, y: 0 }, { x: 100000, y: 0 });
    const bowOf = (d) => Math.abs(Number(d.split('Q ')[1].split(' ')[1]));
    expect(bowOf(near)).toBeCloseTo(14);        // 100 * 0.14
    expect(bowOf(far)).toBeCloseTo(46);         // 撞上限
  });

  it('标签落在曲线上而不是弦上（起拱时两者不同）', () => {
    const mid = bindingMidpoint(from, to);
    expect(mid.x).toBeCloseTo(100);
    // 弦中点 y=0；曲线中点被拱起 = 控制点位移的一半
    expect(mid.y).not.toBeCloseTo(0);
    expect(mid.y).toBeCloseTo(14);              // 0.5 * 28（200*0.14）
  });

  it('零长度不炸（同点）', () => {
    expect(() => bindingPath({ x: 5, y: 5 }, { x: 5, y: 5 })).not.toThrow();
    expect(() => bindingMidpoint({ x: 5, y: 5 }, { x: 5, y: 5 })).not.toThrow();
  });
});
