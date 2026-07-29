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
      if (byPath) return byPath;
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
