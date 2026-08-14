/**
 * anchored-popover —— 让浮层贴着触发它的那颗按钮，而不是贴着窗角。
 *
 * 起因（2026-08-07）：deck 窗的 System / Comment / A11y 三个浮层原来写死
 * `position:absolute; top:78; right:16`，因为触发它们的工具栏也写死在窗顶。
 * 工具栏浮起来能拖之后这个假设塌了 —— 按钮在左边、浮层在右上角，两者没关系；
 * 更糟的是聊天栏默认就浮在右上，浮层整个躲在它下面点不着。
 *
 * 这里按锚点按钮的**视口坐标**算位置，用 fixed 定位，并夹在视口内。
 * 锚点没给或量不到就退回右上角（老行为），不至于把浮层弄丢。
 */

import { useState, useLayoutEffect } from 'react';

const MARGIN = 12;
const GAP_BELOW = 8;

/**
 * @param {{current: HTMLElement|null}} anchorRef 触发按钮
 * @param {number} width  浮层宽（用来夹边，必须跟浮层实际宽一致）
 * @returns {object} 直接摊进浮层根节点 style 的定位属性
 */
export function useAnchoredPosition(anchorRef, width) {
  const [style, setStyle] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef?.current;
    if (!el) { setStyle(null); return; }
    const place = () => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) { setStyle(null); return; }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 左对齐锚点，装不下就往左收；再不行贴左边
      const left = Math.max(MARGIN, Math.min(r.left, vw - width - MARGIN));
      const top = Math.min(r.bottom + GAP_BELOW, vh - MARGIN - 120);
      setStyle({ position: 'fixed', left, top, maxHeight: vh - top - MARGIN });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef, width]);

  return style || { position: 'absolute', top: 78, right: 16 };
}
