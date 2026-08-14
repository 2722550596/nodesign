import { describe, it, expect } from 'vitest';
import {
  IDENTITY_CAMERA, ZOOM_MIN, ZOOM_MAX, CAMERA_PADDING,
  worldToScreen, screenToWorld, screenDeltaToWorld,
  boxUnion, boxExpand, naturalZoom, constrainCamera,
  zoomAtScreenPoint, stepZoom, fitBox, viewportWorldBox,
} from './board-camera.js';

/**
 * 相机数学。坐标约定 `screen = (world + cam) * cam.z`。
 *
 * 「退化输入」那一组不是凑数：这个模块的三个真缺陷全在退化路径上，而且
 * 都是**静默错**（不抛异常，只是画面跳一下或整块白屏），跑不出来就看不见。
 * 每条都带触发数值。
 */

const VP = { w: 1000, h: 800 };
const CONTENT = { x: -800, y: -800, w: 2600, h: 2400 };
const base = (over) => ({ bounds: CONTENT, viewport: VP, ...over });

/** 世界上某点此刻在屏幕的哪儿 —— 断言"跳没跳"要看这个，不是看 cam.x */
const screenXOf = (worldX, cam) => (worldX + cam.x) * cam.z;

describe('坐标换算', () => {
  it('往返自洽', () => {
    const cam = { x: 120, y: -40, z: 1.5 };
    const w = { x: 33, y: 77 };
    const s = worldToScreen(w, cam);
    const back = screenToWorld(s, cam);
    expect(back.x).toBeCloseTo(w.x);
    expect(back.y).toBeCloseTo(w.y);
  });

  it('cam.x 变大内容向右走（符号方向）', () => {
    const a = worldToScreen({ x: 100, y: 0 }, { x: 0, y: 0, z: 1 });
    const b = worldToScreen({ x: 100, y: 0 }, { x: 50, y: 0, z: 1 });
    expect(a.x).toBe(100);
    expect(b.x).toBe(150);
  });

  it('屏幕位移换世界位移要除以 z（拖拽跟手感的根据）', () => {
    expect(screenDeltaToWorld({ x: 100, y: 50 }, { x: 0, y: 0, z: 2 })).toEqual({ x: 50, y: 25 });
  });
});

describe('矩形工具', () => {
  it('union 取并集', () => {
    expect(boxUnion([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }]))
      .toEqual({ x: 0, y: 0, w: 30, h: 15 });
  });

  it('空输入返回 null', () => {
    expect(boxUnion([])).toBeNull();
    expect(boxUnion([null, undefined])).toBeNull();
  });

  /**
   * 缺陷 2（已修）：过滤只查 w/h 不查 x/y。
   * 坏数据最常来自 board.json 持久化的**坐标**，正好是没被查的那两个字段。
   * 一个 NaN 穿过去 → 相机 NaN → 所有 transform NaN → 整块画布白屏且不自愈。
   */
  it('坐标是 NaN 的矩形要被滤掉，不能毒进相机', () => {
    const u = boxUnion([{ x: NaN, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 50, h: 50 }]);
    expect(u).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    const cam = constrainCamera({ x: 0, y: 0, z: 1 }, IDENTITY_CAMERA, base({ bounds: u }));
    expect(Number.isFinite(cam.x)).toBe(true);
    expect(Number.isFinite(cam.y)).toBe(true);
  });

  it('四个字段任一非有限都滤掉', () => {
    for (const bad of [{ x: 0, y: NaN, w: 1, h: 1 }, { x: 0, y: 0, w: Infinity, h: 1 }, { x: 0, y: 0, w: 1, h: NaN }]) {
      expect(boxUnion([bad])).toBeNull();
    }
  });

  it('expand 四边同时外扩', () => {
    expect(boxExpand({ x: 10, y: 10, w: 100, h: 50 }, 5)).toEqual({ x: 5, y: 5, w: 110, h: 60 });
  });
});

