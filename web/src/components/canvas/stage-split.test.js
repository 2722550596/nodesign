/**
 * splitStageCards 落点规则的回归固化（2026-07-28）。
 *
 * 真机踩的坑：任务绑定会话后，会话区被任务区取代（区 id 变成 `task/<名字>`），
 * 而生图卡的落点只按 sessionId 找区 —— 永远找不到，于是整批掉进屏幕底部的 dock
 * 叠成一摞，看着像"图片没被放进工作文件夹"。
 */
import { describe, it, expect } from 'vitest';
import { splitStageCards } from './StageLayer.jsx';

const SID = '719dfb34-24f9-4f52-9718-09e7a2057d04';
const ZONE_ID = 'task/终焉之莉莉';
const zones = [{ id: ZONE_ID, x: 48, y: 200, w: 1264, h: 640, collapsed: false }];
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const imageCard = (id, prompt) => ({ blockId: id, kind: 'image', status: 'running', prompt });

function split(cards, extra = {}) {
  return splitStageCards({
    stageCards: Object.fromEntries(cards.map(c => [c.blockId, c])),
    positioned: [], visibleIdSet: new Set(), visibleZones: zones,
    currentSessionId: ZONE_ID, focusZone: ZONE_ID, ...extra,
  });
}

describe('splitStageCards 落点', () => {
  it('生图卡落进当前工作区，不掉 dock', () => {
    const { anchoredCards, dockPanels } = split([imageCard('b1', 'a knight')]);
    expect(dockPanels).toHaveLength(0);
    expect(anchoredCards).toHaveLength(1);
    expect(anchoredCards[0].zoneRect.id).toBe(ZONE_ID);
  });

  it('并发多张生图各占一个坑位，互不重叠', () => {
    const { anchoredCards } = split([imageCard('b1', 'a'), imageCard('b2', 'b'), imageCard('b3', 'c')]);
    const rs = anchoredCards.map(c => c.pos);
    expect(rs.every(Boolean)).toBe(true);
    expect(rs.every((a, i) => rs.every((b, j) => i === j || !overlap(a, b)))).toBe(true);
  });

  it('避开工作区里已有的图（跟物件之间也不重叠）', () => {
    // 左下角那格已经放了一张真图
    const taken = { x: 48 + 16, y: 200 + 640 - 16 - 196, w: 200, h: 176 };
    const { anchoredCards } = split([imageCard('b1', 'a'), imageCard('b2', 'b')], {
      occupancy: new Map([[ZONE_ID, [taken]]]),
    });
    const rs = anchoredCards.map(c => c.pos);
    expect(rs.every(r => !overlap(r, taken))).toBe(true);
    expect(overlap(rs[0], rs[1])).toBe(false);
  });

  it('拿 sessionId 找不到区时退到 focusZone（任务绑会话后的真实形态）', () => {
    const { anchoredCards, dockPanels } = split([imageCard('b1', 'a')], { currentSessionId: SID });
    expect(dockPanels).toHaveLength(0);
    expect(anchoredCards[0].zoneRect.id).toBe(ZONE_ID);
  });

  it('区被收起 / 压根没有区 → 才落 dock', () => {
    const { anchoredCards, dockPanels } = splitStageCards({
      stageCards: { b1: imageCard('b1', 'a') },
      positioned: [], visibleIdSet: new Set(),
      visibleZones: [{ ...zones[0], collapsed: true }],
      currentSessionId: SID, focusZone: null,
    });
    expect(anchoredCards).toHaveLength(0);
    expect(dockPanels).toHaveLength(1);
  });

  it('代码卡按 slot 错开，生图卡按矩形排布', () => {
    const { anchoredCards } = split([
      imageCard('b1', 'a'),
      { blockId: 'b2', kind: 'code', status: 'running', text: '', filePath: 'tasks/x/canvas.html' },
      { blockId: 'b3', kind: 'code', status: 'running', text: '', filePath: 'tasks/x/other.html' },
    ]);
    expect(anchoredCards.filter(c => c.card.kind === 'code').map(c => c.slot)).toEqual([0, 1]);
    expect(anchoredCards.find(c => c.card.kind === 'image').pos).toBeTruthy();
  });
});
