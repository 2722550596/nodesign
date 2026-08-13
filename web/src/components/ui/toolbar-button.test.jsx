// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Rocket } from 'lucide-react';
import ToolbarButton, { TOOL_BTN, toolPillStyle } from './ToolbarButton.jsx';

/**
 * 工具条按钮的身位锁。
 *
 * 起因：工具栏开了 `node` 组的逃生口之后，自定义控件（站点的「上线」）各写各的
 * 按钮 —— 一个 30 高、一个 `3px 9px` 的小胶囊，配色一个墨面一个纸面。用户的话是
 * 「按钮的宽度也得对齐啊喂..现在看起来太扁了」。
 *
 * 抽成共用组件之后，**这里钉的是"没人再自己定尺寸"**：按钮、纯图标按钮、
 * 以及跟它们并排的非按钮底座（链接药丸），高度必须同一个数。
 * 这种偏差肉眼在 640px 宽的一条工具栏上看不出来，只能量。
 */

let host;
let root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (el) => { act(() => root.render(el)); return host.firstChild; };

describe('ToolbarButton 身位', () => {
  it('带文字的：高度取 TOOL_BTN.height，圆角是胶囊那档', () => {
    const b = render(<ToolbarButton icon={Rocket} label="上线" onClick={() => {}} />);
    expect(b.style.height).toBe(`${TOOL_BTN.height}px`);
    expect(b.style.borderRadius).toBe(`${TOOL_BTN.radius}px`);
    expect(b.style.width).toBe('auto');
  });

  it('纯图标的：正方形 + 正圆', () => {
    const b = render(<ToolbarButton icon={Rocket} title="复制" onClick={() => {}} />);
    expect(b.style.height).toBe(`${TOOL_BTN.height}px`);
    expect(b.style.width).toBe(`${TOOL_BTN.height}px`);
    expect(b.style.borderRadius).toBe(`${TOOL_BTN.radiusIcon}px`);
  });

  it('并排的非按钮底座跟按钮同高（链接药丸那种）', () => {
    expect(toolPillStyle.height).toBe(TOOL_BTN.height);
    expect(toolPillStyle.borderRadius).toBe(TOOL_BTN.radius);
    expect(toolPillStyle.fontSize).toBe(TOOL_BTN.fontSize);
  });

  /**
   * 工具栏靠 `data-tool-btn` 认出"按在按钮上，不起拖"。掉了的话按钮还能点，
   * 但**按住按钮拖会把整条工具栏拖走** —— 属于不报错的那类。
   */
  it('带着 data-tool-btn（工具栏靠它区分"按按钮"和"拖工具栏"）', () => {
    const b = render(<ToolbarButton icon={Rocket} label="上线" dataId="publish" onClick={() => {}} />);
    expect(b.getAttribute('data-tool-btn')).toBe('publish');
  });

  it('禁用时不触发 onClick，且光标是 not-allowed', () => {
    let hits = 0;
    const b = render(<ToolbarButton icon={Rocket} label="上线" disabled onClick={() => { hits += 1; }} />);
    expect(b.style.cursor).toBe('not-allowed');
    act(() => { b.click(); });
    expect(hits).toBe(0);
  });
});
