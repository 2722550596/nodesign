/**
 * HTML / DOM 操作工具
 *
 * 用途：
 *   - inline comment / direct edit / future CAD 拖动 都需要"锚定一个元素"
 *   - 锚点要够稳，能跨 HTML patch 找回（不是只存坐标）
 *
 * 锚点三层（按可靠性从高到低，找回时按顺序尝试）：
 *   1. data-anchor（agent 生成时埋的稳定 id；最可靠）—— 2026-05-08 anchor 单写
 *      改造前是 data-node-id，改造后 data-anchor 唯一锚源
 *   2. DOM path（tag + nth-of-type 链；HTML 结构没变就稳）
 *   3. textHint（前 50 字 + bbox；前两层都失效时 fuzzy 回找）
 *
 * pending-changes.json schema 的 anchor.dataId 字段名保留（不破坏落档兼容），
 * 但内容现在来自 element.dataset.anchor 而非 dataset.nodeId。
 */

/** 把 DOM 元素序列化成可存储的锚点对象 */
export function serializeAnchor(el) {
  if (!el || el.nodeType !== 1) return null;
  // anchor 单写：dataId 字段值改读 data-anchor（schema 字段名保留兼容）
  const dataId = el.getAttribute?.('data-anchor') || null;
  const path = computeDomPath(el);
  const textHint = (el.textContent || '').trim().slice(0, 50);
  const rect = el.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
  return {
    dataId,
    path,
    textHint,
    bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  };
}

/** 计算 DOM path：tag:nth-of-type(N) > tag > ... */
function computeDomPath(el, root = el.ownerDocument?.body) {
  const segments = [];
  let cur = el;
  while (cur && cur !== root && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentNode;
    if (!parent || parent.nodeType !== 1) break;
    const sameType = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
    const idx = sameType.indexOf(cur) + 1;
    segments.unshift(sameType.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    cur = parent;
  }
  return segments.join(' > ');
}

/** 用锚点找回元素（按 dataId(=data-anchor) → path → textHint 顺序）*/
export function findElementByAnchor(anchor, root) {
  if (!anchor || !root) return null;
  if (anchor.dataId) {
    try {
      const byId = root.querySelector(`[data-anchor="${CSS.escape(anchor.dataId)}"]`);
      if (byId) return byId;
    } catch { /* fall through */ }
  }
  if (anchor.path) {
    try {
      const byPath = root.querySelector(anchor.path);
      // path 是位置式的（nth-of-type 链），DOM 一动就指到邻居去。**命中了也要对一下
      // textHint**：对不上说明这条路径已经过期，让给下面的文本查找。
      // 实测踩到：一页卡片被拖动过之后，评论在「腹黑毒舌」上，标记画到了「温柔暖心」——
      // 正好差一个兄弟节点（2026-07-30）。
      if (byPath && !anchorTextMismatch(anchor, byPath)) return byPath;
    } catch { /* invalid selector, fall through */ }
  }
  if (anchor.textHint) {
    // 取命中里 textContent 最短的（最具体的那个），不是文档序第一个 ——
    // 文档序里祖先先于后代，而祖先的文本以第一个后代的文本开头，
    // "第一个命中"永远是祖先容器（.cards 抢 card-a 的坑，2026-07-30）
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let best = null;
    let bestLen = Infinity;
    let n = walker.nextNode();
    while (n) {
      const t = (n.textContent || '').trim();
      if (t.startsWith(anchor.textHint) && t.length < bestLen) {
        best = n;
        bestLen = t.length;
      }
      n = walker.nextNode();
    }
    return best;
  }
  return null;
}

/**
 * 给 element 加个 data-anchor（如果没有），返回 anchor 值。用于让锚点稳定。
 *
 * 函数名 ensureNodeId 保留兼容性（callsite 不需要改），但内部改写 data-anchor。
 */
export function ensureNodeId(el) {
  if (!el || el.nodeType !== 1) return null;
  let id = el.getAttribute('data-anchor');
  if (!id) {
    id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    el.setAttribute('data-anchor', id);
  }
  return id;
}

/** path 命中的元素跟当初记下的文本对不对得上（textHint 为空时不判） */
function anchorTextMismatch(anchor, el) {
  const hint = (anchor.textHint || '').trim();
  if (!hint) return false;
  const now = (el.textContent || '').trim();
  return !now.startsWith(hint) && !hint.startsWith(now);
}

/**
 * 稳定锚点：先在元素上盖一个 data-anchor 再序列化。
 *
 * 用在**要长期存活的引用**上（评论、选中）。位置式 path 一旦 DOM 被搬动就失准，
 * 而站点/deck 的拖拽是真的在搬 DOM 节点（pending-edit-apply.js），所以纯 path 的
 * 锚点活不过一次拖拽。原来只有拖拽路径调 ensureNodeId，评论和选中都没调 ——
 * 于是"评论 A 元素、标记画在 B 元素上"。
 */
export function serializeStableAnchor(el) {
  if (!el || el.nodeType !== 1) return null;
  try { ensureNodeId(el); } catch { /* 只读文档等场景：退回纯 path */ }
  return serializeAnchor(el);
}
