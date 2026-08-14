/**
 * server/lib/board-relations.js — 关系线的 agent 读侧（2026-08-14，切片③）
 *
 * 在此之前 bindings 是**只写不读**的：agent 有 relate_on_board 能画线、用户
 * 在画布上看得见，但没有任何一层把「用户画了什么关系」喂回 agent —— 线是
 * 装饰。这份文件是读侧的唯一实现，两个消费口都从这儿取：
 *
 *   1. UserPromptSubmit 摘要（relationsDigest）：每轮把全图压成 ≤N 行，
 *      用户画的排前面 —— 他专门画的线就是他想让你知道的事。
 *   2. PreToolUse 邻域（fileNeighborhood）：agent 摸某个文件时，只注连着
 *      这个文件的边（摘要被截断时的精确补充）。
 *
 * 端点是画布 id（= kind 前缀 + 工作区相对路径，或画布原生 id `text:`/
 * `scribble:`）。手写字端点渲染**内容本身**——这是「标注作用全局」的关键一步：
 * 用户在画布上写的字经由一条线变成 agent 眼里的上下文。涂鸦端点诚实占位
 * （笔画内容看不见，要看得截图），不假装理解。
 */

import { readBoard } from '../projects/board-store.js';
import { BINDING_TYPES } from './binding-types.js';

const KIND_PREFIXES = ['deck:', 'site:'];

/** 端点 id → 给 agent 看的一小段描述 */
export function describeEndpoint(end, board) {
  const obj = board?.objects?.[end];
  if (obj?.kind === 'text') {
    const t = String(obj.data?.t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `手写字「${t}」`;
  }
  if (obj?.kind === 'scribble') return '一笔涂鸦（笔画内容要看得截图画布）';
  for (const p of KIND_PREFIXES) {
    if (end.startsWith(p)) {
      const rel = end.slice(p.length);
      const kind = p.slice(0, -1);
      return rel ? `${rel}（${kind}）` : `工作区根上的${kind}`;
    }
  }
  return end;   // 裸文件路径或文件夹路径
}

/** 一条边 → 一行中文。方向用箭头表达，无向用平线。 */
export function bindingLine(b, board) {
  const t = BINDING_TYPES[b.type];
  const word = b.label || t?.label || b.type;
  const joint = t?.directed ? `─${word}→` : `─${word}─`;
  const who = b.by === 'user' ? '〔用户画的〕' : b.by === 'agent' ? '〔你画的〕' : '';
  return `${describeEndpoint(b.from, board)} ${joint} ${describeEndpoint(b.to, board)}${who}`;
}

/**
 * 全图摘要。用户画的排前面（他专门画的 = 他想让你知道的），截断报余量。
 * 没有任何线 → null（沉默，不占 prompt）。
 */
export async function relationsDigest(pid, { limit = 12 } = {}) {
  if (!pid) return null;
  const board = await readBoard(pid);
  const all = Object.values(board.bindings || {});
  if (!all.length) return null;
  // 手画的逐条列；自动 ref（内容引用对账出来的底仓）**收拢成每源一行**——
  // 一个站引三十张图，铺开就把摘要刷没了。优先级 user > agent > auto。
  const manual = [
    ...all.filter(b => b.by === 'user'),
    ...all.filter(b => b.by === 'agent'),
    ...all.filter(b => b.by !== 'user' && b.by !== 'agent' && !(b.by === 'auto' && b.type === 'ref')),
  ];
  const autoRefs = all.filter(b => b.by === 'auto' && b.type === 'ref');
  const lines = manual.slice(0, limit).map(b => `  ${bindingLine(b, board)}`);
  const more = manual.length - lines.length;
  if (more > 0) lines.push(`  …还有 ${more} 条（摸到相关文件时会单独提示）`);
  if (autoRefs.length) {
    const bySrc = new Map();
    for (const b of autoRefs) {
      if (!bySrc.has(b.from)) bySrc.set(b.from, []);
      bySrc.get(b.from).push(b.to);
    }
    for (const [from, tos] of [...bySrc].slice(0, 4)) {
      const sample = tos.slice(0, 3).join('、');
      lines.push(`  ${describeEndpoint(from, board)} ─取材─ ${tos.length} 件素材（自动对账：${sample}${tos.length > 3 ? ' 等' : ''}）`);
    }
    if (bySrc.size > 4) lines.push(`  …另有 ${bySrc.size - 4} 件产物的取材清单省略`);
  }
  return lines.join('\n');
}

/** 某个端点 id 是否指向这个工作区相对路径（裸路径或任一 kind 前缀形态）。
 *  导出仅供测试钉规则（fileNeighborhood 是唯一业务调用方）。 */
export function endpointMatchesRel(end, rel) {
  if (end === rel) return true;
  for (const p of KIND_PREFIXES) if (end === p + rel) return true;
  // 目录型产物的收敛（2026-08-14 根站病族普查补上的）：站点的边挂在
  // **根卡**上，agent 摸的是里面的文件 —— 原来只做精确匹配，等于站点页的
  // 一跳邻域从来注入不出来。按"住在这个根里"匹配；根站（root=空串）收根层
  // 散文件（.md 除外）—— 与前端 resolveObjectId 同一条规则，两边别岔开。
  for (const p of ['site:']) {
    if (!end.startsWith(p)) continue;
    const root = end.slice(p.length);
    if (root === '') {
      if (!rel.includes('/') && !/\.md$/i.test(rel)) return true;
      continue;
    }
    if (rel === root || rel.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * 一跳邻域：连着某个文件/文件夹的全部边。没有 → null。
 * PreToolUse 注入用 —— agent 正要摸的东西，它身上的线最相关。
 */
export async function fileNeighborhood(pid, rel, { limit = 6 } = {}) {
  if (!pid || !rel) return null;
  const board = await readBoard(pid);
  const hits = Object.values(board.bindings || {})
    .filter(b => endpointMatchesRel(b.from, rel) || endpointMatchesRel(b.to, rel));
  if (!hits.length) return null;
  const lines = hits.slice(0, limit).map(b => `  ${bindingLine(b, board)}`);
  if (hits.length > limit) lines.push(`  …还有 ${hits.length - limit} 条`);
  return lines.join('\n');
}
