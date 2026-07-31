import { describe, it, expect } from 'vitest';
import { overlayBase, toOverlayXY, placeFloatingCard } from './overlay-rect.js';

/** 造一对 iframe / offsetParent 的假 DOM：容器可滚，iframe 在容器内容里某处 */
function makePair({ containerLeft = 100, containerTop = 50, iframeContentX = 40, iframeContentY = 20, scrollLeft = 0, scrollTop = 0 }) {
  const offsetParent = {
    scrollLeft, scrollTop,
    getBoundingClientRect: () => ({ left: containerLeft, top: containerTop }),
  };
  const iframe = {
    offsetParent,
    // 视觉位置 = 容器视觉左上 - 滚动量 + 内容内偏移
    getBoundingClientRect: () => ({
      left: containerLeft - scrollLeft + iframeContentX,
      top: containerTop - scrollTop + iframeContentY,
    }),
  };
  return { iframe, offsetParent };
}

describe('overlayBase — absolute 子元素的包含块随容器滚动', () => {
  it('不滚时 = 视觉差', () => {
    const { iframe } = makePair({});
    expect(overlayBase(iframe)).toMatchObject({ x: 40, y: 20 });
  });

  it('横滚 150 时仍指向 iframe 在内容里的原位（不是视觉差 -110）', () => {
    const { iframe } = makePair({ scrollLeft: 150 });
    expect(overlayBase(iframe).x).toBe(40);
  });

  it('纵滚 300 同理', () => {
    const { iframe } = makePair({ scrollTop: 300 });
    expect(overlayBase(iframe).y).toBe(20);
  });

  it('无 offsetParent 返回 null（调用方据此不渲染）', () => {
    expect(overlayBase({ offsetParent: null, getBoundingClientRect: () => ({}) })).toBe(null);
    expect(overlayBase(null)).toBe(null);
  });
});

describe('toOverlayXY — 内部坐标按 zoom 缩放后落到 overlay 坐标系', () => {
  it('zoom=1 直接相加', () => {
    const { iframe } = makePair({});
    expect(toOverlayXY(overlayBase(iframe), 200, 100, 1)).toEqual({ left: 240, top: 120 });
  });

  it('zoom=0.5 时内部坐标折半', () => {
    const { iframe } = makePair({});
    expect(toOverlayXY(overlayBase(iframe), 200, 100, 0.5)).toEqual({ left: 140, top: 70 });
  });

  it('缩放 + 滚动同时存在时两者独立生效', () => {
    const { iframe } = makePair({ scrollLeft: 500, scrollTop: 200 });
    expect(toOverlayXY(overlayBase(iframe), 400, 300, 0.25)).toEqual({ left: 140, top: 95 });
  });
});

describe('placeFloatingCard — 卡片贴元素浮出（2026-07-31「评论卡飘到别处」回归）', () => {
  /** deck letterbox 场景：1920×1080 画幅装进 1400×900 的窗口 */
  const deckBase = () => {
    const zoom = Math.min(1400 / 1920, 900 / 1080);   // = 0.7292，contain 语义
    const visW = 1920 * zoom;                          // 1400（铺满宽）
    const visH = 1080 * zoom;                          // 787.5
    return {
      zoom,
      base: {
        x: (1400 - visW) / 2,                          // 0
        y: (900 - visH) / 2,                           // 56.25 ← 就是这个被漏掉了
        iframeRect: { width: visW, height: visH },
      },
    };
  };

  it('把 iframe 的居中留白算进去（老代码漏的就是这一项）', () => {
    const { base, zoom } = deckBase();
    const el = { left: 100, top: 200, width: 300 };
    const { top } = placeFloatingCard(base, el, zoom, { cardWidth: 340, cardHeight: 200, offset: 8 });
    // 正确值 = 留白 + 元素视觉 top
    expect(top).toBeCloseTo(base.y + 200 * zoom, 5);
    // 老算法（只乘 zoom）会少 base.y，差出整整一个留白
    expect(top - 200 * zoom).toBeCloseTo(base.y, 5);
    expect(base.y).toBeGreaterThan(50);   // 这个偏差是肉眼可见的量级
  });

  it('16:9 的窗口没有留白 → 症状自己消失（解释为什么它时有时无）', () => {
    const zoom = 1600 / 1920;
    const base = { x: 0, y: 0, iframeRect: { width: 1600, height: 900 } };
    const el = { left: 100, top: 200, width: 300 };
    const { top } = placeFloatingCard(base, el, zoom, { cardWidth: 340, cardHeight: 200, offset: 8 });
    expect(top).toBeCloseTo(200 * zoom, 5);   // 跟老算法结果一致
  });

  it('默认贴元素右侧', () => {
    const base = { x: 10, y: 20, iframeRect: { width: 1000, height: 800 } };
    const { left } = placeFloatingCard(base, { left: 100, top: 0, width: 200 }, 1,
      { cardWidth: 340, cardHeight: 100, offset: 8 });
    expect(left).toBe(10 + 100 + 200 + 8);
  });

  it('右边放不下 → 翻到元素左侧', () => {
    const base = { x: 0, y: 0, iframeRect: { width: 800, height: 600 } };
    const { left } = placeFloatingCard(base, { left: 600, top: 0, width: 100 }, 1,
      { cardWidth: 340, cardHeight: 100, offset: 8 });
    expect(left).toBe(600 - 340 - 8);
  });

  it('钳位用 iframe 视觉盒而不是容器（两套坐标系混用是第二层错）', () => {
    // iframe 在容器里偏了 200，视觉盒只有 400 宽
    const base = { x: 200, y: 100, iframeRect: { width: 400, height: 300 } };
    const { left, top } = placeFloatingCard(base, { left: 380, top: 280, width: 10 }, 1,
      { cardWidth: 340, cardHeight: 200, offset: 8 });
    // 左边界不能小于 base.x + offset（老代码会钳到 8，跑到 iframe 左边的画布空白上）
    expect(left).toBeGreaterThanOrEqual(200 + 8);
    // 下边界按视觉盒底算，不是容器底
    expect(top).toBeLessThanOrEqual(100 + 300 - 8 - 200 + 0.001);
  });

  it('元素比视觉盒还大时不会算出负坐标', () => {
    const base = { x: 50, y: 50, iframeRect: { width: 200, height: 150 } };
    const { left, top } = placeFloatingCard(base, { left: 0, top: 0, width: 1000 }, 1,
      { cardWidth: 340, cardHeight: 500, offset: 8 });
    expect(left).toBe(50 + 8);
    expect(top).toBe(50 + 8);
  });
});