describe('自然缩放与 contain', () => {
  it('自然缩放 = 内容含内边距正好填满视口', () => {
    const { zx } = naturalZoom({ x: 0, y: 0, w: 952, h: 100 }, VP);
    expect(zx).toBeCloseTo(1);   // (1000 - 48) / 952
  });

  /**
   * 缺陷 1（已修）：退化轴兜底 1 会把 contain 推进 lo > hi 的 clamp。
   *
   * `clamp(v, lo, hi) = Math.min(hi, Math.max(lo, v))` 在 lo > hi 时**恒返回
   * hi**，跟请求值无关。修前实测：视口 1000×800、bounds 宽为 0 时，
   * z=0.999 内容点在屏幕 500，z=1.000 跳到 24 —— 千分之一的缩放变化带来
   * 476px 跳变。兜 Infinity 后 `z < Infinity` 恒真，退化轴永远走停靠。
   */
  it('宽为 0 的退化轴：兜 Infinity，跨 z=1 不跳', () => {
    expect(naturalZoom({ x: 0, y: 0, w: 0, h: 100 }, VP).zx).toBe(Infinity);
    const opts = base({ bounds: { x: 0, y: 0, w: 0, h: 100 } });
    const xs = [0.5, 0.999, 1, 1.001, 3].map(z => {
      const cam = constrainCamera({ x: 500, y: 0, z }, IDENTITY_CAMERA, opts);
      return screenXOf(0, cam);
    });
    // 全程钉在视口水平中心（origin.x = 0.5），一次都不跳
    for (const x of xs) expect(x).toBeCloseTo(500, 6);
  });

  it('高为 0 的退化轴同样不跳', () => {
    const opts = base({ bounds: { x: 0, y: 0, w: 100, h: 0 } });
    const ys = [0.5, 1, 2].map(z => {
      const cam = constrainCamera({ x: 0, y: 300, z }, IDENTITY_CAMERA, opts);
      return (0 + cam.y) * cam.z;
    });
    for (const y of ys) expect(y).toBeCloseTo(CAMERA_PADDING.y, 6);   // origin.y = 0 → 贴顶
  });

  it('z 低于自然缩放：按 origin 停靠（水平居中 / 垂直贴顶）', () => {
    const cam = constrainCamera({ x: 9999, y: 9999, z: 0.2 }, IDENTITY_CAMERA, base());
    const cx = (CONTENT.x + CONTENT.w / 2 + cam.x) * cam.z;
    expect(cx).toBeCloseTo(VP.w / 2);                       // 水平居中
    expect((CONTENT.y + cam.y) * cam.z).toBeCloseTo(CAMERA_PADDING.y);   // 垂直贴顶
  });

  it('z 高于自然缩放：夹在内容边界内，两边都够得着', () => {
    const hi = constrainCamera({ x: 99999, y: 0, z: 1 }, IDENTITY_CAMERA, base());
    expect((CONTENT.x + hi.x) * hi.z).toBeCloseTo(CAMERA_PADDING.x);      // 左沿贴左内边距
    const lo = constrainCamera({ x: -99999, y: 0, z: 1 }, IDENTITY_CAMERA, base());
    expect((CONTENT.x + CONTENT.w + lo.x) * lo.z).toBeCloseTo(VP.w - CAMERA_PADDING.x);  // 右沿贴右
  });

  it('z 正好等于自然缩放时两条分支数值连续', () => {
    const bounds = { x: 0, y: 0, w: (VP.w - 48), h: 100 };   // zx 恰为 1
    const a = constrainCamera({ x: 0, y: 0, z: 1 - 1e-9 }, IDENTITY_CAMERA, base({ bounds }));
    const b = constrainCamera({ x: 0, y: 0, z: 1 }, IDENTITY_CAMERA, base({ bounds }));
    expect(a.x).toBeCloseTo(b.x, 5);
  });

  it("behavior 'free' 完全不夹", () => {
    const cam = constrainCamera({ x: 99999, y: 0, z: 1 }, IDENTITY_CAMERA, base({ behavior: 'free' }));
    expect(cam.x).toBe(99999);
  });

  it('两轴可以各来各的规则', () => {
    const cam = constrainCamera({ x: 99999, y: 99999, z: 1 }, IDENTITY_CAMERA,
      base({ behavior: { x: 'free', y: 'contain' } }));
    expect(cam.x).toBe(99999);
    expect(cam.y).not.toBe(99999);
  });
});

