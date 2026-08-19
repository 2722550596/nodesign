/**
 * motion-lab 纯函数测试。带浏览器的那半（screencast/采样器注入）在
 * server/lib/_motion-lab-check.mjs 真跑校验 —— 判据本身要先验一遍：
 * check 脚本用**已知过冲量/已知硬切时刻**的动画当对照组。
 */

import { describe, it, expect } from 'vitest';
import { pickNearestFrames, sheetLayout, frameHealth, seriesReport, fmtNum, chartSvg } from './motion-lab.js';

describe('pickNearestFrames', () => {
  const frames = [0, 90, 180, 400, 950].map((tMs) => ({ tMs, buf: null }));

  it('取 last-≤-want：屏幕在时刻 t 显示的就是最后一次 ≤t 的合成帧', () => {
    const picked = pickNearestFrames(frames, [0, 100, 200, 900, 1000]);
    expect(picked.map((p) => p.actual)).toEqual([0, 90, 180, 400, 950]);
    expect(picked[1].want).toBe(100);
  });

  it('绝不取未来帧（t=0 不能拿到起手式已开动的画面）；早于首帧给首帧', () => {
    const picked = pickNearestFrames([{ tMs: 13 }, { tMs: 30 }], [0, 20]);
    expect(picked[0].actual).toBe(13);   // 没有 ≤0 的帧，退给第一帧
    expect(picked[1].actual).toBe(13);   // 20 的屏幕内容 = 13ms 那次合成，不是 30ms
  });

  it('零帧时返回 null 占位', () => {
    expect(pickNearestFrames([], [0, 100])).toEqual([null, null]);
  });
});

describe('sheetLayout', () => {
  it('列数阶梯：≤3 一排，≤8 两排，再多三排', () => {
    expect(sheetLayout(3, 800, 450).cols).toBe(3);
    expect(sheetLayout(6, 800, 450)).toMatchObject({ cols: 3, rows: 2 });
    expect(sheetLayout(10, 800, 450)).toMatchObject({ cols: 4, rows: 3 });
  });

  it('总像素被压进预算（normalizeShot 不需要再整体缩糊）', () => {
    const L = sheetLayout(8, 1920, 1080);
    expect(L.cellW * L.cellH * 8).toBeLessThanOrEqual(1_050_000 * 1.02);
    // 但也别缩没了
    expect(L.cellW).toBeGreaterThan(200);
  });
});

describe('frameHealth', () => {
  it('稳定 60fps → fps≈60、零掉帧', () => {
    const ts = Array.from({ length: 120 }, (_, i) => i * 16.7);
    const h = frameHealth(ts);
    expect(h.ok).toBe(true);
    expect(h.fps).toBeGreaterThan(58);
    expect(h.droppedPct).toBe(0);
    expect(h.freezes).toBe(0);
  });

  it('一个 300ms 冻结被算成 freeze，不被当脏数据剔掉', () => {
    const ts = [];
    let t = 0;
    for (let i = 0; i < 60; i += 1) { ts.push(t); t += i === 30 ? 300 : 16.7; }
    const h = frameHealth(ts);
    expect(h.freezes).toBe(1);
    expect(h.worst).toBeGreaterThan(250);
  });

  it('样本太少直接说不够，不给假满分', () => {
    expect(frameHealth([0, 16, 32]).ok).toBe(false);
  });
});

describe('seriesReport', () => {
  // 已知形状的合成曲线：0→300 easeOutBack（过冲到 ~324 再回稳）
  const easeOutBack = (x) => {
    const c1 = 1.70158; const c3 = c1 + 1;
    return 1 + c3 * ((x - 1) ** 3) + c1 * ((x - 1) ** 2);
  };
  const curve = (withCut) => {
    const pts = [];
    for (let t = 0; t <= 1500; t += 16.7) {
      let v;
      if (t <= 600) v = 300 * easeOutBack(t / 600);
      else v = 300;
      if (withCut && t >= 800) v = t >= 900 ? 300 : 100;   // 800ms 瞬移到 100，900ms 跳回
      pts.push({ t, v });
    }
    return pts;
  };

  it('量得出过冲（easeOutBack ≈ 9.7%）和稳定时刻', () => {
    const r = seriesReport(curve(false));
    expect(r.ok).toBe(true);
    expect(r.final).toBeCloseTo(300, 0);
    expect(r.overshootPct).toBeGreaterThan(6);
    expect(r.overshootPct).toBeLessThan(13);
    expect(r.settleMs).toBeGreaterThan(300);
    expect(r.settleMs).toBeLessThan(650);
    expect(r.cuts).toEqual([]);
  });

  it('单帧瞬移被标为硬切，时刻对得上', () => {
    const r = seriesReport(curve(true));
    expect(r.cuts.length).toBeGreaterThanOrEqual(1);
    expect(r.cuts[0]).toBeGreaterThan(760);
    expect(r.cuts[0]).toBeLessThan(860);
  });

  it('纹丝不动的值报 still，不报一堆 0% 假统计', () => {
    const r = seriesReport(Array.from({ length: 60 }, (_, i) => ({ t: i * 16.7, v: 42 })));
    expect(r.still).toBe(true);
  });

  it('非数值样本被滤掉；全废时 ok=false', () => {
    const r = seriesReport(Array.from({ length: 60 }, (_, i) => ({ t: i * 16.7, v: null })));
    expect(r.ok).toBe(false);
  });
});

describe('chartSvg', () => {
  it('出的是合法 SVG，带图例与硬切标记', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ t: i * 20, v: Math.sin(i / 10) * 50 }));
    const report = seriesReport(points);
    const svg = chartSvg([{ name: 'gun_y', points, report: { ...report, cuts: [800] } }], 2000);
    expect(svg).toContain('<svg');
    expect(svg).toContain('gun_y');
    expect(svg).toContain('stroke-dasharray');   // 硬切虚线
    expect(svg).toContain('ms</text>');          // 时间刻度
  });
});

describe('fmtNum', () => {
  it('按量级挑精度', () => {
    expect(fmtNum(1234.5)).toBe('1235');
    expect(fmtNum(12.34)).toBe('12.3');
    expect(fmtNum(-2.7612)).toBe('-2.761');
    expect(fmtNum(NaN)).toBe('?');
  });
});
