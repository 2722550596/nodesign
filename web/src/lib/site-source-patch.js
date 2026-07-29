/**
 * site-source-patch — 把用户在运行时 DOM 上做的操作重放到磁盘源码的干净副本上
 *
 * 为什么不直接序列化运行时 DOM：带脚本的页面在运行时会改写自己 —— GSAP 的
 * pin-spacer 包裹、注入的节点、动画打到一半的内联 transform、lazyload 占位……
 * 整页 outerHTML 会把这些运行时产物一并烤进源文件：下次加载动画从中间态开始、
 * pin 结构双重包裹。所以落盘走这条路：取磁盘上的干净源码 → DOMParser 解析 →
 * 按锚点重放用户操作（改字/搬移/复制/定位）→ 序列化。脚本污染永远进不了文件。
 *
 * 锚点在干净副本上按 path/textHint 找（运行时 stamp 的 data-anchor 源码里没有，
 * 也不该有 —— 站点源码保持干净）。任何一个操作找不到锚定元素就整体放弃返回
 * null，调用方回退到整页序列化 —— 宁可带污染也不能丢用户的改动。
 *
 * op 形状（SiteWindow 落盘队列生成）：
 *   { type: 'text',      anchor, newText }
 *   { type: 'move',      anchor, container, before }        // before: anchor|null
 *   { type: 'duplicate', anchor, container, before }
 *   { type: 'style',     anchor, styles, parentNeedsRelative }
 */

import { findElementByAnchor } from './html-utils.js';

export function applyOpsToSource(sourceHtml, ops) {
  if (typeof sourceHtml !== 'string' || !sourceHtml.trim() || !Array.isArray(ops) || ops.length === 0) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(sourceHtml, 'text/html'); } catch { return null; }
  if (!doc?.body) return null;
  for (const op of ops) {
    if (!applyOne(doc, op)) return null;
  }
  const dt = sourceHtml.match(/^\s*<!doctype[^>]*>/i);
  return `${dt ? dt[0].trim() : '<!doctype html>'}\n${doc.documentElement.outerHTML}`;
}

function applyOne(doc, op) {
  if (!op || !op.anchor) return false;
  const el = findElementByAnchor(op.anchor, doc.body);
  if (!el) return false;

  if (op.type === 'text') {
    if (typeof op.newText !== 'string') return false;
    el.textContent = op.newText;
    return true;
  }

  if (op.type === 'style') {
    if (!op.styles || typeof op.styles !== 'object') return false;
    if (op.parentNeedsRelative && el.parentElement) {
      el.parentElement.style.position = 'relative';
    }
    for (const [k, v] of Object.entries(op.styles)) {
      try { el.style[k] = v; } catch { /* 单个非法值跳过，不整体放弃 */ }
    }
    return true;
  }

  if (op.type === 'move' || op.type === 'duplicate') {
    const container = op.container ? findElementByAnchor(op.container, doc.body) : null;
    if (!container || container === el || el.contains(container)) return false;
    // 严格校验：意图里有 before 就必须解析出来且真是 container 的孩子。
    // 解析歪了绝不静默近似成 appendChild —— 位置错了比整体回退（带污染但位置对）更糟
    let before = null;
    if (op.before) {
      before = findElementByAnchor(op.before, doc.body);
      if (!before || before.parentNode !== container) return false;
    }
    const node = op.type === 'duplicate' ? el.cloneNode(true) : el;
    if (op.type === 'duplicate') {
      try { node.removeAttribute('data-anchor'); } catch { /* */ }
    }
    if (before) container.insertBefore(node, before);
    else container.appendChild(node);
    return true;
  }

  return false;
}
