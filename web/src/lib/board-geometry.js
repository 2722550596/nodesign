/**
 * board-geometry.js — 桌面画布的几何常量与纯函数（2026-07-28 重构 3 抽出）
 *
 * BoardCanvas（桌面）与 StageLayer（舞台）共享，避免互相 import 的循环依赖。
 * 常量语义见 BoardCanvas 顶部说明；ZONE 与 server/projects/board-store.js
 * 的 ZONE_DEFAULTS 保持一致。
 */

// 桌面逻辑宽度固定（跨端坐标稳定），视口窄时整体 fitScale 等比缩（非交互）
export const DESKTOP_W = 1360;
// 反馈两轮都是同一句"文件夹周边空隙太多"：48 → 24（07-29）→ 10（07-30）。
// 工作区宽度由堆叠 effect 按 DESKTOP_W - MARGIN_X*2 重算，存档矩形下次渲染自动迁移。
export const MARGIN_X = 10;               // 桌面左右留白
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
  // 站点：收起态是一张带页面数的条；展开态放一张桌面宽度的缩略预览
  // （站点没有固定比例，取 16:10 一屏做取景框，够看出版式和配色）
  site:  { w: 240, h: 88 },
  siteExpanded: { w: DECK_EMBED_W, h: 28 + 400 },
};

/**
 * 站点预览的视口档位。
 *
 * deck 用「比例」（16:9 / 9:16…），站点用「宽度」—— 这是两种东西：deck 的版面
 * 是照着一个固定画布画死的，站点的版面是被视口宽度算出来的。所以这里给的是
 * 真实设备宽度，iframe 的 CSS 像素宽就设成它，**不做整体缩放**，否则手机档只是
 * 一张缩小的桌面版截图，看不出断点有没有生效。
 */
export const SITE_VIEWPORTS = [
  { id: 'desktop', label: '桌面', w: 1440, icon: 'monitor' },
  { id: 'tablet',  label: '平板', w: 834,  icon: 'tablet' },
  { id: 'mobile',  label: '手机', w: 390,  icon: 'smartphone' },
];

export const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const POP_IN = 'ndPopIn 260ms cubic-bezier(0.32, 0.72, 0, 1)';

export function sizeOf(o) {
  if (o.type === 'deck') return o.pos?.expanded ? SIZES.deckExpanded : SIZES.deck;
  if (o.type === 'site') return o.pos?.expanded ? SIZES.siteExpanded : SIZES.site;
  return SIZES[o.type] || SIZES.file;
}

// ── 同区避让系统（2026-07-29）──────────────────────────────────────────
//
// 语义：**交互中的卡有路权，别人让**。谁的 z 大（最近被摸过 / 展开过）谁不动，
// 其余成员按最小位移让位：向下 / 向右 / 向左三个方向挑挪得最少的，连锁避让；
// 侧移次数超限后只往下（y 单调增，必收敛）。这是"避让"不是"排斥"——
// 卡可以被拖到任何地方，是周围的卡自己走开。
export const AVOID_GAP = 12;
const AVOID_MAX_ITER = 60;
const AVOID_SIDE_ITER = 8;

const rectsHit = (a, b) =>
  !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/**
 * 对一个工作区的成员做避让重排（纯函数，不改入参）。
 *
 * @param {Array<{id, pos:{x,y,z?}, w, h}>} members  含尺寸的成员矩形
 * @param {{ xMin:number, xMax:number, yMin:number }} bounds
 *        xMin/xMax = 水平可用范围（xMax 按"左边缘最大值"传），yMin = 区内容顶
 * @returns {{ moved: Map<string,{x,y}>, bottom: number }}
 *        moved 只含真被挪动的成员；bottom = 重排后内容最低点
 */
export function resolveZoneAvoidance(members, { xMin, xMax, yMin }) {
  const ordered = [...members].sort((a, b) =>
    (b.pos.z ?? 1) - (a.pos.z ?? 1) || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  const placed = [];
  const moved = new Map();
  let bottom = yMin;
  for (const m of ordered) {
    const rect = { x: m.pos.x, y: m.pos.y, w: m.w, h: m.h };
    let guard = 0;
    while (guard < AVOID_MAX_ITER) {
      const blocker = placed.find(r => rectsHit(rect, r));
      if (!blocker) break;
      guard += 1;
      const down = blocker.y + blocker.h + AVOID_GAP - rect.y;
      const cands = [{ dx: 0, dy: down, cost: down }];
      if (guard <= AVOID_SIDE_ITER) {
        const right = blocker.x + blocker.w + AVOID_GAP - rect.x;
        const left = rect.x + rect.w + AVOID_GAP - blocker.x;
        if (rect.x + right <= xMax) cands.push({ dx: right, dy: 0, cost: right });
        if (rect.x - left >= xMin) cands.push({ dx: -left, dy: 0, cost: left });
      }
      cands.sort((a, b) => a.cost - b.cost);
      rect.x += cands[0].dx; rect.y += cands[0].dy;
    }
    if (guard >= AVOID_MAX_ITER) {
      // 不收敛兜底：回原 x，垂直堆到当前最底
      rect.x = m.pos.x;
      rect.y = placed.reduce((mx, r) => Math.max(mx, r.y + r.h), yMin) + AVOID_GAP;
    }
    if (Math.abs(rect.x - m.pos.x) > 0.5 || Math.abs(rect.y - m.pos.y) > 0.5) {
      moved.set(m.id, { x: rect.x, y: rect.y });
    }
    placed.push(rect);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { moved, bottom };
}

/** 新工作区先在现有栈底占位（用存档矩形估算），堆叠 effect 下一拍精确归位 */
export function newStackedZoneRect(zones) {
  let bottom = ZONE.bandY;
  for (const z of Object.values(zones)) {
    bottom = Math.max(bottom, (z.y || 0) + (z.collapsed ? FOLDER_CARD_H : (z.h || ZONE.h)));
  }
  return { x: MARGIN_X, y: bottom + ZONE_GAP_Y, w: DESKTOP_W - MARGIN_X * 2, h: ZONE.h };
}
