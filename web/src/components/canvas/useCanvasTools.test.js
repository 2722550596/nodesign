import { describe, it, expect } from 'vitest';
import { pointsToPath, pointsBounds, pathPoints, translatePath } from './useCanvasTools.js';

/**
 * 涂鸦的两个纯函数。它们决定了「一笔画完落盘成什么」，而落盘的东西
 * 服务端还要用正则校一遍（`/^[\dMLQCZ ,.\-eE]+$/`）—— 这里生成的字符
 * 集必须跟那条正则对得上，否则用户画完一看没了，且没有任何报错。
 */

describe('pointsToPath', () => {
  it('空输入给空串', () => {
    expect(pointsToPath([])).toBe('');
    expect(pointsToPath(null)).toBe('');
  });

  it('一个点只 M', () => {
    expect(pointsToPath([{ x: 5, y: 7 }])).toBe('M 5 7');
  });

  it('两个点走直线（两点画不出曲线）', () => {
    expect(pointsToPath([{ x: 0, y: 0 }, { x: 10, y: 4 }])).toBe('M 0 0 L 10 4');
  });

  it('三点以上用二次贝塞尔穿中点', () => {
    const d = pointsToPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
    expect(d).toBe('M 0 0 Q 10 10 15 5 L 20 0');
  });

  it('坐标存的是相对原点的偏移（拖动涂鸦只改 x/y，路径不用重写）', () => {
    const pts = [{ x: 100, y: 200 }, { x: 110, y: 210 }];
    expect(pointsToPath(pts, 100, 200)).toBe('M 0 0 L 10 10');
  });

  it('坐标取整（半像素对一条手绘线毫无意义，白占字节）', () => {
    expect(pointsToPath([{ x: 1.4, y: 2.6 }, { x: 9.5, y: 3.2 }])).toBe('M 1 3 L 10 3');
  });

  /**
   * 这条是跟服务端校验的**契约测试**。正则抄自 board-store.js 的
   * `sanitizeCanvasData`：生成的路径必须整串命中，否则落盘时被静默丢弃。
   */
  it('生成的字符集通得过服务端的白名单正则', () => {
    const SERVER_RE = /^[\dMLQCZ ,.\-eE]+$/;
    const cases = [
      [{ x: 0, y: 0 }],
      [{ x: 0, y: 0 }, { x: 5, y: 5 }],
      [{ x: -30, y: -12 }, { x: 4, y: 88 }, { x: 120, y: 3 }, { x: 7, y: 9 }],
    ];
    for (const pts of cases) {
      const d = pointsToPath(pts);
      expect(SERVER_RE.test(d), `路径含非法字符: ${d}`).toBe(true);
    }
  });

  it('负坐标也合法（画布原生物件可以住在产物左上方的余白里）', () => {
    const d = pointsToPath([{ x: -50, y: -20 }, { x: -10, y: -5 }]);
    expect(d).toBe('M -50 -20 L -10 -5');
    expect(/^[\dMLQCZ ,.\-eE]+$/.test(d)).toBe(true);
  });
});

describe('pointsBounds', () => {
  it('包住所有点并留边距', () => {
    const b = pointsBounds([{ x: 10, y: 20 }, { x: 50, y: 5 }], 6);
    expect(b).toEqual({ x: 4, y: -1, w: 52, h: 27 });
  });

  it('单点也给得出有面积的框（w/h 不能是 0，服务端最小值是 4）', () => {
    const b = pointsBounds([{ x: 3, y: 3 }], 0);
    expect(b.w).toBeGreaterThanOrEqual(4);
    expect(b.h).toBeGreaterThanOrEqual(4);
  });

  it('包围盒配合相对路径能还原原始坐标', () => {
    const pts = [{ x: 100, y: 100 }, { x: 140, y: 130 }];
    const b = pointsBounds(pts, 6);
    const d = pointsToPath(pts, b.x, b.y);
    // 第一个点在盒内的偏移应等于 pad
    expect(d.startsWith('M 6 6')).toBe(true);
  });
});

describe('墨迹归组的两个助手（2026-08-13）', () => {
  it('pathPoints 把 M/L/Q 的参数全解成坐标对', () => {
    expect(pathPoints('M 8 8 Q 28 38 48 16 L 72 28')).toEqual([
      { x: 8, y: 8 }, { x: 28, y: 38 }, { x: 48, y: 16 }, { x: 72, y: 28 },
    ]);
  });

  it('pathPoints 认得负数和空串', () => {
    expect(pathPoints('M -5 -20 L 10 3')).toEqual([{ x: -5, y: -20 }, { x: 10, y: 3 }]);
    expect(pathPoints('')).toEqual([]);
  });

  it('translatePath 奇偶交替加 dx/dy，命令字母原样保留', () => {
    expect(translatePath('M 8 8 L 72 28', 10, -3)).toBe('M 18 5 L 82 25');
    expect(translatePath('M -5 0 Q 1 2 3 4', 5, 5)).toBe('M 0 5 Q 6 7 8 9');
  });

  it('平移后的串仍然过服务端字符白名单', () => {
    const out = translatePath('M 8 8 Q 28 38 48 16 L 72 28', -100, -200);
    expect(/^[\dMLQCZ ,.\-eE]+$/.test(out)).toBe(true);
  });

  it('合并语义：平移到新原点后接上新段，点列 = 两段之和', () => {
    const merged = `${translatePath('M 8 8 L 20 20', 2, 2)} M 40 40 L 60 60`;
    expect(pathPoints(merged)).toEqual([
      { x: 10, y: 10 }, { x: 22, y: 22 }, { x: 40, y: 40 }, { x: 60, y: 60 },
    ]);
  });
});
