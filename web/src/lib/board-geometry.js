/**
 * board-geometry.js — 桌面画布的几何常量与纯函数（2026-07-28 重构 3 抽出）
 *
 * BoardCanvas（桌面）与 StageLayer（舞台）共享，避免互相 import 的循环依赖。
 * 常量语义见 BoardCanvas 顶部说明；ZONE 与 server/projects/board-store.js
 * 的 ZONE_DEFAULTS 保持一致。
 */

// 桌面逻辑宽度固定（跨端坐标稳定），视口窄时整体 fitScale 等比缩（非交互）
export const DESKTOP_W = 1360;
export const MARGIN_X = 48;               // 桌面左右留白
export const ZONE_GAP_Y = 28;             // 堆叠工作区之间的垂直间距
export const FOLDER_CARD_H = 84;          // 收纳态整宽窄条占用的堆叠高度
export const DECK_EMBED_W = 640;          // deck 内嵌渲染宽度（1920 → 1/3 缩放）
export const STAGE_CARD_W = 560;          // 舞台卡宽度（板内坐标系）

// 项目区顶带（2026-07-28）：项目级四件套（记忆 / 指引 / 品牌 / 文件）常驻桌面顶部，
// 工作区往下排。ProjectHub 那个二级页由此退役 —— 项目级东西回到同一张桌面上。
export const PROJECT_BAND_Y = 16;
export const PROJECT_CARD_W = 232;
export const PROJECT_CARD_H = 84;
export const PROJECT_BAND_H = PROJECT_CARD_H + 28;

export const ZONE = {
  w: 1120, h: 640, gap: 60, bandX: 320, bandY: PROJECT_BAND_Y + PROJECT_BAND_H, perRow: 3,
  header: 56, pad: 16, cellW: 244, cellH: 210,
};

// 工作区实际高度贴内容走（ZONE.h 只是创建时的估算矩形）；这是空区的最小身位：
// 标题栏 + 一格边距 + 够接住一次拖放的空地。空工作区不再占大半屏空画幅。
export const ZONE_MIN_H = ZONE.header + ZONE.pad * 2 + 120;

export const SIZES = {
  doc:   { w: 200, h: 96 },
  deck:  { w: 240, h: 88 },
  deckExpanded: { w: DECK_EMBED_W, h: 28 + 360 },
  image: { w: 200, h: 176 },
  note:  { w: 200, h: 148 },
  file:  { w: 224, h: 40 },
};

export const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const POP_IN = 'ndPopIn 260ms cubic-bezier(0.32, 0.72, 0, 1)';

export function sizeOf(o) {
  if (o.type === 'deck') return o.pos?.expanded ? SIZES.deckExpanded : SIZES.deck;
  return SIZES[o.type] || SIZES.file;
}

/** 新工作区先在现有栈底占位（用存档矩形估算），堆叠 effect 下一拍精确归位 */
export function newStackedZoneRect(zones) {
  let bottom = ZONE.bandY;
  for (const z of Object.values(zones)) {
    bottom = Math.max(bottom, (z.y || 0) + (z.collapsed ? FOLDER_CARD_H : (z.h || ZONE.h)));
  }
  return { x: MARGIN_X, y: bottom + ZONE_GAP_Y, w: DESKTOP_W - MARGIN_X * 2, h: ZONE.h };
}
