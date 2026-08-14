/**
 * web/src/lib/relation-order.js — 关系感知的排序（2026-08-14，北极星切片④）
 *
 * 「顺序是权威，坐标是算的」（08-01 定案）。入座/整理把物件按一个顺序喂给
 * packRow —— 在此之前那个顺序是字典序，关系数据全被扔掉，排出来只能是
 * 「错落有致的网格」。这份纯函数把 bindings 吃进顺序里：
 *
 *   对照 contrast / 关联 link   两端凑相邻（affinity 的承诺就是"摆近点"）
 *   接着 flow                   正向展开（分镜 1→2→3 按读序铺）
 *   改自 derives-from           反向展开（from=新 to=旧，读序=旧→新，像时间轴）
 *   批注 annotates              端点多为画布原生（不参与整理），两端都是文件时凑相邻
 *   取材 ref                    affinity=null，明确不表态 —— 不影响顺序
 *
 * 设计取舍：**稳定优先，不追求图布局最优**。组很小（2~5 件），链只认
 * "一进一出"（分叉/环保守放弃，成员按默认序兜底），组外完全保持传入顺序 ——
 * 整理的结果必须可预期，用户点两次得一样的版面。
 */

import { BINDING_STYLES } from './board-bindings.js';

/** 链类型的读序方向：+1 = from 排前面；-1 = to 排前面 */
const CHAIN_READ_DIR = { flow: +1, 'derives-from': -1 };

/**
 * @param {string[]} ids       已按默认序排好的 id 数组（这就是兜底顺序）
 * @param {object} bindings    { [bid]: { type, from, to, ... } }
 * @returns {string[]}         关系感知的新顺序（无关系时 === 传入数组）
 */
function computeOrder(ids, bindings) {
  const present = new Set(ids);
  // 只吃 affinity 非 null 的类型；两端都得在这一批里（半截在外面的线
  // 拉不动已经坐好的东西，那是另一回事）
  const edges = Object.values(bindings || {}).filter(b =>
    present.has(b.from) && present.has(b.to)
    && BINDING_STYLES[b.type]?.affinity != null);
  if (!edges.length) return ids;

  // 并查集分组：有 affinity 边相连的算一伙
  const parent = new Map(ids.map(i => [i, i]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const e of edges) {
    const ra = find(e.from); const rb = find(e.to);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groupOf = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!groupOf.has(r)) groupOf.set(r, []);
    groupOf.get(r).push(id);   // 成员天然按默认序进组
  }

  /** 组内排序：先沿链走（保守一进一出），走不到的按默认序跟在后面 */
  const orderGroup = (members) => {
    const mset = new Set(members);
    const next = new Map(); const hasPrev = new Set();
    for (const e of edges) {
      const dir = CHAIN_READ_DIR[e.type];
      if (!dir) continue;
      const [a, b] = dir > 0 ? [e.from, e.to] : [e.to, e.from];
      if (!mset.has(a) || !mset.has(b)) continue;
      if (next.has(a) || hasPrev.has(b)) continue;   // 分叉/汇流：保守放弃后来的
      next.set(a, b); hasPrev.add(b);
    }
    const out = []; const seen = new Set();
    for (const id of members) {
      if (seen.has(id) || hasPrev.has(id)) continue;  // 链中段等链头带出来
      let cur = id;
      while (cur !== undefined && !seen.has(cur)) { out.push(cur); seen.add(cur); cur = next.get(cur); }
    }
    for (const id of members) if (!seen.has(id)) { out.push(id); seen.add(id); }  // 纯环兜底
    return out;
  };

  // 输出：按默认序扫，撞到某组第一个成员时整组吐出 —— 组内相邻、组外稳定。
  // 顺手记块边界：多成员组独占成行（breakBefore 标在组头和组后第一个），
  // 版面上就是「组内紧凑、组间呼吸」—— affinity 承诺的"摆近点"落成留白语言。
  const emitted = new Set();
  const out = [];
  const breakBefore = new Set();
  let prevWasBlock = false;
  for (const id of ids) {
    if (emitted.has(id)) continue;
    const g = groupOf.get(find(id));
    const isBlock = g.length > 1;
    const members = isBlock ? orderGroup(g) : g;
    if ((isBlock || prevWasBlock) && out.length) breakBefore.add(members[0]);
    for (const m of members) { out.push(m); emitted.add(m); }
    prevWasBlock = isBlock;
  }
  return { order: out, breakBefore };
}

/**
 * 关系感知顺序（兼容旧签名：只要顺序）。
 */
export function orderByRelations(ids, bindings) {
  const r = computeOrder(ids, bindings);
  return Array.isArray(r) ? r : r.order;
}

/**
 * 顺序 + 块边界：入座/整理用。没有关系时 order === 传入数组、breakBefore 空集。
 */
export function orderWithGroups(ids, bindings) {
  const r = computeOrder(ids, bindings);
  return Array.isArray(r) ? { order: r, breakBefore: new Set() } : r;
}
