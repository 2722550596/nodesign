/**
 * kinds/file-kinds.js — 文件形态注册表（2026-08-17）
 *
 * 跟 kinds/index.js 那张表是**两族东西，别混**：
 *
 *   任务形态（deck / site）  = 一个**目录**是什么。契约里有 detect(taskDir) /
 *                             artifactRoot / manifest —— 它回答「这个文件夹装的
 *                             是一份幻灯还是一个站」。
 *   文件形态（本文件）        = 一个**文件**是什么。没有任务目录、没有入口文件、
 *                             没有 manifest，硬塞进上面那张表会把 detect(taskDir)
 *                             的契约撑坏。所以另起一张，契约小得多。
 *
 * 两族共用的只有一件事：`exportFormats` —— 导出层问的是「这张卡能导出成什么」，
 * 不关心它背后是目录还是文件。
 *
 * ⭐**这条映射规则原来住在前端** `BoardCanvas.jsx`（`a.kind === 'note'` →
 * note、`isImage` → image、`isVideo` → video、其余 file），服务端只算
 * `isImage` / `isVideo` 两个布尔。导出要按卡类型收产物，就必须在服务端问同一个
 * 问题 —— 与其在导出层再写一遍判据，不如把规则挪到这里当唯一真相，前端将来直接
 * 消费。多写一份影子判据的债见 [[nodesign-truth-sources]]。
 */

/**
 * 文件形态契约：
 *   id             'image' | 'video' | 'note' | 'file'
 *   label          中文名（导出菜单、报错文案用）
 *   exportFormats  这种卡能导出成什么
 *                    raw — 原件直接下（单张 / 单个文件）
 *                    zip — 多个打成一个压缩包
 *                    md  — 合并成一份 markdown（只有便签有意义）
 */
export const FILE_KINDS = Object.freeze({
  image: { id: 'image', label: '图片', exportFormats: ['raw', 'zip'] },
  video: { id: 'video', label: '视频', exportFormats: ['raw', 'zip'] },
  note:  { id: 'note',  label: '便签', exportFormats: ['raw', 'zip', 'md'] },
  file:  { id: 'file',  label: '文件', exportFormats: ['raw', 'zip'] },
});

export function fileKindDef(kind) {
  return FILE_KINDS[kind] || null;
}

/**
 * 「什么算图片 / 视频」—— 原来住在 `api/assets.js`，08-17 挪到这里。
 * 挪的理由：导出要按卡类型收产物，如果在导出层再抄一份扩展名表，就会出现
 * 「画布认它是图片、导出不认」这种没人查得出来的分叉。assets.js 现在从这里 import。
 */
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
// 视频上墙（2026-08-08 roll_film）：isVideo 让前端渲成带播放器的视频卡而不是
// 通用文件卡。播放走既有 Range+派生档管线（video-variant.js），这里只标记。
export const VIDEO_EXTS = new Set(['.mp4', '.webm']);

/** 便签的两个扫描根（跟 assets.js 的 scanDir 调用一致） */
const NOTE_PREFIXES = ['assets/notes/', 'notes/'];

/**
 * 只拿一个工作区相对路径判文件形态（导出按卡 id 寻址时用 —— 那时手上只有路径，
 * 没有 `/artifacts` 那条带 isImage/isVideo 的记录）。
 *
 * ⚠️ 结果必须跟 `fileKindOf()` 一致。两者的次序都是：便签 → 图 → 视频 → 其余。
 *
 * @param {string} relPath 工作区相对路径
 */
export function fileKindOfPath(relPath) {
  if (!relPath || typeof relPath !== 'string') return 'file';
  const p = relPath.replace(/\\/g, '/');
  // ⚠️ 便签**按位置判，不看扩展名**。`/artifacts` 的真规则是「note 扫描根下的
  // 任何文件都是 note」（assets.js 的 scanDir 是按 kind 参数打标，扩展名根本不
  // 参与），前端也是先问 `a.kind === 'note'` 再问 isImage。
  // 这里曾经多加了个 `.md` 条件，于是 `notes/参考图.png` 路径判成 image、记录判
  // 成 note —— 同一个文件两种答案，正是"一个事实多份算法"那条债。
  if (NOTE_PREFIXES.some(pre => p.startsWith(pre))) return 'note';
  const dot = p.lastIndexOf('.');
  const ext = dot > 0 ? p.slice(dot).toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'file';
}

/**
 * 一个 `/artifacts` 条目是哪种文件形态。
 *
 * ⚠️ 判据次序跟前端 BoardCanvas 那四行**必须一致**，改这里要连它一起改
 * （note 在最前：便签也是 .md 文件，先问来源再问扩展名，否则会掉进 file）。
 *
 * @param {{kind?:string, isImage?:boolean, isVideo?:boolean}} item `/artifacts` 的一条
 * @returns {'note'|'image'|'video'|'file'}
 */
export function fileKindOf(item) {
  if (!item || typeof item !== 'object') return 'file';
  if (item.kind === 'note') return 'note';
  if (item.isImage) return 'image';
  if (item.isVideo) return 'video';
  return 'file';
}

/** 这种文件形态支不支持某个导出格式（导出守卫用，跟任务形态的 formatAllowed 同语义） */
export function fileFormatAllowed(kind, format) {
  const def = FILE_KINDS[kind];
  return def ? def.exportFormats.includes(format) : false;
}

/**
 * 给 `/artifacts` 的一条记录补上「它是哪种卡、能导出成什么」。
 *
 * 收在这里而不是写在 assets.js 的扫描循环里：卡类型的判据本来就住这个文件，
 * 调用方只该说「补一下」，不该自己再拼一遍 `fileKindOf` + `exportFormats`。
 */
export function decorateCardKind(item) {
  item.cardKind = fileKindOf(item);
  item.exports = FILE_KINDS[item.cardKind]?.exportFormats || [];
  return item;
}
