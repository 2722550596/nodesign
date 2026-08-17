// @vitest-environment happy-dom
/**
 * 框选手势的回归（2026-08-17）。
 *
 * ## 这条测试为什么存在
 *
 * `useMarquee` 从 BoardCanvas 拆出来时漏带了三样东西（`onChrome` / `sizeOf` /
 * `recentDragMovedRef`）—— 它们原来在组件作用域里，搬走之后既没 import 也没
 * 进参数。`armMarquee` 第二行就调 `onChrome`，于是**画布上每一次 pointerdown
 * 都抛 ReferenceError**；而画布 pane 的 handler 是
 *
 *     armMarquee(e); camera.onPointerDown(e);
 *
 * 前一句炸了后一句永远执行不到 = **画布完全没法拖**。上了生产才被用户发现。
 *
 * `no-undef.lint` 现在能扫出这一类；这条测试钉的是**行为**：按下去不许炸，
 * 而且相机那一路必须还能接着跑。两条都要 —— lint 管的是"名字有没有来处"，
 * 它拦不住"手势顺序被谁挪坏了"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useMarquee } from './useMarquee.js';

/** 挂一个探针组件，把 hook 的三个手势口取出来 */
function mountMarquee(deps) {
  const out = {};
  function Probe() {
    Object.assign(out, useMarquee(deps));
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<Probe />); });
  return { out, cleanup: () => act(() => root.unmount()) };
}

/** 画布上一次真实的按下：target 是真 DOM（onChrome 要对它调 closest） */
function pointerEvent(target, { x = 400, y = 300, button = 0, pointerId = 1 } = {}) {
  return { target, clientX: x, clientY: y, button, pointerId };
}

function makeDeps(over = {}) {
  const pane = document.createElement('div');
  document.body.appendChild(pane);
  return {
    camera: {
      toWorld: (cx, cy) => ({ x: cx, y: cy }),
      onPointerUp: vi.fn(),
    },
    paneRef: { current: pane },
    toolRef: { current: 'select' },
    positionedRef: { current: [] },
    folderViewRef: { current: [] },
    setSelectedIds: vi.fn(),
    recentDragMovedRef: { current: false },
    ...over,
  };
}

describe('useMarquee', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('在空地按下去不抛异常（拆模块漏 import 时这里就红了）', () => {
    const deps = makeDeps();
    const { out, cleanup } = mountMarquee(deps);
    const blank = document.createElement('div');
    document.body.appendChild(blank);
    expect(() => out.armMarquee(pointerEvent(blank))).not.toThrow();
    cleanup();
  });

  it('按在界面控件上不起框选（onChrome 那道判据真的在跑）', () => {
    const deps = makeDeps();
    const { out, cleanup } = mountMarquee(deps);
    const btn = document.createElement('button');
    btn.setAttribute('data-tool-btn', '');
    document.body.appendChild(btn);
    out.armMarquee(pointerEvent(btn));
    act(() => { vi.advanceTimersByTime(400); });
    // 起了框选的话这里会先撤一次相机平移；没起就一次都不该调
    expect(deps.camera.onPointerUp).not.toHaveBeenCalled();
    cleanup();
  });

  it('长按满时长 → 起框；抬手按相交判据选中，且不抛异常', () => {
    const deps = makeDeps({
      positionedRef: { current: [{ id: 'a.png', type: 'image', pos: { x: 380, y: 280 } }] },
      folderViewRef: { current: [{ id: '素材', x: 5000, y: 5000, w: 288, h: 240 }] },
    });
    const { out, cleanup } = mountMarquee(deps);
    const blank = document.createElement('div');
    document.body.appendChild(blank);

    act(() => { out.armMarquee(pointerEvent(blank, { x: 300, y: 200 })); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(deps.camera.onPointerUp).toHaveBeenCalled();     // 转框选时撤掉已武装的平移

    act(() => { out.moveMarquee(pointerEvent(blank, { x: 700, y: 600 })); });
    let ate;
    expect(() => { act(() => { ate = out.endMarquee(); }); }).not.toThrow();
    expect(ate).toBe(true);                                  // 这一下被框选吃掉了
    expect(deps.setSelectedIds).toHaveBeenLastCalledWith(['a.png']);   // 框住的那张
    expect(deps.recentDragMovedRef.current).toBe(true);      // 别把这一下当点击
    cleanup();
  });

  it('手一动就作废长按（那是平移，不能抢）', () => {
    const deps = makeDeps();
    const { out, cleanup } = mountMarquee(deps);
    const blank = document.createElement('div');
    document.body.appendChild(blank);
    act(() => { out.armMarquee(pointerEvent(blank, { x: 300, y: 200 })); });
    // 220ms 之内移开 >4px
    expect(out.moveMarquee(pointerEvent(blank, { x: 340, y: 200 }))).toBe(false);
    act(() => { vi.advanceTimersByTime(400); });
    expect(deps.camera.onPointerUp).not.toHaveBeenCalled();  // 没转框选 = 这一路归相机
    cleanup();
  });
});
