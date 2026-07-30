import { describe, it, expect } from 'vitest';
import { overlayBase, toOverlayXY } from './overlay-rect.js';

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
