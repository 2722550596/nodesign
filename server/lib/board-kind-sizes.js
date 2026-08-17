/**
 * board-kind-sizes —— 画布物件身位的服务端镜像（2026-08-14，agent 摆位批）
 *
 * read_board / arrange_on_board / create_on_board 要在服务端估算卡片矩形
 * （挨着谁摆、会不会压到谁），而身位真相住在前端 `web/src/lib/board-kinds.js`
 * （渲染方）。这里抄一份**常量**，web 侧有 parity 测试钉着两边一致 ——
 * 改那边忘了改这边，测试直接红（跟 binding-types 的双份表同一套纪律）。
 *
 * 文字/涂鸦不在表里：它们的 w/h 是逐条存在 board.json 里的（本体即数据）。
 */

export const DECK_EMBED_W = 640;
export const ARTIFACT_HEADER_H = 28;
export const ARTIFACT_PREVIEW_H = { deck: 360, site: 400, docx: 420 };

// file 是 224x32 的细条卡（parity 测试上岗第一天就逮住我猜成 160x120 ——
// 那是涂鸦的默认身位。别猜，抄表）
export const KIND_SIZES = {
  doc: { w: 200, h: 96 },
  image: { w: 200, h: 176 },
  video: { w: 240, h: 160 },
  note: { w: 200, h: 148 },
  file: { w: 224, h: 32 },
};

const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

/**
 * 按 id + board.json 条目估身位。优先条目里存的 w/h（文字/涂鸦，或将来任何
 * 显式尺寸），其次按 id 形态推：kind 前缀 → 产物卡，扩展名 → 图/视频/便签/文件。
 */
export function estimateSize(id, entry) {
  if (entry && Number.isFinite(entry.w) && Number.isFinite(entry.h)) {
    return { w: entry.w, h: entry.h };
  }
  const s = String(id || '');
  if (s.startsWith('doc:')) return KIND_SIZES.doc;
  const m = /^(deck|site|docx):/.exec(s);
  if (m) {
    const t = m[1];
    return { w: DECK_EMBED_W, h: ARTIFACT_HEADER_H + ARTIFACT_PREVIEW_H[t] };
  }
  if (IMG_EXT.test(s)) return KIND_SIZES.image;
  if (VIDEO_EXT.test(s)) return KIND_SIZES.video;
  if (/\.(md|txt)$/i.test(s)) return KIND_SIZES.note;
  return KIND_SIZES.file;
}
