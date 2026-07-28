import { describe, it, expect } from 'vitest';
import { resolveObjectId, zoneOfObjectId } from './stage.js';

/**
 * 产物寻址的前端一半（2026-07-28 加站点）。
 *
 * 这里固化的是**同名文件在两种任务下含义相反**这件事：`tasks/x/about.html`
 * 在 deck 任务里是一份试作（独立一张卡），在站点任务里是一个子页（并进整站那
 * 一张卡）。判错了不会报错，只会在桌面上多冒几张卡，所以必须有测试盯着。
 */
describe('resolveObjectId — 任务形态决定物件归属', () => {
  const SITES = new Set(['我的站']);

  it('deck 任务：canvas.html 是主 deck，其余 .html 各自是试作', () => {
    expect(resolveObjectId('tasks/某deck/canvas.html', 'sid')).toBe('deck:task/某deck');
    expect(resolveObjectId('tasks/某deck/proto-暖调.html', 'sid'))
      .toBe('deck:task/某deck/proto-暖调.html');
  });

  it('站点任务：入口页 / 子页 / 样式表全部收敛到同一个站点物件', () => {
    expect(resolveObjectId('tasks/我的站/index.html', 'sid', SITES)).toBe('site:task/我的站');
    expect(resolveObjectId('tasks/我的站/about.html', 'sid', SITES)).toBe('site:task/我的站');
    expect(resolveObjectId('tasks/我的站/style.css', 'sid', SITES)).toBe('site:task/我的站');
    expect(resolveObjectId('tasks/我的站/posts/first.html', 'sid', SITES)).toBe('site:task/我的站');
  });

  it('不知道哪些任务是站点时（siteTasks 缺省）退回 deck 语义，不猜', () => {
    expect(resolveObjectId('tasks/我的站/about.html', 'sid'))
      .toBe('deck:task/我的站/about.html');
  });

  it('绝对路径 / 带前缀路径同样命中', () => {
    expect(resolveObjectId('/w/sessions/s1/tasks/我的站/index.html', 'sid', SITES))
      .toBe('site:task/我的站');
  });

  it('站点里的非产物文件不越界成别的任务', () => {
    expect(resolveObjectId('tasks/别的任务/style.css', 'sid', SITES))
      .toBe('tasks/别的任务/style.css');
  });
});

describe('zoneOfObjectId — 站点物件落对工作区', () => {
  it('site:task/<名> 归属该任务区', () => {
    expect(zoneOfObjectId('site:task/我的站', 'sid')).toBe('task/我的站');
  });

  it('deck 的两种形态照旧', () => {
    expect(zoneOfObjectId('deck:task/某deck', 'sid')).toBe('task/某deck');
    expect(zoneOfObjectId('deck:task/某deck/proto-A.html', 'sid')).toBe('task/某deck');
  });

  it('旧式会话 deck 仍按 session 归属', () => {
    expect(zoneOfObjectId('deck:sid-123', 'sid-123')).toBe('sid-123');
  });
});
