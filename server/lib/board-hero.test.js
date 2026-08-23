import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { boardHeroId, heroSize, pickHero } from './board-hero.js';

const slice = (src) => {
  const a = src.indexOf('const ELIGIBLE');
  const b = src.indexOf('// ── END-MIRROR') > 0 ? src.indexOf('// ── END-MIRROR') : src.length;
  return src.slice(a, b).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
};

describe('board-hero 镜像', () => {
  it('pickHero 函数体与 web/src/lib/hero.js 逐字一致', () => {
    const be = fs.readFileSync(new URL('./board-hero.js', import.meta.url), 'utf8');
    const fe = fs.readFileSync(new URL('../../web/src/lib/hero.js', import.meta.url), 'utf8');
    expect(slice(be)).toBe(slice(fe));
  });
  it('唯一产物卡 = 天然主角；显式 hero 覆盖；主角尺寸 1.5 倍', () => {
    const board = { objects: { 'site:a': { x: 0, y: 0 }, 'assets/x.png': { x: 0, y: 0 } }, zones: {}, bindings: {} };
    expect(boardHeroId(board)).toBe('site:a');
    expect(heroSize('site:a')).toEqual({ w: 960, h: 28 + 600 });
    const two = { objects: { 'site:a': { x: 0, y: 0 }, 'site:b': { x: 0, y: 0 } }, zones: {}, bindings: {} };
    expect(boardHeroId(two)).toBeNull();
    expect(boardHeroId({ ...two, hero: 'site:b' })).toBe('site:b');
    expect(pickHero([], {})).toBeNull();
  });
});
