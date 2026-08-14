import { describe, it, expect } from 'vitest';
import { pickHero } from './hero.js';

const b = (type, from, to, by = 'user') => ({ type, from, to, by });

describe('pickHero', () => {
  it('唯一产物卡 = 天然主角；没有产物卡 = 没主角', () => {
    expect(pickHero([{ id: 'site:', type: 'site' }, { id: 'a.png', type: 'image' }], {})).toBe('site:');
    expect(pickHero([{ id: 'a.png', type: 'image' }], {})).toBe(null);
  });

  it('改自链：现役版赢过站点，旧版重罚', () => {
    const items = [
      { id: 'site:', type: 'site' },
      { id: 'deck:v1.html', type: 'deck' },
      { id: 'deck:v2.html', type: 'deck' },
    ];
    const hero = pickHero(items, { e: b('derives-from', 'deck:v2.html', 'deck:v1.html') });
    expect(hero).toBe('deck:v2.html');
  });

  it('并列最高 = 没证据 = 没主角（整理必须可预期）', () => {
    const items = [
      { id: 'deck:a.html', type: 'deck' },
      { id: 'deck:b.html', type: 'deck' },
    ];
    expect(pickHero(items, {})).toBe(null);
  });

  it('被自动取材指着的重罚（素材不当主角）', () => {
    const items = [
      { id: 'deck:a.html', type: 'deck' },
      { id: 'deck:b.html', type: 'deck' },
    ];
    const hero = pickHero(items, { e: b('ref', 'site:', 'deck:b.html', 'auto') });
    expect(hero).toBe('deck:a.html');
  });

  it('关注度加分封顶：三条手画线之后不再涨', () => {
    const items = [
      { id: 'deck:a.html', type: 'deck' },
      { id: 'deck:b.html', type: 'deck' },
    ];
    // a 挂四条批注、b 挂三条 —— 封顶后同为 +1.5，并列 → 没主角
    const bs = {};
    for (let i = 0; i < 4; i++) bs[`a${i}`] = b('annotates', `text:${i}`, 'deck:a.html');
    for (let i = 0; i < 3; i++) bs[`b${i}`] = b('annotates', `text:x${i}`, 'deck:b.html');
    expect(pickHero(items, bs)).toBe(null);
  });
});
