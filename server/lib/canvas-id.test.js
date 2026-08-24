/**
 * canvas-id 归一化钉子（2026-08-14 可维护性行动 D 刀）。
 * read_board / arrange_on_board / create_on_board / organize_board 共用的
 * id 口径 —— agent 传参五花八门，规则漂了就是"摆位工具突然找不到卡"。
 */
import { describe, it, expect } from 'vitest';
import { normalizeCanvasId, layerOf } from './canvas-id.js';

describe('normalizeCanvasId', () => {
  it('反斜杠 / ./ 前缀 / 首尾斜杠全归一', () => {
    expect(normalizeCanvasId('.\\稿件\\主稿.html')).toBe('deck:稿件/主稿.html');
    expect(normalizeCanvasId('./assets/a.png')).toBe('assets/a.png');
    expect(normalizeCanvasId('/素材/图.png/')).toBe('素材/图.png');
  });

  it('裸 .html 补 deck: 前缀；已带 kind 前缀的不重复补', () => {
    expect(normalizeCanvasId('主稿.html')).toBe('deck:主稿.html');
    expect(normalizeCanvasId('deck:主稿.html')).toBe('deck:主稿.html');
    expect(normalizeCanvasId('site:鉴赏页')).toBe('site:鉴赏页');
  });

  it('记忆文件就是普通路径 id（doc: 特例 08-24 拆除）', () => {
    expect(normalizeCanvasId('记忆/style-anchor.md')).toBe('记忆/style-anchor.md');
    expect(normalizeCanvasId('CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('空 / 越界拒收', () => {
    expect(normalizeCanvasId('')).toBe(null);
    expect(normalizeCanvasId('../外面.png')).toBe(null);
  });
});

describe('layerOf', () => {
  const folders = new Set(['稿件', '稿件/初稿']);
  it('显式 zone 字段优先 —— 但只认真实存在的层（08-24：错标签落回按路径推）', () => {
    // folders 里没有「素材」这个层 → 忽略错标签，按路径推（assets 不是层 → 根）
    expect(layerOf('assets/a.png', { zone: '素材' }, folders)).toBe('');
    // 真实存在的层照常优先
    expect(layerOf('assets/a.png', { zone: [...folders][0] }, folders)).toBe([...folders][0]);
    expect(layerOf('稿件/x.png', { zone: '' }, folders)).toBe('');
  });
  it('沿路径找第一个已知文件夹；找不到归根', () => {
    expect(layerOf('deck:稿件/初稿/主稿.html', null, folders)).toBe('稿件/初稿');
    expect(layerOf('别处/深/文件.csv', null, folders)).toBe('');
    expect(layerOf('doc:_root', null, folders)).toBe('');
  });
});
