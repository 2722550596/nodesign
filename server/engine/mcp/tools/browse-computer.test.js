/**
 * browse-computer：坐标 1:1 的前提 + 键名/修饰键翻译 + 坐标校验（2026-08-21）
 *
 * 最要紧的是第一条：视口必须落在 shot-pipeline 不缩图的范围内。视口和阈值分住
 * 两个文件，谁改了一边另一边不会知道 —— 这条断言就是把两边钉在一起的钉子。
 */
import { describe, it, expect } from 'vitest';
import { _limits } from '../../browse/registry.js';
import { API_IMAGE_LIMITS } from './helpers/shot-pipeline.js';
import { ACTIONS, parseChords, parseModifiers, checkCoord } from './browse-computer.js';

describe('browser_computer 坐标空间', () => {
  it('视口在归一化阈值内：截图不缩，截图像素 = 视口像素', () => {
    const { width: w, height: h } = _limits.VIEWPORT;
    const scale = Math.min(1, API_IMAGE_LIMITS.longEdge / Math.max(w, h), Math.sqrt(API_IMAGE_LIMITS.maxPixels / (w * h)));
    expect(scale).toBe(1);
  });

  it('动作表 = browser_toolset_20260801 的指针/键盘/截图成员', () => {
    expect(ACTIONS).toEqual([
      'screenshot', 'zoom',
      'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover',
      'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move',
      'scroll', 'scroll_to',
      'type', 'key', 'hold_key', 'wait',
    ]);
  });

  it('checkCoord：视口内放行，越界/畸形给可读错误', () => {
    expect(checkCoord([0, 0])).toBeNull();
    expect(checkCoord([_limits.VIEWPORT.width, _limits.VIEWPORT.height])).toBeNull();
    expect(checkCoord([-1, 10])).toMatch(/outside/);
    expect(checkCoord([10, 99999])).toMatch(/outside/);
    expect(checkCoord([1])).toMatch(/\[x, y\]/);
    expect(checkCoord(['a', 'b'])).toMatch(/\[x, y\]/);
  });
});

describe('键名翻译（xdotool 风格 → Playwright）', () => {
  it('单键 / 和弦 / 序列', () => {
    expect(parseChords('Return')).toEqual([['Enter']]);
    expect(parseChords('Enter')).toEqual([['Enter']]);
    expect(parseChords('ctrl+s')).toEqual([['Control', 's']]);
    expect(parseChords('cmd+shift+a')).toEqual([['Meta', 'Shift', 'a']]);
    expect(parseChords('Backspace Backspace Delete')).toEqual([['Backspace'], ['Backspace'], ['Delete']]);
    expect(parseChords('shift+Tab Tab')).toEqual([['Shift', 'Tab'], ['Tab']]);
    expect(parseChords('Page_Down')).toEqual([['PageDown']]);
    expect(parseChords('F5')).toEqual([['F5']]);
    expect(parseChords('Escape')).toEqual([['Escape']]);
    expect(parseChords('a')).toEqual([['a']]);
  });
  it('只有修饰键没有主键 → 报错（别静默按个空）', () => {
    expect(() => parseChords('ctrl')).toThrow(/only modifiers/);
    expect(() => parseChords('')).toThrow(/needs a key/);
  });
  it('parseModifiers', () => {
    expect(parseModifiers('')).toEqual([]);
    expect(parseModifiers(undefined)).toEqual([]);
    expect(parseModifiers('ctrl+shift')).toEqual(['Control', 'Shift']);
    expect(parseModifiers('super')).toEqual(['Meta']);
    expect(() => parseModifiers('hyper')).toThrow(/unknown modifier/);
  });
});
