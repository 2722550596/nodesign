import { useState } from 'react';
import { GAP, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import { INK_SURFACE } from '../../lib/paper.js';

/**
 * 工具条上的一颗按钮 —— **全站唯一那一份**。
 *
 * ## 为什么单独成一个文件
 *
 * 它原来是 FloatingToolbar 内部的私有组件。工具栏 2026-08-13 开了 `node` 组
 * 的逃生口（自定义控件直接塞一段 JSX 进去，站点的「上线」走这条）之后，那些
 * 控件只能各写各的按钮 —— 结果就是"那颗怎么比旁边扁一截"：一个 30 高、一个
 * `3px 9px` 的小胶囊，配色也一个墨面一个纸面。抽出来之后**新控件只要用这颗，
 * 身位和配色天生就是对的**，不用每次回头对齐。
 *
 * 所以这个文件不依赖 FloatingToolbar（反过来是 FloatingToolbar 用它）——
 * 谁都能 import，不会绕出循环。
 *
 * ## 三种形态，一套身位
 *
 *   纯图标   30×30 正圆（当前工具那种实心圆）
 *   带文字   高 30、左右各 GAP.sm、圆角 9
 *   `boxed`  带文字且描一圈（有文字的组默认描边，纯图标的不描）
 *
 * 配色一律走 INK_SURFACE：工具条是墨面，别在这儿引入第二套。
 */

/** 身位。自定义控件要跟按钮并排时按这个来（比如那条链接药丸）。 */
export const TOOL_BTN = {
  height: 30,
  padH: GAP.sm,
  radius: 9,        // 带文字的
  radiusIcon: 999,  // 纯图标的
  gap: GAP.xs,
  fontSize: FONT_SIZE.xs,
};

/**
 * 跟按钮同身位的"非按钮"底座（链接、状态药丸这类）。
 * 给的是 style 对象不是组件 —— 那些东西的标签各不相同（a / span），
 * 包成组件反而要为每种开一个口子。
 */
export const toolPillStyle = {
  display: 'inline-flex', alignItems: 'center', gap: TOOL_BTN.gap,
  height: TOOL_BTN.height, padding: `0 ${TOOL_BTN.padH}px`,
  borderRadius: TOOL_BTN.radius,
  fontFamily: FONT_SANS, fontSize: TOOL_BTN.fontSize,
  color: INK_SURFACE.text,
  whiteSpace: 'nowrap',
};

export default function ToolbarButton({
  icon: Icon,
  label = null,
  title = null,
  active = false,
  disabled = false,
  /** 带文字时描一圈（工具条里"有文字的组"默认描边） */
  boxed = false,
  /** 危险动作（下线这类）：hover 才透出红，静止时不喊 */
  danger = false,
  onClick,
  btnRef = null,
  /** 工具条靠这个属性认出"按在按钮上"，不起拖 —— 别去掉 */
  dataId = null,
  children = null,
}) {
  const [hover, setHover] = useState(false);

  const bg = active ? INK_SURFACE.active
    : (hover && !disabled) ? INK_SURFACE.hover
    : 'transparent';
  const fg = active ? INK_SURFACE.activeText
    : disabled ? INK_SURFACE.textDim
    : (danger && hover) ? '#E08A82'
    : INK_SURFACE.text;

  return (
    <button
      ref={btnRef}
      data-tool-btn={dataId ?? (label || title || '')}
      title={title || label || undefined}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick?.(e); }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: TOOL_BTN.gap,
        // 纯图标的做成正圆，带字的做成胶囊
        width: label ? 'auto' : TOOL_BTN.height,
        height: TOOL_BTN.height,
        padding: label ? `0 ${TOOL_BTN.padH}px` : 0,
        justifyContent: 'center',
        background: bg,
        border: boxed && label ? `1px solid ${active ? 'transparent' : INK_SURFACE.hair}` : 'none',
        borderRadius: label ? TOOL_BTN.radius : TOOL_BTN.radiusIcon,
        color: fg,
        fontFamily: FONT_SANS, fontSize: TOOL_BTN.fontSize,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.14s, color 0.14s, border-color 0.14s',
        whiteSpace: 'nowrap',
      }}
    >
      {Icon && <Icon size={14} />}
      {label && <span>{label}</span>}
      {children}
    </button>
  );
}
