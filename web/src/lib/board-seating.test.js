/**
 * 桌面入座算法回归（2026-08-14 B 刀抽出时补的钉子）。
 * 语义背书都在 board-seating.js 的头注释里；这里钉行为。
 */
import { describe, it, expect } from 'vitest';
import { computeDesktopSeating } from './board-seating.js';
import { sizeOf } from './board-kinds.js';

const folderCardOf = (id, pos) => ({
  id, kind: 'folder', x: pos?.x ?? 0, y: pos?.y ?? 0, w: 288, h: 240,
  title: id, count: 0, peek: [],
});

const dirIndexOf = (rootItems, rootFolders = []) => ({
  subsOf: new Map([['', rootFolders]]),
  byDir: new Map([['', rootItems]]),
});

const seat = (over = {}) => computeDesktopSeating({
  dirIndex: dirIndexOf([]),
  zonesEff: {}, layout: {}, bindings: {}, lineageOpen: new Set(),
  boardHero: null, folderCardOf, movingIds: new Set(), claimSeat: null,
  ...over,
});

describe('computeDesktopSeating', () => {
  it('已摆放的永不重排；新来的落到内容底边之下（唯一一条自动）', () => {
    const r = seat({
      dirIndex: dirIndexOf([
        { id: 'a.png', type: 'image' },
        { id: 'b.png', type: 'image' },
      ]),
      layout: { 'a.png': { x: 500, y: 40, z: 1 } },
    });
    const a = r.positioned.find(o => o.id === 'a.png');
    const b = r.positioned.find(o => o.id === 'b.png');
    expect(a.pos).toMatchObject({ x: 500, y: 40 });          // 摆过的不动
    expect(b.pos.y).toBeGreaterThan(40 + sizeOf(a).h - 1);   // 新来的在它底下
    expect(r.seatFixes['b.png']).toBeTruthy();               // 新落点要落盘
    expect(r.seatFixes['a.png']).toBeUndefined();            // 老座位不重写
  });

  it('起排线也吃文件夹卡的底边', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'x.png', type: 'image' }], ['素材']),
      zonesEff: { '素材': { x: 10, y: 300 } },
    });
    expect(r.folderView).toHaveLength(1);
    expect(r.positioned[0].pos.y).toBeGreaterThan(300 + 240 - 1);
  });

  it('显式主角（board.hero）压过推断并标 tier', () => {
    const r = seat({
      dirIndex: dirIndexOf([
        { id: 'deck:a.html', type: 'deck' },
        { id: 'deck:b.html', type: 'deck' },
      ]),
      boardHero: 'deck:b.html',
    });
    expect(r.positioned.find(o => o.id === 'deck:b.html').tier).toBe('hero');
    expect(r.positioned.find(o => o.id === 'deck:a.html').tier).toBeUndefined();
  });

  it('谱系收叠：改自链旧版隐藏、链尾带纸叠计数；点开则全员在场', () => {
    const items = [
      { id: 'deck:v1.html', type: 'deck' },
      { id: 'deck:v2.html', type: 'deck' },
    ];
    const bindings = { b1: { type: 'derives-from', from: 'deck:v2.html', to: 'deck:v1.html' } };
    const folded = seat({ dirIndex: dirIndexOf(items), bindings });
    expect(folded.positioned.map(o => o.id)).toEqual(['deck:v2.html']);
    expect(folded.positioned[0].stackCount).toBe(1);
    const open = seat({ dirIndex: dirIndexOf(items), bindings, lineageOpen: new Set(['deck:v2.html']) });
    expect(open.positioned).toHaveLength(2);
  });

  it('幻影座位过户：claimSeat 命中的图坐幻影的位置并落盘', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'assets/generated/n.webp', type: 'image', }]),
      claimSeat: (id) => (id === 'assets/generated/n.webp' ? { x: 777, y: 888 } : null),
    });
    expect(r.positioned[0].pos).toMatchObject({ x: 777, y: 888 });
    expect(r.seatFixes['assets/generated/n.webp']).toMatchObject({ x: 777, y: 888 });
  });

  it('搬家中的 id 不落盘（落了=指向死路径的幽灵行）', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'ghost.png', type: 'image' }]),
      movingIds: new Set(['ghost.png']),
    });
    expect(r.seatFixes['ghost.png']).toBeUndefined();
  });

  it('批注手写字跟随目标：落到首目标那一行的右端空白', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'deck:主稿.html', type: 'deck' }]),
      layout: { 'text:t1': { kind: 'text', x: 5, y: 5, w: 160 } },
      bindings: { b1: { type: 'annotates', from: 'text:t1', to: 'deck:主稿.html' } },
    });
    const slot = r.positioned.find(o => o.id === 'deck:主稿.html');
    expect(r.noteFixes['text:t1'].y).toBe(Math.round(slot.pos.y));
    expect(r.noteFixes['text:t1'].x).toBeGreaterThan(slot.pos.x);
  });
});
