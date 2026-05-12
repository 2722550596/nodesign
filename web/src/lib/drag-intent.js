/**
 * drag-intent — 画布拖移工具的算法层
 *
 * 给 DragOverlay / usePendingEdits 提供"命中目标容器 + 计算插入位 + 算对齐
 * guide"等纯计算工具。不依赖 React。
 *
 * 坐标系约定（重要）：
 *   - point: iframe 内部 viewport 坐标（不受外层 transform: scale 影响）
 *     调用方传 elementFromPoint 用的也是这个坐标系
 *   - elRect / siblingsRects: getBoundingClientRect() 返回的内部 viewport 坐标
 *
 * Zoom 适配由 DragOverlay 在画绝对定位 overlay 时换算（参考 EditOverlay.jsx）。
 */

import { serializeAnchor, ensureNodeId } from './html-utils.js';
import { isInsideReactMount } from '../components/canvas/DirectEditBridge.js';

/**
 * 沿父链找一个"合适的容器"——拖动元素时把它当 drop target。
 * 标准：
 *   - 不是被拖元素自己 / 后代
 *   - 是 element 节点
 *   - 至少 1 个子元素（空容器也算，让用户能拖第一项进去）
 *   - 优先选 flex/grid display，否则选 block + 子元素 ≥ 1 的
 *
 * 返回 { container, depth }；container 找不到 → null。
 */
export function findDropContainer(hitEl, sourceEl, root) {
  if (!hitEl || !root) return null;
  const view = root.ownerDocument.defaultView;
  let cur = hitEl;
  let depth = 0;
  while (cur && cur.nodeType === 1 && cur !== root && cur !== root.ownerDocument.documentElement) {
    if (sourceEl && (cur === sourceEl || sourceEl.contains(cur))) {
      cur = cur.parentElement;
      depth++;
      continue;
    }
    if (cur.children && cur.children.length >= 1) {
      // 偏好"布局容器"：display 是 block/flex/grid 系列 + tag 不是 inline 装饰元素。
      // 排掉 <a>/<button>/<span>/<code>/<strong> 等"凑巧有 children 但实际是 inline 内容载体"。
      const cs = view?.getComputedStyle?.(cur);
      const display = cs?.display || 'block';
      const isLayout =
        display === 'block' || display === 'flex' || display === 'grid' ||
        display === 'inline-block' || display === 'inline-flex' || display === 'inline-grid' ||
        display === 'list-item' || display === 'table' || display === 'table-cell';
      const tagFriendly = !['A', 'BUTTON', 'LABEL', 'SPAN', 'CODE', 'STRONG', 'EM', 'I'].includes(cur.tagName);
      if (isLayout && tagFriendly) {
        return { container: cur, depth };
      }
    }
    cur = cur.parentElement;
    depth++;
  }
  if (root.children && root.children.length > 0) {
    return { container: root, depth };
  }
  return null;
}

/**
 * 判定 sourceEl 沿父链是否是 inline 装饰元素（不应作为 child-of 目标）。
 * 跟 findDropContainer 用的同一份白名单 → 保持算法一致性。
 */
function isLayoutContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  if (['A', 'BUTTON', 'LABEL', 'SPAN', 'CODE', 'STRONG', 'EM', 'I', 'IMG', 'SVG'].includes(el.tagName)) {
    return false;
  }
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const cs = view.getComputedStyle(el);
  const display = cs.display;
  return display === 'block' || display === 'flex' || display === 'grid' ||
         display === 'inline-block' || display === 'inline-flex' || display === 'inline-grid' ||
         display === 'list-item' || display === 'table' || display === 'table-cell';
}

/**
 * 找到 hitEl 在 container 内的直接子节点（沿父链上走直到 parent === container）。
 * 命中容器自己或命中非 container 的内容 → null。
 */
function findDirectChild(container, hitEl, sourceEl) {
  if (!hitEl || !container) return null;
  let cur = hitEl;
  while (cur && cur !== container) {
    if (sourceEl && (cur === sourceEl || sourceEl.contains(cur))) return null;
    if (cur.parentElement === container) return cur;
    cur = cur.parentElement;
  }
  return null;  // hitEl 是容器自己 or 不在 container 内
}

/**
 * 沿容器 children 几何推断流方向：水平（caret 是竖线）vs 垂直（caret 是横线）。
 * 给单独使用避免每个 callsite 重复算。
 */
