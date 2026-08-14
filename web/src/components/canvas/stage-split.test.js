/**
 * splitStageCards 落点规则的回归固化（2026-07-28；2026-08-13 去会话化；
 * 2026-08-14 生图占位迁出）。
 *
 * 历史坑：生图卡的落点只按 sessionId 找区 —— 找不到就整批掉进 dock 叠成一摞。
 * 2026-08-13 拆掉"回落到会话区"那级。2026-08-14 生图占位整个迁出舞台层：
 * 它现在是纸面层的**幻影物件**（PhantomLayer.jsx），座位一次算好、真图落地
 * 座位过户 —— 舞台分流对 image 卡的唯一正确行为是**完全不碰**。
 */
import { describe, it, expect } from 'vitest';
import { splitStageCards } from './StageLayer.jsx';
import { findPhantomSeat, claimPhantomSeat } from './PhantomLayer.jsx';

const ZONE_ID = '终焉之莉莉';   // 文件夹 id 就是工作区相对路径
const zones = [{ id: ZONE_ID, x: 48, y: 200, w: 1264, h: 640, collapsed: false }];
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const imageCard = (id, prompt) => ({ blockId: id, kind: 'image', status: 'running', prompt });

function split(cards, extra = {}) {
  return splitStageCards({
    stageCards: Object.fromEntries(cards.map(c => [c.blockId, c])),
    positioned: [], visibleIdSet: new Set(), visibleZones: zones,
    focusZone: ZONE_ID, ...extra,
  });
}

describe('splitStageCards 落点', () => {
  it('image 卡不进舞台分流（幻影层接管，三个出口都不该有它）', () => {
    const { anchoredCards, dockPanels, dockChips } = split([imageCard('b1', 'a knight')]);
    expect(anchoredCards).toHaveLength(0);
    expect(dockPanels).toHaveLength(0);
    expect(dockChips).toHaveLength(0);
  });

  it('代码卡贴当前工作区、按 slot 错开', () => {
    const { anchoredCards } = split([
      { blockId: 'b2', kind: 'code', status: 'running', text: '', filePath: '终焉之莉莉/主稿.html' },
      { blockId: 'b3', kind: 'code', status: 'running', text: '', filePath: '终焉之莉莉/试作.html' },
    ]);
    expect(anchoredCards.map(c => c.zoneRect.id)).toEqual([ZONE_ID, ZONE_ID]);
    expect(anchoredCards.map(c => c.slot)).toEqual([0, 1]);
  });

  it('区被收起 / 压根没有区 → 代码卡才落 dock', () => {
    const { anchoredCards, dockPanels } = splitStageCards({
      stageCards: { b1: { blockId: 'b1', kind: 'code', status: 'running', text: '' } },
      positioned: [], visibleIdSet: new Set(),
      visibleZones: [{ ...zones[0], collapsed: true }],
      focusZone: null,
    });
    expect(anchoredCards).toHaveLength(0);
    expect(dockPanels).toHaveLength(1);
  });

  it('chip 走 dock 胶囊排，question 走 dock 面板', () => {
    const { dockPanels, dockChips } = split([
      { blockId: 'c1', kind: 'chip', status: 'running', tool: 'Read' },
      { blockId: 'q1', kind: 'question', status: 'running', input: {} },
    ]);
    expect(dockChips).toHaveLength(1);
    expect(dockPanels).toHaveLength(1);
  });
});

describe('幻影入座（PhantomLayer）', () => {
  it('找座避开障碍，且从内容底边下面开始', () => {
    const obstacle = { x: 48, y: 300, w: 400, h: 200 };
    const seat = findPhantomSeat([obstacle], 500);
    expect(seat.y).toBeGreaterThanOrEqual(500);
    expect(overlap({ ...seat, w: 200, h: 180 }, obstacle)).toBe(false);
  });

  it('多个幻影互不重叠（调用方把已就座的当障碍传回来）', () => {
    const s1 = findPhantomSeat([], 100);
    const s2 = findPhantomSeat([{ ...s1, w: 220, h: 220 }], 100);
    expect(overlap({ ...s1, w: 200, h: 180 }, { ...s2, w: 200, h: 180 })).toBe(false);
  });

  it('座位过户：最老的未过户幻影先被认领，认领即标记不发两次', () => {
    const ref = { current: new Map([
      ['b2', { blockId: 'b2', seat: { x: 300, y: 60 }, bornAt: 2, consumedBy: null }],
      ['b1', { blockId: 'b1', seat: { x: 48, y: 60 }, bornAt: 1, consumedBy: null }],
    ]) };
    expect(claimPhantomSeat(ref, 'img/a.webp')).toEqual({ x: 48, y: 60 });
    expect(ref.current.get('b1').consumedBy).toBe('img/a.webp');
    expect(claimPhantomSeat(ref, 'img/b.webp')).toEqual({ x: 300, y: 60 });
    expect(claimPhantomSeat(ref, 'img/c.webp')).toBe(null);   // 没有幻影就正常入座
  });
});
