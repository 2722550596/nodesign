// 子页直开的路径换算（2026-08-18）。
// 这是纯函数但踩的是两个真实存在的坑：`pages` 是站点相对、preview_deck 给的是
// 工作区相对；以及根站的 root 合法地是**空串**（这仓库的"空串病族"已经咬过好几次）。
import { describe, it, expect } from 'vitest';
import { sitePageFrom } from './useBoardOpen.js';

const sub = { root: 'chenxi-beauty', pages: ['index.html', 'about.html', 'journal/换季自救.html'] };
const rootSite = { root: '', pages: ['index.html', 'ritual.html'] };

describe('sitePageFrom', () => {
  it('子目录站：剥掉站点根那一段', () => {
    expect(sitePageFrom(sub, 'chenxi-beauty/about.html')).toBe('about.html');
    expect(sitePageFrom(sub, 'chenxi-beauty/journal/换季自救.html')).toBe('journal/换季自救.html');
  });

  it('⭐ 根站的 root 是空串，不能因此整个跳过', () => {
    expect(sitePageFrom(rootSite, 'ritual.html')).toBe('ritual.html');
  });

  it('⭐ 不在 pages 清单里的页 → null（宁可开首页，也别开一个空白页）', () => {
    expect(sitePageFrom(sub, 'chenxi-beauty/还没写出来.html')).toBeNull();
    expect(sitePageFrom(rootSite, '别的站/index.html')).toBeNull();
  });

  it('不是这个站的路径 → null', () => {
    expect(sitePageFrom(sub, 'other-site/about.html')).toBeNull();
    expect(sitePageFrom(sub, 'chenxi-beautyXX/about.html')).toBeNull();
  });

  it('非 html → null（css/图片不是"页"）', () => {
    expect(sitePageFrom(sub, 'chenxi-beauty/style.css')).toBeNull();
  });

  it('入口本身也认（等价于不传）', () => {
    expect(sitePageFrom(sub, 'chenxi-beauty/index.html')).toBe('index.html');
  });

  it('没传路径 / 传了非字符串 → null', () => {
    expect(sitePageFrom(sub, null)).toBeNull();
    expect(sitePageFrom(sub, undefined)).toBeNull();
    expect(sitePageFrom(sub, 123)).toBeNull();
  });

  it('反斜杠与 ./ 前缀归一', () => {
    expect(sitePageFrom(sub, './chenxi-beauty/about.html')).toBe('about.html');
    expect(sitePageFrom(sub, 'chenxi-beauty\\about.html')).toBe('about.html');
  });

  it('pages 缺失时不炸', () => {
    expect(sitePageFrom({ root: 'x' }, 'x/a.html')).toBeNull();
  });
});