function inferFlowDirection(container, sourceEl) {
  const children = Array.from(container.children).filter(c => c !== sourceEl && c.nodeType === 1);
  if (children.length < 2) {
    // 1 个 child 或空容器：用 cs.display 兜底
    const view = container.ownerDocument.defaultView;
    const cs = view ? view.getComputedStyle(container) : null;
    if (cs && (cs.display === 'flex' || cs.display === 'inline-flex')) {
      return (cs.flexDirection || 'row').startsWith('row');
    }
    return false;
  }
  const r0 = children[0].getBoundingClientRect();
  const r1 = children[1].getBoundingClientRect();
  const xOverlap = !(r0.right <= r1.left || r1.right <= r0.left);
  const yOverlap = !(r0.bottom <= r1.top || r1.bottom <= r0.top);
  if (!xOverlap && yOverlap) return true;   // horizontal
  if (xOverlap && !yOverlap) return false;  // vertical
  // 网格 fallback
  const view = container.ownerDocument.defaultView;
  const cs = view ? view.getComputedStyle(container) : null;
  if (cs && (cs.display === 'flex' || cs.display === 'inline-flex')) {
    return (cs.flexDirection || 'row').startsWith('row');
  }
  return false;
}

/**
 * Drop intent 3 分流 —— Webflow / Builder.io 风格的拖放语义：
 *   - sibling-before: 把 source 插到 hitChild 之前（同 parent）
 *   - sibling-after:  把 source 插到 hitChild 之后（同 parent）
 *   - child-of:       把 source 进入 hitChild 内部（hitChild 必须是 layout container）
 *
 * 按鼠标 point 在 hitChild rect 内的相对位置分流（沿流方向轴）：
 *   - 边缘 1/4 → sibling-before / sibling-after
 *   - 中间 1/2 + hitChild 是容器型 → child-of
 *   - 中间 1/2 + hitChild 不是容器型 → fallback 到 sibling-after
 *
 * 命中 container empty space（不在任何 child 上）→ sibling-before 第一个 child 或 sibling-after 最末
 *
 * 返回结构：
 *   {
 *     intent: 'sibling-before' | 'sibling-after' | 'child-of',
 *     targetContainer: HTMLElement,    // 实际放入的父容器（child-of 时 = hitChild）
 *     beforeEl: HTMLElement | null,    // appendChild 时 null
 *     hitChild: HTMLElement | null,    // 命中的具体 child（empty space 时 null）
 *     caretRect: { x, y, w, h, vertical } | null,  // sibling 时画 caret line
 *     zoneRect: { x, y, w, h } | null,             // child-of 时画整框高亮
 *     horizontal: bool,                            // 流方向（caret 是竖线 → true）
 *   }
 */
export function computeDropIntent(container, hitEl, sourceEl, point) {
  if (!container) return null;

  const horizontal = inferFlowDirection(container, sourceEl);
  const directChild = findDirectChild(container, hitEl, sourceEl);

  // 命中具体 child → 按 1/4 + 1/2 + 1/4 分区
  if (directChild && directChild !== sourceEl) {
    const r = directChild.getBoundingClientRect();
    let pos, size;
    if (horizontal) {
      pos = (point.x - r.left) / r.width;     // 0..1
      size = r.width;
    } else {
      pos = (point.y - r.top) / r.height;
      size = r.height;
    }
    pos = Math.max(0, Math.min(1, pos));
    // 1/4 / 1/2 / 1/4 阈值，但小元素（<60px）退化成 50/50（child-of 区被吃掉避免误触）
    const useChildOf = size >= 60 && isLayoutContainer(directChild);
    const beforeThreshold = useChildOf ? 0.25 : 0.5;
    const afterThreshold = useChildOf ? 0.75 : 0.5;

    if (pos < beforeThreshold) {
      return {
        intent: 'sibling-before',
        targetContainer: container,
        beforeEl: directChild,
        hitChild: directChild,
        caretRect: horizontal
          ? { x: r.left - 1, y: r.top, w: 2, h: r.height, vertical: true }
          : { x: r.left, y: r.top - 1, w: r.width, h: 2, vertical: false },
        zoneRect: null,
        horizontal,
      };
    }
    if (pos >= afterThreshold) {
      return {
        intent: 'sibling-after',
        targetContainer: container,
        beforeEl: directChild.nextElementSibling || null,
        hitChild: directChild,
        caretRect: horizontal
          ? { x: r.right - 1, y: r.top, w: 2, h: r.height, vertical: true }
          : { x: r.left, y: r.bottom - 1, w: r.width, h: 2, vertical: false },
        zoneRect: null,
        horizontal,
      };
    }
    // 中间 1/2 + 容器型 → child-of
    return {
      intent: 'child-of',
      targetContainer: directChild,
      beforeEl: null,  // appendChild
      hitChild: directChild,
      caretRect: null,
      zoneRect: { x: r.left, y: r.top, w: r.width, h: r.height },
      horizontal,
    };
  }

  // 命中容器 empty space → 用老 caret 算法找 sibling-before 第一个 / sibling-after 末尾
  const legacy = computeInsertCaret(container, sourceEl, point);
  if (!legacy) return null;
  return {
    intent: legacy.before ? 'sibling-before' : 'sibling-after',
    targetContainer: container,
    beforeEl: legacy.before,
    hitChild: null,
    caretRect: legacy.caretRect,
    zoneRect: null,
    horizontal,
  };
}

