import { useState, useRef, useCallback, useEffect } from 'react';
import { INK_SURFACE } from '../../lib/paper.js';
import { FONT_SANS, FONT_SIZE, GAP } from '../../lib/theme.js';
import { usePanelState } from '../layout/PanelManager.jsx';

/**
 * FloatingToolbar —— 浮在内容之上、可拖动的工具条（2026-08-07）
 *
 * 用户要的是「一个能四处应用、盛放所有手动操作工具的容器」：画布有画布的
 * 工具（选择 / 文字 / 笔 / 评论），deck 窗口有 deck 的，站点窗口有站点的，
 * 世界窗口有世界的。以前每种窗口各自长一条固定工具栏，形态一多就各写各的。
 *
 * ## 两种组，这是全部的抽象
 *
 * - **动作组**：按一下做一件事（存档 / 导出 / 刷新）。
 * - **模式组**（`type: 'mode'`）：单选，选中的那个是「当前工具」。
 *   画布的选择/文字/笔/评论就是它，同一时刻只能有一个。
 *
 * 分成两种是因为它们的**反馈语义**根本不同：动作按完就弹回，模式按完要一直
 *亮着告诉你"现在手里拿的是笔"。混在一起做会得到一个既像按钮又像开关的东西。
 *
 * ## 为什么不用 FloatingPanel
 *
 * 那是带标题栏 + 可 resize 的面板壳（浮动 agent 栏该用它）。工具条没有标题栏、
 * 不该 resize、宽度由内容定。共用的只有"能拖 + 记住位置"，那部分走同一个
 * PanelManager，视觉和交互各走各的。
 *
 * ## 拖拽为什么不用 react-rnd
 *
 * Rnd 靠 `dragHandleClassName` 划拖拽区，而这里要的是「整条都能拖，**除了**
 * 按钮」—— 按钮在 handle 内部，Rnd 照样会起拖，一点按钮就把整条拽跑。
 * 指针事件自己写反而更短更准：按下时看 `closest('[data-tool-btn]')`，是按钮
 * 就不起拖。
 */

/** 拖过这么多像素才算拖，否则算点击（防手抖把点按钮变成微拖） */
const DRAG_SLOP = 3;

export default function FloatingToolbar({
  /** 传了就走 PanelManager 持久化位置；不传就是纯局部状态 */
  id,
  groups = [],
  defaultPosition = { x: 24, y: 24 },
  /** 组之间的堆叠方向。参考图是竖着堆两条，所以默认 column */
  stack = 'column',
  /** 限位容器（不传就不限位）。传 ref 或 DOM 元素都行 */
  boundsRef,
  style,
}) {
  const panel = usePanelState(id);
  const [localPos, setLocalPos] = useState(defaultPosition);
  const pos = (panel?.position) || localPos;

  const elRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const commit = useCallback((p) => {
    if (panel?.setPosition) panel.setPosition(p);
    else setLocalPos(p);
  }, [panel]);

  const onPointerDown = useCallback((e) => {
    // 按在按钮上不起拖 —— 整条都能拖，除了按钮
    if (e.target.closest?.('[data-tool-btn]')) return;
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      originX: pos.x, originY: pos.y,
      moved: false,
    };
    panel?.bringToFront?.();
  }, [pos.x, pos.y, panel]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
    if (!d.moved) { d.moved = true; setDragging(true); }

    let x = d.originX + dx;
    let y = d.originY + dy;

    // 限位：整条不许拖出容器（否则拖丢了就找不回来，只能清 localStorage）
    const bounds = boundsRef?.current;
    const el = elRef.current;
    if (bounds && el) {
      const bw = bounds.clientWidth; const bh = bounds.clientHeight;
      x = Math.min(Math.max(0, x), Math.max(0, bw - el.offsetWidth));
      y = Math.min(Math.max(0, y), Math.max(0, bh - el.offsetHeight));
    }
    commit({ x, y });
  }, [boundsRef, commit]);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  // 容器尺寸变了（窗口缩放 / 侧栏开合）要把跑到界外的工具条拉回来
  useEffect(() => {
    const bounds = boundsRef?.current;
    const el = elRef.current;
    if (!bounds || !el) return;
    const fix = () => {
      const maxX = Math.max(0, bounds.clientWidth - el.offsetWidth);
      const maxY = Math.max(0, bounds.clientHeight - el.offsetHeight);
      if (pos.x > maxX || pos.y > maxY) {
        commit({ x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) });
      }
    };
    const ro = new ResizeObserver(fix);
    ro.observe(bounds);
    return () => ro.disconnect();
  }, [boundsRef, pos.x, pos.y, commit]);

  if (!groups.length) return null;

  return (
    <div
      ref={elRef}
      data-floating-toolbar={id || ''}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: 'absolute', left: pos.x, top: pos.y,
        zIndex: panel?.zIndex || 400,
        display: 'flex', flexDirection: stack, alignItems: 'center', gap: GAP.xs,
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none', touchAction: 'none',
        // 拖拽中略透，让底下的内容还看得见落点
        opacity: dragging ? 0.88 : 1,
        transition: 'opacity 0.15s',
        ...style,
      }}
    >
      {groups.filter(g => g && g.items?.length).map(g => (
        <ToolGroup key={g.id} group={g} />
      ))}
    </div>
  );
}

function ToolGroup({ group }) {
  const isMode = group.type === 'mode';
  // 有文字的默认给每颗按钮描一圈（参考图上排那样），纯图标的不描
  const boxed = group.variant
    ? group.variant === 'boxed'
    : group.items.some(it => it.label);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: boxed ? GAP.xs : 2,
      background: INK_SURFACE.bg,
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      borderRadius: 14,
      padding: boxed ? `${GAP.xs}px ${GAP.sm}px` : 4,
      boxShadow: INK_SURFACE.shadow,
    }}>
      {group.items.map(it => (
        <ToolButton
          key={it.id}
          item={it}
          boxed={boxed}
          active={isMode && group.value === it.id}
          onPick={() => (isMode ? group.onChange?.(it.id) : it.onClick?.())}
        />
      ))}
    </div>
  );
}

function ToolButton({ item, boxed, active, onPick }) {
  const [hover, setHover] = useState(false);
  const Icon = item.icon;
  const disabled = !!item.disabled;

  const bg = active ? INK_SURFACE.active
    : (hover && !disabled) ? INK_SURFACE.hover
    : 'transparent';
  const fg = active ? INK_SURFACE.activeText
    : disabled ? INK_SURFACE.textDim
    : INK_SURFACE.text;

  return (
    <button
      data-tool-btn={item.id}
      title={item.title || item.label || item.id}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onPick(); }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
        // 纯图标的做成正圆（参考图里当前工具是个实心圆），带字的做成胶囊
        width: item.label ? 'auto' : 30,
        height: 30,
        padding: item.label ? `0 ${GAP.sm}px` : 0,
        justifyContent: 'center',
        background: bg,
        border: boxed && item.label ? `1px solid ${active ? 'transparent' : INK_SURFACE.hair}` : 'none',
        borderRadius: item.label ? 9 : 999,
        color: fg,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.14s, color 0.14s, border-color 0.14s',
        whiteSpace: 'nowrap',
      }}
    >
      {Icon && <Icon size={14} />}
      {item.label && <span>{item.label}</span>}
    </button>
  );
}