describe('缩放夹取与焦点', () => {
  it('z 夹在档位范围内', () => {
    expect(constrainCamera({ x: 0, y: 0, z: 99 }, IDENTITY_CAMERA, base()).z).toBe(ZOOM_MAX);
    expect(constrainCamera({ x: 0, y: 0, z: 0.001 }, IDENTITY_CAMERA, base()).z).toBe(ZOOM_MIN);
  });

  it('在光标处缩放，光标底下那个点不动', () => {
    const cam = { x: 0, y: 0, z: 1 };
    const pt = { x: 300, y: 220 };
    const before = screenToWorld(pt, cam);
    const next = zoomAtScreenPoint(cam, pt, 2.5);
    const after = screenToWorld(pt, next);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  /**
   * zoomAt 之后再 constrain，z 被夹住时焦点还得守住。
   * 判据是「先 zoomAt 到越界 z 再夹」要跟「直接 zoomAt 到夹后的 z」逐位相等。
   */
  it('缩放越界被夹时，结果等同于直接缩到上限（焦点不跳）', () => {
    const cam = { x: 0, y: 0, z: 1 };
    const pt = { x: 400, y: 300 };
    const con = constrainCamera(zoomAtScreenPoint(cam, pt, 10), cam, base({ behavior: 'free' }));
    const direct = zoomAtScreenPoint(cam, pt, ZOOM_MAX);
    expect(con.z).toBe(ZOOM_MAX);
    expect(con.x).toBeCloseTo(direct.x, 9);
    expect(con.y).toBeCloseTo(direct.y, 9);
  });

  /**
   * 缺陷 3a（已修）：请求 z 与当前 z 相同（= 纯平移）时原来返回 current，
   * 把这一帧的平移整个吃掉。这条分支只在当前相机本身越界时可达
   * （持久化的相机遇上后来变小的档位）。
   */
  it('当前相机越界时的纯平移不该被吃掉', () => {
    const stale = { x: -300, y: -200, z: 5 };            // z 超过 ZOOM_MAX=3
    const cam = constrainCamera({ x: -400, y: -250, z: 5 }, stale, base({ behavior: 'free', zoomMax: 3 }));
    expect(cam.z).toBe(3);
    expect(cam.x).toBe(-400);                            // 平移保住了
    expect(cam.y).toBe(-250);
  });

  /**
   * 缺陷 3b（已修）：current.z = 0 时 1/0 = Infinity，分子分母都是 ±Infinity，
   * 相除得 NaN。原来的守卫写的是 `denom === 0`，罩不住这个。
   */
  it('current.z 为 0 也不吐 NaN', () => {
    const cam = constrainCamera({ x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }, base());
    expect(Number.isFinite(cam.x)).toBe(true);
    expect(Number.isFinite(cam.y)).toBe(true);
    expect(Number.isFinite(cam.z)).toBe(true);
  });

  it('不传 z = 保持当前缩放（纯平移调用方不该被迫拼字段）', () => {
    const cur = { x: 0, y: 0, z: 2 };
    const cam = constrainCamera({ x: 5, y: 5 }, cur, base({ behavior: 'free' }));
    expect(cam.z).toBe(2);
    expect(Number.isFinite(cam.x)).toBe(true);
  });

  it('档位步进到头就停住', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
});

describe('入镜与可视区', () => {
  it('fitBox 把矩形正中摆进视口', () => {
    const cam = fitBox({ x: 100, y: 200, w: 400, h: 300 }, VP);
    expect(cam.z).toBe(1);                       // maxZoom 默认 1，不放大小卡片
    const c = worldToScreen({ x: 300, y: 350 }, cam);
    expect(c.x).toBeCloseTo(VP.w / 2);
    expect(c.y).toBeCloseTo(VP.h / 2);
  });

  it('大矩形按较紧的那根轴缩', () => {
    const cam = fitBox({ x: 0, y: 0, w: 4000, h: 1000 }, VP);
    expect(cam.z).toBeCloseTo((VP.w - 48) / 4000);
  });

  it('单边为 0（只有一行物件时 union 就是条横线）按另一轴 fit，不退回原点', () => {
    const cam = fitBox({ x: 0, y: 0, w: 4000, h: 0 }, VP);
    expect(cam.z).toBeCloseTo((VP.w - 48) / 4000);
    expect(cam.z).not.toBe(1);
  });

  it('视口还没量出来（首帧）返回单位相机而不是任意值', () => {
    expect(fitBox({ x: 0, y: 0, w: 100, h: 100 }, { w: 0, h: 0 })).toEqual(IDENTITY_CAMERA);
  });

  it('可视区世界矩形随缩放变大变小', () => {
    const wide = viewportWorldBox({ x: 0, y: 0, z: 0.5 }, VP);
    const tight = viewportWorldBox({ x: 0, y: 0, z: 2 }, VP);
    expect(wide.w).toBe(2000);
    expect(tight.w).toBe(500);
  });
});
