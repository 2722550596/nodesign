// @vitest-environment happy-dom
/**
 * 边缘贴纸（2026-08-21）。钉住三件事，每一件都是真栽过的：
 *   1. 点贴纸打开的卡**不许自己收**——触屏上指针永远不会"进卡"，
 *      老代码那条 1.2s 兜底会在点开 1.2 秒后把卡收走，手机上等于按钮失灵。
 *   2. 贴纸的命中区必须比看得见的那一片大（手指没有像素级准头）。
 *   3. 撕口的 clip-path 只能画在里面那片纸上——画在按钮本体上会把命中区一起裁掉。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ChatDock from './ChatDock.jsx';
import { TAB_HIT, TAB_LEN } from '../ui/EdgeTab.jsx';

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ChatDock {...props}>{() => <div data-testid="panel" />}</ChatDock>);
  });
  return {
    host,
    tab: () => host.querySelector('[data-edge-tab]'),
    card: () => [...host.querySelectorAll('div')].find(d => d.style.zIndex === '120'),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('ChatDock 的边缘贴纸', () => {
  it('一进来卡是关着的，但贴纸在（关着也得有入口）', () => {
    const m = mount({});
    expect(m.tab()).toBeTruthy();
    expect(m.card().style.visibility).toBe('hidden');
    expect(m.tab().getAttribute('aria-expanded')).toBe('false');
    m.unmount();
  });

  it('点贴纸打开，2 秒之后还开着 —— 触屏上没有"鼠标进卡"这回事', () => {
    vi.useFakeTimers();
    const m = mount({});
    act(() => { m.tab().click(); });
    expect(m.card().style.visibility).toBe('visible');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(m.card().style.visibility, '被 1.2s 兜底计时器收走了：手机上点开就没').toBe('visible');
    m.unmount();
  });

  it('再点一下收起，贴纸的 aria-expanded 跟着翻', () => {
    const m = mount({});
    act(() => { m.tab().click(); });
    expect(m.tab().getAttribute('aria-expanded')).toBe('true');
    act(() => { m.tab().click(); });
    expect(m.card().style.visibility).toBe('hidden');
    expect(m.tab().getAttribute('aria-expanded')).toBe('false');
    m.unmount();
  });

  it('命中区比看得见的那一片大，且锯齿不在按钮本体上（裁了会连命中区一起裁）', () => {
    const m = mount({});
    const btn = m.tab();
    const paper = btn.firstElementChild;
    expect(Number.parseFloat(btn.style.width)).toBe(TAB_HIT);
    expect(Number.parseFloat(btn.style.height)).toBe(TAB_LEN);
    expect(Number.parseFloat(paper.style.width)).toBeLessThan(TAB_HIT);
    expect(Number.parseFloat(paper.style.height)).toBeLessThan(TAB_LEN);
    expect(btn.style.clipPath, 'clip-path 画在按钮上 = 中心点可能落进缺口里').toBeFalsy();
    expect(paper.style.clipPath).toContain('polygon');
    m.unmount();
  });

  it('窄屏上卡铺满但留出贴纸那一条', () => {
    const real = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true });
    const m = mount({});
    act(() => { m.tab().click(); });
    const w = Number.parseFloat(m.card().style.width);
    expect(w).toBeLessThan(393 - TAB_HIT / 2);   // 贴纸压不出屏
    expect(w).toBeGreaterThan(300);              // 也不至于缩成一条
    m.unmount();
    Object.defineProperty(window, 'innerWidth', { value: real, configurable: true });
  });
});
