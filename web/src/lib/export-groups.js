import { cardIdOf } from './board-kinds.js';

/**
 * export-groups.js — 把 `/artifacts` 的原始响应整理成「按产物类型分组」的导出清单
 * （2026-08-17）
 *
 * 导出菜单原来跟着**当前聚焦的产物**走：想导几张图，得先去画布上点开某个任务。
 * 用户拍板改成**类型优先** —— 菜单直接列「站点 / 幻灯 / 图片 / …」，点一个类型
 * 再挑具体哪几个。
 *
 * ⭐**类型判据不在这里重造。** 目录型产物用服务端 manifest 给的 `kind`
 * （deck / site），文件型用服务端 `decorateCardKind` 给的 `cardKind`
 * （image / video / note / file）—— 这里只做分组和排序。
 * 卡 id 也走 `cardIdOf`（跟画布拼卡 id、服务端 `parseCardId` 反解同一套）。
 * 这个文件如果开始自己判"什么算图片"，就是第四份影子判据了。
 */

/** 类型的中文名与展示顺序。顺序 = 用户最可能想导出的先来 */
const TYPE_META = [
  { type: 'site',  label: '站点' },
  { type: 'deck',  label: '幻灯' },
  { type: 'docx',  label: '文档' },
  { type: 'image', label: '图片' },
  { type: 'video', label: '视频' },
  { type: 'note',  label: '便签' },
  { type: 'file',  label: '文件' },
];

/**
 * @param {{tasks?:Array, artifacts?:Array}} payload  `Assets.artifacts(pid)` 的返回
 * @returns {Array<{type, label, formats:string[], items:Array<{cardId,title,subtitle,size}>}>}
 *   只返回**真的有东西**的类型 —— 空分类摆在菜单里只是噪音
 */
export function groupArtifacts(payload) {
  const buckets = new Map();
  const push = (type, item, formats) => {
    if (!buckets.has(type)) buckets.set(type, { items: [], formats: formats || [] });
    const b = buckets.get(type);
    b.items.push(item);
    // 同类型里各产物的可用格式取**交集**：勾了几个一起导，格式得对每个都成立
    if (formats?.length) {
      b.formats = b.formats.length ? b.formats.filter(f => formats.includes(f)) : formats;
    }
  };

  for (const t of (payload?.tasks || [])) {
    for (const a of (t.artifacts || [])) {
      push(a.kind, {
        cardId: cardIdOf(t.id, a),
        title: a.title || t.title,
        subtitle: a.single ? '单页' : (t.id || '工作区根'),
      }, a.exports);
    }
  }
  for (const a of (payload?.artifacts || [])) {
    if (!a.cardKind) continue;             // 服务端没标类型的（旧数据）跳过，别猜
    push(a.cardKind, {
      cardId: a.path,                      // 文件卡的 id 就是裸路径
      title: a.name,
      subtitle: a.path.replace(/\/[^/]*$/, '') || '工作区根',
      size: a.size,
    }, a.exports);
  }

  return TYPE_META
    .filter(m => buckets.get(m.type)?.items.length)
    .map(m => ({
      type: m.type,
      label: m.label,
      formats: buckets.get(m.type).formats,
      items: buckets.get(m.type).items.sort((x, y) => x.title.localeCompare(y.title, 'zh')),
    }));
}
