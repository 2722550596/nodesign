/**
 * region-pick —— 圈住一块区域之后，「这一圈到底指的是哪些东西」。
 *
 * 用户拿笔在预览上画一个框，框里必然压着一大堆元素：最外层的 body、几层
 * 布局容器、真正想说的那两个标题、还有半个挨着的段落。**原样全交给 agent
 * 等于什么都没说** —— 一份含 body 的清单里，agent 只能猜。
 *
 * 所以这里定的是「圈选的语义」，四条规则：
 *
 * 1. **压根没碰到的不算。** 相交面积为 0 就出局。
 * 2. **比圈大太多的不算。** 元素自身面积超过圈的 CONTAINER_RATIO 倍，说明
 *    用户圈的是它里面的东西，不是它。（画一个小框在页面正中，body 和
 *    每一层 wrapper 都"相交"，但没有一个是用户的意思。）
 * 3. **祖先让位给后代。** 留下的集合里若 A 包含 B，只留 B —— 用户看见的是
 *    最里面那个具体的东西。
 * 4. **兜底不许空。** 三条筛完一个不剩（比如圈了整页），退回相交面积最大的
 *    那一个，不然用户圈了半天得到一句"没圈到东西"。
 *
 * 排序按「这个元素有多大比例被圈进去」降序：整个被圈住的排在只擦到边的前面。
 *
 * 这一层是纯函数（收 `{el, rect}` 列表，不碰 DOM 测量），因为规则是有判断的
 * 那部分，而遍历和量尺寸没什么可错的。
 */

/** 元素自身面积超过圈的这么多倍就当容器排除 */
export const CONTAINER_RATIO = 3;

/** 一次最多交给 agent 这么多个 —— 再多它也读不完，token 却照烧 */
export const MAX_ELEMENTS = 12;

/** 两个矩形（{x,y,w,h}）的相交面积 */
export function intersectArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);

/**
 * @param {Array<{el: any, rect: {x,y,w,h}}>} candidates 圈里可能涉及的元素
 * @param {{x,y,w,h}} region 圈（页面坐标）
 * @param {{max?: number, contains?: (a,b)=>boolean}} [opts]
 *        contains(a, b) = a 是否包含 b；默认用 DOM 的 Node.contains
 * @returns {Array<{el, rect, coverage: number, overlap: number}>}
 */
export function pickRegionElements(candidates, region, opts = {}) {
  const max = opts.max ?? MAX_ELEMENTS;
  const contains = opts.contains || ((a, b) => a !== b && a?.contains?.(b));
  const regionArea = area(region);
  if (!regionArea) return [];

  const touching = [];
  for (const c of candidates) {
    if (!c?.rect) continue;
    const overlap = intersectArea(c.rect, region);
    if (overlap <= 0) continue;
    const own = area(c.rect);
    touching.push({ ...c, overlap, coverage: own > 0 ? overlap / own : 0, own });
  }
  if (!touching.length) return [];

  // 规则 2：比圈大太多的是容器不是目标
  let kept = touching.filter(t => t.own <= regionArea * CONTAINER_RATIO);

  // 规则 3：祖先让位给后代
  if (kept.length > 1) {
    kept = kept.filter(a => !kept.some(b => contains(a.el, b.el)));
  }

  // 规则 4：一个都没剩（圈里全是比圈大的容器）→ 取**最小**的那个。
  // 它是包着这块地方的最内层容器，「你圈的地方在它里面」是这时候唯一说得
  // 出口的话。取相交面积最大的只会回答 body —— 那句话等于没说。
  if (!kept.length) {
    const inner = touching.reduce((m, t) => (t.own < m.own ? t : m), touching[0]);
    kept = [inner];
  }

  kept.sort((a, b) => (b.coverage - a.coverage) || (a.own - b.own));
  return kept.slice(0, max).map(({ el, rect, coverage, overlap }) => ({ el, rect, coverage, overlap }));
}

/** 圈的四条边归一化（往回拖也要得到正的宽高） */
export function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** 小到没意义的框（手抖点一下）—— 判据用面积不用边长，细长条也是有意义的框 */
export const MIN_REGION_AREA = 400;
export function isMeaningfulRegion(r) {
  return !!r && r.w > 4 && r.h > 4 && r.w * r.h >= MIN_REGION_AREA;
}

/**
 * 圈**在**谁里面 —— 完整包住这个圈的最内层元素。
 *
 * 跟 pickRegionElements 是两个问题：那个答「圈里有什么」，这个答「这块地方
 * 是页面的哪儿」。agent 两样都需要 —— 光有一串 <div> 它不知道这是页头还是
 * 页脚；光有一个 section 它不知道用户嫌的是哪几个东西。
 */
export function pickRegionContainer(candidates, region) {
  const covers = (r) => r.x <= region.x && r.y <= region.y
    && r.x + r.w >= region.x + region.w && r.y + r.h >= region.y + region.h;
  let best = null;
  for (const c of candidates) {
    if (!c?.rect || !covers(c.rect)) continue;
    if (!best || area(c.rect) < area(best.rect)) best = c;
  }
  return best;
}