/**
 * (Legacy) 在容器子节点里算 insertion caret —— P1 老 API，保留兼容空间命中和 fallback。
 */
export function computeInsertCaret(container, sourceEl, point) {
  if (!container) return null;
  const children = Array.from(container.children).filter(c => c !== sourceEl && c.nodeType === 1);
  if (children.length === 0) {
    // 空容器：caret 画在容器内中线
    const cRect = container.getBoundingClientRect();
    return {
      before: null,
      caretRect: { x: cRect.left + 4, y: cRect.top + 4, w: Math.max(2, cRect.width - 8), h: 2, vertical: false },
    };
  }

  // 方向判定 = 看 children 几何而不是 display 字符串：
  //   - 任意两个相邻 child 的 x 范围不重叠（水平错位）→ 行流（horizontal caret）
  //   - 否则按列流（vertical caret）
  // 这对 flex / grid / inline-block / table-cell / 甚至浮动布局都稳。
  let horizontal = false;
  if (children.length >= 2) {
    const r0 = children[0].getBoundingClientRect();
    const r1 = children[1].getBoundingClientRect();
    const xOverlap = !(r0.right <= r1.left || r1.right <= r0.left);
    const yOverlap = !(r0.bottom <= r1.top || r1.bottom <= r0.top);
    // 横向排列 = X 不重叠 + Y 重叠；纵向 = X 重叠 + Y 不重叠
    // 都不重叠（网格） → 按 child 中心连线方向判
    if (!xOverlap && yOverlap) horizontal = true;
    else if (xOverlap && !yOverlap) horizontal = false;
    else {
      // 网格 fallback：用 cs.display 兜底
      const cs = container.ownerDocument.defaultView.getComputedStyle(container);
      const flexDir = cs.flexDirection || 'row';
      horizontal = (cs.display === 'flex' || cs.display === 'inline-flex') &&
                   (flexDir === 'row' || flexDir === 'row-reverse');
    }
  } else {
    // 只剩 1 个 child：单 child 之上/之下 vs 之左/之右用 child 中心相对 point 算
    const r = children[0].getBoundingClientRect();
    const dx = Math.abs(point.x - (r.left + r.width / 2));
    const dy = Math.abs(point.y - (r.top + r.height / 2));
    horizontal = dx > dy;  // 横向距离更大→走横轴流（caret 垂直）
  }

  for (let i = 0; i < children.length; i++) {
    const r = children[i].getBoundingClientRect();
    if (horizontal) {
      const mid = r.left + r.width / 2;
      if (point.x < mid) {
        return {
          before: children[i],
          caretRect: { x: r.left - 1, y: r.top, w: 2, h: r.height, vertical: true },
        };
      }
    } else {
      const mid = r.top + r.height / 2;
      if (point.y < mid) {
        return {
          before: children[i],
          caretRect: { x: r.left, y: r.top - 1, w: r.width, h: 2, vertical: false },
        };
      }
    }
  }
  // point 落在所有 children 之后 — 插末尾
  const last = children[children.length - 1].getBoundingClientRect();
  if (horizontal) {
    return {
      before: null,
      caretRect: { x: last.right - 1, y: last.top, w: 2, h: last.height, vertical: true },
    };
  }
  return {
    before: null,
    caretRect: { x: last.left, y: last.bottom - 1, w: last.width, h: 2, vertical: false },
  };
}

/**
 * 算 source ghost 跟周围元素的对齐 guide —— 用户拖到接近某个邻居的边/中线时
 * 显示一条 guide 线（Figma 风格）。
 *
 * 阈值：5px (iframe 内部坐标)
 *
 * 返回 [{ axis: 'x'|'y', value, hint: 'edge-left'|'center'|..., neighbor: el }]
 * 调用方按 axis + value 画线（贯穿可见 viewport 的虚线）。
 */
