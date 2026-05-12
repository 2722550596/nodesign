/**
 * pending-edit-apply — 把 pending edit 的视觉表达落到 iframe 运行时
 *
 * 两条分流：
 *   - 纯 HTML 区：直接 appendChild / insertBefore 真的搬 DOM 节点（源代码不动；
 *     iframe reload 时回原状）。
 *   - React mount 区：不动 DOM，让 onMarker 回调挂一个 floating marker。
 *
 * 调用方：DragOverlay 拖完调一次。
 */

import { isInsideReactMount } from '../components/canvas/DirectEditBridge.js';
import { findElementByAnchor } from './html-utils.js';

/**
 * 应用一条 pending-move 到运行时 DOM。
 *
 * @param {object} params
 * @param {Document} params.iframeDoc
 * @param {HTMLElement} params.sourceEl     当前已 attach 在 DOM 里的 source（DragOverlay 拖完直接传过来）
 * @param {HTMLElement} params.targetContainer
 * @param {HTMLElement|null} params.beforeEl  null = appendChild
 * @returns {{ applied: 'dom' | 'marker-only', markerInfo?: object }}
 *   - 'dom'         真的搬了节点
 *   - 'marker-only' 在 React 区不动 DOM；调用方应挂一个 floating marker
 */
export function applyMoveToRuntime({ iframeDoc, sourceEl, targetContainer, beforeEl }) {
  if (!iframeDoc || !sourceEl || !targetContainer) {
    return { applied: 'marker-only', markerInfo: { reason: 'invalid' }, revert: () => {} };
  }
  // React mount 区：不动 DOM（避免被 next render 立即覆盖回去看着像"拖完跳回"）
  if (isInsideReactMount(sourceEl) || isInsideReactMount(targetContainer)) {
    return {
      applied: 'marker-only',
      markerInfo: {
        reason: 'react-mount',
        sourceRect: sourceEl.getBoundingClientRect(),
        targetRect: targetContainer.getBoundingClientRect(),
      },
      revert: () => {},  // DOM 没动，无需 revert
    };
  }
  // ── Apply 前 snapshot 原位置 → 包成 revert 闭包传上去 ──
  const originalParent = sourceEl.parentElement;
  const originalNextSibling = sourceEl.nextElementSibling;
  try {
    if (beforeEl && beforeEl.parentNode === targetContainer) {
      targetContainer.insertBefore(sourceEl, beforeEl);
    } else {
      targetContainer.appendChild(sourceEl);
    }
    return {
      applied: 'dom',
      revert: () => revertMoveInRuntime({ sourceEl, originalParent, originalNextSibling }),
    };
  } catch (err) {
    return {
      applied: 'marker-only',
      markerInfo: { reason: 'dom-error', message: err.message },
      revert: () => {},
    };
  }
}

/**
 * 自由模式落地（freeMode）：把 styleDelta 直接写到 source 的 inline style 让
 * 视觉立即看到"脱离 normal flow 落到那个像素位置"。如果 parent 是 static，
 * 给 parent 临时加 position: relative 让 absolute 相对 parent 对齐（不然
 * left/top 会相对更上的 positioned ancestor，跟用户拖的位置错位）。
 *
 * React mount 区域：不动 source / parent 的 DOM 属性（会被 next render 覆盖）。
 * 仍 push 后端 pending-style，agent 落地时改源码。
 */
export function applyStyleToRuntime({ sourceEl, parentEl, styleDelta, runtimeLocks, parentNeedsRelative }) {
  if (!sourceEl || !styleDelta) return { applied: 'marker-only', reason: 'invalid', revert: () => {} };
  if (isInsideReactMount(sourceEl) || (parentEl && isInsideReactMount(parentEl))) {
    return { applied: 'marker-only', reason: 'react-mount', revert: () => {} };
  }
  // 合并 styleDelta（用户意图）+ runtimeLocks（前端视觉补偿）一起 apply 到 runtime DOM。
  // styleDelta 进 buffer 给 agent；runtimeLocks 只在前端 runtime 生效，agent 看不到。
  const combinedStyles = { ...styleDelta, ...(runtimeLocks || {}) };
  // Snapshot 旧值，包成 revert 闭包
  const prevSourceStyles = {};
  for (const k of Object.keys(combinedStyles)) {
    prevSourceStyles[k] = sourceEl.style[k] || '';  // 空字符串 = 移除 inline 值
  }
  const prevParentPosition = parentNeedsRelative && parentEl ? (parentEl.style.position || '') : null;
  try {
    if (parentNeedsRelative && parentEl) {
      parentEl.style.position = 'relative';
    }
    for (const [k, v] of Object.entries(combinedStyles)) {
      sourceEl.style[k] = v;
    }
    return {
      applied: 'dom',
      revert: () => {
        try {
          for (const [k, v] of Object.entries(prevSourceStyles)) {
            sourceEl.style[k] = v;
          }
          if (prevParentPosition !== null && parentEl) {
            parentEl.style.position = prevParentPosition;
          }
        } catch { /* element may be gone */ }
      },
    };
  } catch (err) {
    return { applied: 'marker-only', reason: 'dom-error', message: err.message, revert: () => {} };
  }
}

/**
 * 撤销一次 DOM 移动：source 还在新位置，把它搬回原 parent + 原 sibling 之前。
 * 调用方需要在原 move 时记下 { originalParent, originalNextSibling }。
 */
export function revertMoveInRuntime({ sourceEl, originalParent, originalNextSibling }) {
  if (!sourceEl || !originalParent) return;
  try {
    if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
      originalParent.insertBefore(sourceEl, originalNextSibling);
    } else {
      originalParent.appendChild(sourceEl);
    }
  } catch { /* ignore — 元素可能被 React 接管或源代码已变 */ }
}

/**
 * 给 React 区域 pending-move 找回 source/target —— 用 anchor 在当前 DOM 里搜。
 * 给 PendingEditsBar 的"待应用列表"展示用。
 */
export function findEditElements(iframeDoc, edit) {
  if (!iframeDoc || !edit) return { source: null, target: null };
  return {
    source: edit.anchor ? findElementByAnchor(edit.anchor, iframeDoc.body) : null,
    target: edit.move?.container ? findElementByAnchor(edit.move.container, iframeDoc.body) : null,
  };
}
