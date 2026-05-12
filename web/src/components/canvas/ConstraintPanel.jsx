/**
 * ConstraintPanel — Figma 风格 anchor 选择浮窗
 *
 * 仅在 drag mode + freeMode + 有 lastSelectedSource 时显示。
 *
 * UI：3x3 grid（横/竖各 3 选项：左 / 中 / 右 / 拉伸——拉伸放右上角作为单独按钮组合）
 *   ┌─┬─┬─┐
 *   │↖│↑│↗│
 *   ├─┼─┼─┤
 *   │←│●│→│
 *   ├─┼─┼─┤
 *   │↙│↓│↘│
 *   └─┴─┴─┘
 *   + 下方两个 stretch toggle： [↔ 横向拉伸] [↕ 纵向拉伸]
 *
 * 点击 grid 单元 → 设置 (x, y) → onChange 触发 buildPendingStyleConstraint 派单。
 */

import { useEffect, useState } from 'react';
import { Maximize2, ChevronDown, ChevronRight } from 'lucide-react';

const ANCHOR_GRID = [
  [{ x: 'left',   y: 'top'    }, { x: 'center', y: 'top'    }, { x: 'right',  y: 'top'    }],
  [{ x: 'left',   y: 'center' }, { x: 'center', y: 'center' }, { x: 'right',  y: 'center' }],
  [{ x: 'left',   y: 'bottom' }, { x: 'center', y: 'bottom' }, { x: 'right',  y: 'bottom' }],
];

const HINT = {
  'left':    '左对齐',
  'right':   '右对齐',
  'center':  '居中',
  'stretch': '拉伸',
  'top':     '顶对齐',
  'bottom':  '底对齐',
};

export default function ConstraintPanel({
  active,                 // freeMode + lastSelectedSource 存在时 true
  iframeRef,
  zoom = 1,
  sourceEl,               // 当前选中元素（DragOverlay 的 lastSelectedSourceRef.current）
  currentConstraint = { x: 'left', y: 'top' },
  onChange,               // (newConstraint) => void
}) {
  // 默认折叠 —— NoDesign deck 是固定尺寸（4 档 aspect），父几乎不 resize，constraint 实际收益小；
  // 老老实实当 Figma sota 标配藏起来，懂的人点开能用。
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active || !iframeRef?.current) return undefined;
    const iframe = iframeRef.current;
    const win = iframe.contentWindow;
    if (!win) return undefined;
    let rafId = null;
    const trigger = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = null; setTick(t => t + 1); });
    };
    try {
      win.addEventListener('scroll', trigger, { passive: true, capture: true });
      win.addEventListener('resize', trigger);
      window.addEventListener('resize', trigger);
    } catch { /* */ }
    return () => {
      try {
        win.removeEventListener('scroll', trigger, { capture: true });
        win.removeEventListener('resize', trigger);
        window.removeEventListener('resize', trigger);
      } catch { /* */ }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [active, iframeRef]);

  if (!active || !sourceEl || !sourceEl.isConnected || !iframeRef?.current) return null;

  const iframe = iframeRef.current;
  const iframeRect = iframe.getBoundingClientRect();
  const offsetParent = iframe.offsetParent;
  if (!offsetParent) return null;
  const containerRect = offsetParent.getBoundingClientRect();
  const r = sourceEl.getBoundingClientRect();

  // 浮窗定位：source 右上角偏移 10px 浮出（跟 GrabHandle 一致风格但更下面）
  const top = (iframeRect.top + r.top * zoom) - containerRect.top - 10;
  const left = (iframeRect.left + r.right * zoom) - containerRect.left + 10;

  const isStretchX = currentConstraint.x === 'stretch';
  const isStretchY = currentConstraint.y === 'stretch';

  // 折叠态用的紧凑表示：anchor 缩成 1 个 chip 显示当前组合
  const anchorChip = formatAnchorChip(currentConstraint);

  return (
    <div
      style={{
        position: 'absolute',
        top, left,
        background: 'rgba(255,255,255,0.98)',
        border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
        padding: expanded ? 8 : 6,
        zIndex: 45,
        fontFamily: '"SF Mono", monospace',
        pointerEvents: 'auto',
      }}
    >
      {/* 顶部 toggle 行：折叠态显示"⚓ Anchor: 左·上"，展开态显示带 ▾ 的标题 */}
      <button
        onClick={() => setExpanded(v => !v)}
        title={expanded ? '收起 Anchor 设置' : '展开 Anchor 设置（决定父 resize 时元素跟哪边）'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 4px',
          background: 'transparent',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: 10,
          color: 'rgba(45,36,24,0.75)',
          cursor: 'pointer',
          marginBottom: expanded ? 6 : 0,
        }}
      >
        {expanded
          ? <ChevronDown size={11} />
          : <ChevronRight size={11} />}
        <span style={{ textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 9 }}>Anchor</span>
        {!expanded && (
          <span style={{
            marginLeft: 4,
            padding: '0 5px',
            fontSize: 9,
            color: '#fff',
            background: '#3a7afe',
            borderRadius: 8,
            lineHeight: '13px',
          }}>{anchorChip}</span>
        )}
      </button>

      {expanded && (
        <>
          {/* 3x3 grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 22px)', gap: 2 }}>
            {ANCHOR_GRID.flat().map((a, i) => {
              const isActive = currentConstraint.x === a.x && currentConstraint.y === a.y;
              return (
                <button
                  key={i}
                  onClick={() => onChange?.({ ...a })}
                  title={`${HINT[a.x]} · ${HINT[a.y]}`}
                  style={{
                    width: 22, height: 22,
                    padding: 0,
                    border: '1px solid rgba(0,0,0,0.08)',
                    borderRadius: 3,
                    background: isActive ? '#3a7afe' : 'rgba(0,0,0,0.03)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span style={{
                    width: 5, height: 5,
                    borderRadius: '50%',
                    background: isActive ? '#fff' : 'rgba(45,36,24,0.45)',
                  }} />
                </button>
              );
            })}
          </div>
          {/* Stretch toggles */}
          <div style={{
            marginTop: 6, display: 'flex', gap: 4,
            fontSize: 9, color: 'rgba(45,36,24,0.7)',
          }}>
            <button
              onClick={() => onChange?.({
                x: isStretchX ? 'left' : 'stretch',
                y: currentConstraint.y,
              })}
              title="横向拉伸（width 跟父走）"
              style={stretchBtn(isStretchX)}
            >
              <Maximize2 size={9} style={{ transform: 'rotate(45deg)' }} />
              ↔
            </button>
            <button
              onClick={() => onChange?.({
                x: currentConstraint.x,
                y: isStretchY ? 'top' : 'stretch',
              })}
              title="纵向拉伸（height 跟父走）"
              style={stretchBtn(isStretchY)}
            >
              <Maximize2 size={9} style={{ transform: 'rotate(-45deg)' }} />
              ↕
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatAnchorChip(c) {
  const SHORT = {
    'left': '左', 'right': '右', 'center': '中', 'stretch': '伸',
    'top': '上', 'bottom': '下',
  };
  return `${SHORT[c.x] || c.x}·${SHORT[c.y] || c.y}`;
}

function stretchBtn(active) {
  return {
    flex: 1,
    padding: '3px 4px',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 3,
    background: active ? '#3a7afe' : 'rgba(0,0,0,0.03)',
    color: active ? '#fff' : 'inherit',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 2,
    cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 'inherit',
  };
}