const ALIGN_THRESHOLD = 5;
export function computeAlignmentGuides(ghostRect, neighbors) {
  const guides = [];
  if (!ghostRect || !Array.isArray(neighbors)) return guides;

  const ghostCx = ghostRect.left + ghostRect.width / 2;
  const ghostCy = ghostRect.top + ghostRect.height / 2;

  for (const n of neighbors) {
    if (!n || !n.rect) continue;
    const r = n.rect;
    const nCx = r.left + r.width / 2;
    const nCy = r.top + r.height / 2;
    // X 轴对齐（左 / 中 / 右）
    if (Math.abs(ghostRect.left - r.left) <= ALIGN_THRESHOLD) {
      guides.push({ axis: 'x', value: r.left, hint: 'edge-left', neighbor: n.el });
    } else if (Math.abs(ghostCx - nCx) <= ALIGN_THRESHOLD) {
      guides.push({ axis: 'x', value: nCx, hint: 'center-x', neighbor: n.el });
    } else if (Math.abs(ghostRect.right - r.right) <= ALIGN_THRESHOLD) {
      guides.push({ axis: 'x', value: r.right, hint: 'edge-right', neighbor: n.el });
    }
    // Y 轴对齐（上 / 中 / 下）
    if (Math.abs(ghostRect.top - r.top) <= ALIGN_THRESHOLD) {
      guides.push({ axis: 'y', value: r.top, hint: 'edge-top', neighbor: n.el });
    } else if (Math.abs(ghostCy - nCy) <= ALIGN_THRESHOLD) {
      guides.push({ axis: 'y', value: nCy, hint: 'center-y', neighbor: n.el });
    } else if (Math.abs(ghostRect.bottom - r.bottom) <= ALIGN_THRESHOLD) {
      guides.push({ axis: 'y', value: r.bottom, hint: 'edge-bottom', neighbor: n.el });
    }
  }
  // 同 axis 同 value 只留一条（去重）
  const seen = new Set();
  return guides.filter(g => {
    const k = `${g.axis}:${Math.round(g.value)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Shift 锁轴 —— 拖动期间按住 Shift 把 ghost 限制只走 X 或 Y 轴。按 |dx| vs |dy|
 * 自动判主方向。
 *
 * 输入 ghostRect 是原始（基于原 source rect + dx/dy）的；返回锁轴后的 ghostRect。
 */
export function lockAxis(ghostRect, sourceRect, dx, dy) {
  if (!ghostRect || !sourceRect) return ghostRect;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // 锁 Y 轴 — Y 不变（= sourceRect.top）
    return {
      ...ghostRect,
      top: sourceRect.top,
      bottom: sourceRect.top + ghostRect.height,
    };
  }
  // 锁 X 轴 — X 不变
  return {
    ...ghostRect,
    left: sourceRect.left,
    right: sourceRect.left + ghostRect.width,
  };
}

/**
 * Snap to guide —— ghost 接近某条 alignment guide 时（threshold 像素内）自动吸附。
 * 修改 ghostRect 的 left/top 让视觉与 guide 对齐。
 *
 * guides 来自 computeAlignmentGuides；阈值默认 3px（比 detect 阈值小，避免吸附后又脱离）。
 */
export function snapToGuides(ghostRect, guides, threshold = 3) {
  if (!ghostRect || !Array.isArray(guides) || guides.length === 0) return ghostRect;
  let nl = ghostRect.left;
  let nt = ghostRect.top;
  const ghostCx = ghostRect.left + ghostRect.width / 2;
  const ghostCy = ghostRect.top + ghostRect.height / 2;
  for (const g of guides) {
    if (g.axis === 'x') {
      if (g.hint === 'edge-left' && Math.abs(ghostRect.left - g.value) <= threshold) {
        nl = g.value;
      } else if (g.hint === 'edge-right' && Math.abs(ghostRect.right - g.value) <= threshold) {
        nl = g.value - ghostRect.width;
      } else if (g.hint === 'center-x' && Math.abs(ghostCx - g.value) <= threshold) {
        nl = g.value - ghostRect.width / 2;
      }
    } else if (g.axis === 'y') {
      if (g.hint === 'edge-top' && Math.abs(ghostRect.top - g.value) <= threshold) {
        nt = g.value;
      } else if (g.hint === 'edge-bottom' && Math.abs(ghostRect.bottom - g.value) <= threshold) {
        nt = g.value - ghostRect.height;
      } else if (g.hint === 'center-y' && Math.abs(ghostCy - g.value) <= threshold) {
        nt = g.value - ghostRect.height / 2;
      }
    }
  }
  return {
    ...ghostRect,
    left: nl,
    top: nt,
    right: nl + ghostRect.width,
    bottom: nt + ghostRect.height,
  };
}

/**
 * Smart spacing —— 检测 ghost 与同方向邻居形成的等距点（Figma "equal spacing" hint）。
 *
 * 算法：
 *   - 在 ghost 同一行/列上找邻居（X 或 Y 重叠）
 *   - 对每个邻居 N，假设 ghost 落到 N 左侧 / 右侧 / 上方 / 下方等距位置
 *   - 等距 = ghost 与 N 的 gap === N 与另一邻居的 gap（同方向相邻）
 *
 * 返回 [{ side, gap, snapTo: { left|top: px }, neighbors: [el1, el2] }]
 * snapTo.left/top 提供等距点的精确坐标（用于 snap + 显示 hint label）
 */
const SPACING_SNAP = 4;
export function computeSmartSpacing(ghostRect, neighbors) {
  if (!ghostRect || !Array.isArray(neighbors) || neighbors.length < 2) return [];
  const out = [];
  // 找水平方向的等距：ghost 左/右各一邻居 + 这两个邻居跟 ghost 在 Y 重叠
  const horiz = neighbors.filter(n => n.rect && !(n.rect.bottom < ghostRect.top || n.rect.top > ghostRect.bottom));
  for (const a of horiz) {
    for (const b of horiz) {
      if (a === b || !a.rect || !b.rect) continue;
      if (a.rect.right >= ghostRect.left || b.rect.left <= ghostRect.right) continue;
      // a 在左, b 在右
      const gapA = ghostRect.left - a.rect.right;
      const gapB = b.rect.left - ghostRect.right;
      if (Math.abs(gapA - gapB) <= SPACING_SNAP) {
        const avg = (gapA + gapB) / 2;
        out.push({
          side: 'horizontal',
          gap: Math.round(avg),
          snapTo: { left: a.rect.right + avg },
          neighbors: [a.el, b.el],
        });
      }
    }
  }
  // 同方向垂直等距
  const vert = neighbors.filter(n => n.rect && !(n.rect.right < ghostRect.left || n.rect.left > ghostRect.right));
  for (const a of vert) {
    for (const b of vert) {
      if (a === b || !a.rect || !b.rect) continue;
      if (a.rect.bottom >= ghostRect.top || b.rect.top <= ghostRect.bottom) continue;
      const gapA = ghostRect.top - a.rect.bottom;
      const gapB = b.rect.top - ghostRect.bottom;
      if (Math.abs(gapA - gapB) <= SPACING_SNAP) {
        const avg = (gapA + gapB) / 2;
        out.push({
          side: 'vertical',
          gap: Math.round(avg),
          snapTo: { top: a.rect.bottom + avg },
          neighbors: [a.el, b.el],
        });
      }
    }
  }
  return out;
}

/**
 * 算 ghost 跟最近邻居在 X / Y 方向的间距数字标注 —— Figma 风格的"距离 12px"小标签。
 *
 * 找 ghost 上下左右四个方向最近的非 source 邻居，返回该方向的 gap 数字 + 标注几何。
 *
 * 返回 [{ side: 'top'|'right'|'bottom'|'left', gap, labelRect: {x,y,w,h} }]
 */
export function computeDistanceLabels(ghostRect, neighbors) {
  if (!ghostRect || !Array.isArray(neighbors)) return [];
  const labels = [];
  // 简化：只算"上方 / 下方 / 左方 / 右方"各最近一个
  const dirs = {
    top:    { best: Infinity, label: null },
    bottom: { best: Infinity, label: null },
    left:   { best: Infinity, label: null },
    right:  { best: Infinity, label: null },
  };

  for (const n of neighbors) {
    if (!n || !n.rect) continue;
    const r = n.rect;
    // 跟 ghost 在 X 轴上有重叠 → 算 Y 方向
    const xOverlap = !(r.right < ghostRect.left || r.left > ghostRect.right);
    if (xOverlap) {
      if (r.bottom <= ghostRect.top) {
        const gap = ghostRect.top - r.bottom;
        if (gap < dirs.top.best) {
          dirs.top.best = gap;
          dirs.top.label = { side: 'top', gap, labelRect: {
            x: ghostRect.left + ghostRect.width / 2 - 14,
            y: r.bottom + gap / 2 - 8,
            w: 28, h: 16,
          } };
        }
      } else if (r.top >= ghostRect.bottom) {
        const gap = r.top - ghostRect.bottom;
        if (gap < dirs.bottom.best) {
          dirs.bottom.best = gap;
          dirs.bottom.label = { side: 'bottom', gap, labelRect: {
            x: ghostRect.left + ghostRect.width / 2 - 14,
            y: ghostRect.bottom + gap / 2 - 8,
            w: 28, h: 16,
          } };
        }
      }
    }
    // 跟 ghost 在 Y 轴上有重叠 → 算 X 方向
    const yOverlap = !(r.bottom < ghostRect.top || r.top > ghostRect.bottom);
    if (yOverlap) {
      if (r.right <= ghostRect.left) {
        const gap = ghostRect.left - r.right;
        if (gap < dirs.left.best) {
          dirs.left.best = gap;
          dirs.left.label = { side: 'left', gap, labelRect: {
            x: r.right + gap / 2 - 14,
            y: ghostRect.top + ghostRect.height / 2 - 8,
            w: 28, h: 16,
          } };
        }
      } else if (r.left >= ghostRect.right) {
        const gap = r.left - ghostRect.right;
        if (gap < dirs.right.best) {
          dirs.right.best = gap;
          dirs.right.label = { side: 'right', gap, labelRect: {
            x: ghostRect.right + gap / 2 - 14,
            y: ghostRect.top + ghostRect.height / 2 - 8,
            w: 28, h: 16,
          } };
        }
      }
    }
  }
  for (const d of Object.values(dirs)) {
    if (d.label && d.label.gap >= 0 && d.label.gap < 200) labels.push(d.label);
  }
  return labels;
}

/**
 * 从容器收集邻居（用于 alignment guides + distance labels）。
 * 排除 source 自己 + 后代。
 *
 * 默认收集 source 同级 + source 的 grand-siblings 的孩子（深度 2 内），
 * 避免给整 deck 所有元素都对齐导致 guide 噪音。
 */
export function collectNeighbors(container, sourceEl, scope = 'siblings') {
  if (!container) return [];
  const out = [];
  const walker = (node, depth) => {
    if (!node || depth > 2) return;
    for (const c of node.children) {
      if (!c || c.nodeType !== 1) continue;
      if (sourceEl && (c === sourceEl || sourceEl.contains(c))) continue;
      out.push({ el: c, rect: c.getBoundingClientRect() });
      if (scope === 'deep' && depth < 2) walker(c, depth + 1);
    }
  };
  walker(container, 0);
  // 上一层（容器的 siblings）也来一些，让跨容器对齐能命中
  const parent = container.parentElement;
  if (parent && parent !== container.ownerDocument.body) {
    for (const c of parent.children) {
      if (c === container || c.nodeType !== 1) continue;
      if (sourceEl && (c === sourceEl || sourceEl.contains(c))) continue;
      out.push({ el: c, rect: c.getBoundingClientRect() });
    }
  }
  return out;
}

/**
 * 给一次拖动构造 pending-move payload —— 写后端 PendingChanges item 的 body。
 *
 * sourceEl / targetContainer / before 都是 iframe 内 DOM element。
 * 内部会 ensureNodeId 给三者加 data-anchor（保证 anchor 稳定）。
 *
 * 注意：调用 buildPendingMove 时 DOM 还没真搬过去（用户刚松手），所以这里的
 * "before" anchor 是基于 source 还在原位时容器里的 sibling 顺序。
 */
/**
 * 给一次自由模式拖动构造 pending-style payload。
 *
 * 自由模式 = 用户按住 P 拖动 → 元素脱离 normal flow，落到任意 (left, top) 像素坐标。
 * 我们把它当 pending-style item 推后端 buffer，agent 落地时往 source 的 inline
 * style 加 `position: absolute; left: Xpx; top: Ypx`（可能也要给 parent 加
 * `position: relative` 让 absolute 相对 parent 而不是更上的 ancestor）。
 *
 * left / top 是 source 在父容器内的绝对偏移（DragOverlay 已算好）。
 */
export function buildPendingStyleAbsolute({ sourceEl, parentEl, left, top }) {
  if (!sourceEl || !parentEl) return null;
  ensureNodeId(sourceEl);
  ensureNodeId(parentEl);

  const reactMount = isInsideReactMount(sourceEl) || isInsideReactMount(parentEl);
  const parentView = parentEl.ownerDocument.defaultView;
  const parentCs = parentView ? parentView.getComputedStyle(parentEl) : null;
  const parentNeedsRelative = parentCs && parentCs.position === 'static';

  const sr = sourceEl.getBoundingClientRect();
  const sourceView = sourceEl.ownerDocument.defaultView;
  const sourceCs = sourceView ? sourceView.getComputedStyle(sourceEl) : null;

  // ============================================================
  // 关键拆分（2026-05-12 P3 修）：
  //
  // styleDelta = **用户意图**（进 buffer 给 agent 看）—— 只含 position + left + top
  //   agent 落地时默认只改这 3 个字段，保留 source 原本的响应式特性（CSS class 里
  //   的 flex/grid/auto width 等）
  //
  // runtimeLocks = **前端 runtime 视觉补偿**（不进 buffer，agent 看不到）—— width
  //   /height/margin/transform 临时锁定，防止 source 切 absolute 时几何突变。
  //   apply 后用户视觉立即到位；revert 时一起还原。agent 落地源码后 iframe reload
  //   时不带这些锁，让原响应式生效（**除非** agent 看 preDragLayout 判断必须显式
  //   写 width/height 防反向跳变）。
  //
  // aiContext.preDragLayout = **决策上下文** — source 拖前的关键 computed style，
  //   让 agent 自己判断"是否需要补 width/height 锁尺寸 + 邻居怎么保护"
  // ============================================================

  const styleDelta = {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
  };

  const runtimeLocks = {
    width: `${Math.round(sr.width)}px`,
    height: `${Math.round(sr.height)}px`,
    margin: '0px',
    transform: 'none',
  };

  return {
    sourceAnchor: serializeAnchor(sourceEl),
    styleDelta,
    runtimeLocks,
    parentAnchor: serializeAnchor(parentEl),
    parentNeedsRelative,
    reactMount,
    aiContext: {
      sourceTag: sourceEl.tagName.toLowerCase(),
      sourceTextHint: (sourceEl.textContent || '').trim().slice(0, 40),
      parentTag: parentEl.tagName.toLowerCase(),
      parentNeedsRelative,
      preDragGeometry: { w: Math.round(sr.width), h: Math.round(sr.height) },
      neighbors: captureNeighbors(parentEl, sourceEl),  // source 同容器邻居，agent 切 absolute 时给它们加 inline 锁防 reflow
      preDragLayout: sourceCs ? {
        display: sourceCs.display,
        position: sourceCs.position,
        flex: sourceCs.flex,
        flexGrow: sourceCs.flexGrow,
        flexBasis: sourceCs.flexBasis,
        gridArea: sourceCs.gridArea,
        gridColumn: sourceCs.gridColumn,
        gridRow: sourceCs.gridRow,
        width: sourceCs.width,
        height: sourceCs.height,
        margin: sourceCs.margin,
        transform: sourceCs.transform,
      } : null,
      hint: 'free-position (absolute). User intent = position/left/top ONLY. preDragLayout shows source\'s pre-drag computed styles for your decision on whether additional width/height locks are needed to preserve geometry.',
    },
  };
}

/**
 * Capture 一个父容器内 source 的邻居列表（serializeAnchor + 当前几何）—— 给 agent 做
 * "保护邻居 layout" 决策用。aiContext.neighbors[] 让 agent 看到具体邻居 anchor + 原尺寸，
 * 能按列表给每个加 inline width/height/flex-grow:0/flex-shrink:0 锁定。
 *
 * 没这个 capture 之前 prompt 里教"默认保护邻居"是空头支票——agent 不知道邻居是谁。
 */
export function captureNeighbors(parentEl, excludeEl) {
  if (!parentEl) return [];
  const out = [];
  for (const c of parentEl.children) {
    if (!c || c.nodeType !== 1 || c === excludeEl) continue;
    ensureNodeId(c);
    const r = c.getBoundingClientRect();
    out.push({
      anchor: serializeAnchor(c),
      tag: c.tagName.toLowerCase(),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
}

/**
 * Constraints (Figma 风格 anchor) —— 用户在 ConstraintPanel 上切换 anchor 后调用。
 *
 * anchor = { x: 'left'|'right'|'center'|'stretch', y: 'top'|'bottom'|'center'|'stretch' }
 *
 * 算法：基于当前 source rect 和 parent rect 算出对应 anchor 模式下的 CSS：
 *   - left/top → `{ left: Xpx, top: Ypx }`
 *   - right/top → `{ right: (parent.right - source.right)px, top: Ypx }`
 *   - center → `{ left: 50%, transform: translateX(-50%) }`
 *   - stretch → `{ left: Xpx, right: Ypx }` (固定两边距，宽度跟父走)
 *
 * 把 styleDelta + constraint 同送 buffer；agent 落地时按 constraint 写对应 CSS。
 */
export function buildPendingStyleConstraint({ sourceEl, parentEl, constraint }) {
  if (!sourceEl || !parentEl || !constraint) return null;
  ensureNodeId(sourceEl);
  ensureNodeId(parentEl);

  const reactMount = isInsideReactMount(sourceEl) || isInsideReactMount(parentEl);
  const sr = sourceEl.getBoundingClientRect();
  const pr = parentEl.getBoundingClientRect();

  const styleDelta = { position: 'absolute' };

  // X 轴
  if (constraint.x === 'left') {
    styleDelta.left = `${Math.round(sr.left - pr.left)}px`;
    styleDelta.right = 'auto';
    styleDelta.transform = '';  // 清掉可能存在的 translateX
  } else if (constraint.x === 'right') {
    styleDelta.right = `${Math.round(pr.right - sr.right)}px`;
    styleDelta.left = 'auto';
    styleDelta.transform = '';
  } else if (constraint.x === 'center') {
    styleDelta.left = '50%';
    styleDelta.right = 'auto';
    styleDelta.transform = 'translateX(-50%)';
  } else if (constraint.x === 'stretch') {
    styleDelta.left = `${Math.round(sr.left - pr.left)}px`;
    styleDelta.right = `${Math.round(pr.right - sr.right)}px`;
    styleDelta.width = 'auto';
    styleDelta.transform = '';
  }
  // Y 轴
  if (constraint.y === 'top') {
    styleDelta.top = `${Math.round(sr.top - pr.top)}px`;
    styleDelta.bottom = 'auto';
  } else if (constraint.y === 'bottom') {
    styleDelta.bottom = `${Math.round(pr.bottom - sr.bottom)}px`;
    styleDelta.top = 'auto';
  } else if (constraint.y === 'center') {
    styleDelta.top = '50%';
    styleDelta.bottom = 'auto';
    // 累加 X 的 translate，若 X 也是 center 合并；否则单独 translateY
    if (constraint.x === 'center') {
      styleDelta.transform = 'translate(-50%, -50%)';
    } else {
      styleDelta.transform = (styleDelta.transform || '') + ' translateY(-50%)';
    }
  } else if (constraint.y === 'stretch') {
    styleDelta.top = `${Math.round(sr.top - pr.top)}px`;
    styleDelta.bottom = `${Math.round(pr.bottom - sr.bottom)}px`;
    styleDelta.height = 'auto';
  }

  return {
    sourceAnchor: serializeAnchor(sourceEl),
    parentAnchor: serializeAnchor(parentEl),
    styleDelta,
    constraint,
    reactMount,
    aiContext: {
      sourceTag: sourceEl.tagName.toLowerCase(),
      sourceTextHint: (sourceEl.textContent || '').trim().slice(0, 40),
      parentTag: parentEl.tagName.toLowerCase(),
      constraint,
      hint: `constraint anchor (${constraint.x}, ${constraint.y})`,
    },
  };
}

export function buildPendingMove({ sourceEl, targetContainer, beforeEl, intent = 'sibling-before', alignmentHints = [] }) {
  if (!sourceEl || !targetContainer) return null;
  ensureNodeId(sourceEl);
  ensureNodeId(targetContainer);
  if (beforeEl) ensureNodeId(beforeEl);

  const reactMount = isInsideReactMount(sourceEl) || isInsideReactMount(targetContainer);
  const sourceParent = sourceEl.parentElement;
  // 邻居 capture：source 离开原 parent 后 sourceParentNeighbors 会 reflow；
  // source 进入 target 后 targetContainerNeighbors 会 reflow（target 可能 = sourceParent）。
  // agent 看 neighbors[] 决定是否给每个加 inline 锁。
  const sourceParentNeighbors = captureNeighbors(sourceParent, sourceEl);
  const targetContainerNeighbors = targetContainer === sourceParent
    ? sourceParentNeighbors  // 同容器拖：邻居重合
    : captureNeighbors(targetContainer, sourceEl);

  return {
    sourceAnchor: serializeAnchor(sourceEl),
    move: {
      container: serializeAnchor(targetContainer),
      before: beforeEl ? serializeAnchor(beforeEl) : null,
      intent,  // 'sibling-before' | 'sibling-after' | 'child-of'  — 给 agent 落地一个语义 hint
    },
    reactMount,
    aiContext: {
      sourceTag: sourceEl.tagName.toLowerCase(),
      sourceTextHint: (sourceEl.textContent || '').trim().slice(0, 40),
      targetContainerTag: targetContainer.tagName.toLowerCase(),
      targetTextHint: (targetContainer.textContent || '').trim().slice(0, 60),
      intent,
      alignmentHints,
      neighbors: {
        sourceParent: sourceParentNeighbors,
        targetContainer: targetContainerNeighbors,
      },
    },
  };
}
