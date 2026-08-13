/**
 * splitStageCards 落点规则的回归固化（2026-07-28；2026-08-13 去会话化）。
 *
 * 真机踩的坑：生图卡的落点只按 sessionId 找区 —— 找不到就整批掉进屏幕底部的
 * dock 叠成一摞，看着像"图片没被放进工作文件夹"。
 *
 * 2026-08-13：会话不再产生画布物件，落点里"回落到当前会话区"那一级整个拆掉
 * （它只会指向不存在的 id，下游还会照着长出一块 uuid 标题的影子文件夹）。
 * 现在只有两级：**物件所属文件夹 → 当前所在文件夹**，都认不出就老实掉 dock。
 */
import { describe, it, expect } from 'vitest';
import { splitStageCards } from './StageLayer.jsx';

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

  it('物件还没有归属时退到当前所在的文件夹', () => {
    // 生图卡在图落盘之前压根没有 objectId —— 这一级兜底就是为它准备的
    const { anchoredCards, dockPanels } = split([imageCard('b1', 'a')]);
    expect(dockPanels).toHaveLength(0);
    expect(anchoredCards[0].zoneRect.id).toBe(ZONE_ID);
  });

  it('区被收起 / 压根没有区 → 才落 dock', () => {
    const { anchoredCards, dockPanels } = splitStageCards({
      stageCards: { b1: imageCard('b1', 'a') },
      positioned: [], visibleIdSet: new Set(),
      visibleZones: [{ ...zones[0], collapsed: true }],
      focusZone: null,
    });
    expect(anchoredCards).toHaveLength(0);
    expect(dockPanels).toHaveLength(1);
  });

  it('代码卡按 slot 错开，生图卡按矩形排布', () => {
    const { anchoredCards } = split([
      imageCard('b1', 'a'),
      { blockId: 'b2', kind: 'code', status: 'running', text: '', filePath: '终焉之莉莉/主稿.html' },
      { blockId: 'b3', kind: 'code', status: 'running', text: '', filePath: '终焉之莉莉/试作.html' },
    ]);
    expect(anchoredCards.filter(c => c.card.kind === 'code').map(c => c.slot)).toEqual([0, 1]);
    expect(anchoredCards.find(c => c.card.kind === 'image').pos).toBeTruthy();
  });
});
