/**
 * PendingMoveMarkers — 跟 CommentMarkers 同款，给"已落 pending-move（但因 React
 * mount 不动 DOM）"的元素挂一个紫色虚框 + "将移到 X" 标签。
 *
 * 仅渲染 reactMount=true 的 pending-move（纯 HTML 区已真搬过 DOM，看着位置已变，
 * 不再需要 marker）。
 *
 * 思路 = CommentMarkers：anchor → findElementByAnchor → getBoundingClientRect →
 * 实时 + zoom + offsetParent 转换。
 */

import { useEffect, useMemo, useState } from 'react';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { overlayBase, toOverlayXY } from '../../lib/overlay-rect.js';

const PURPLE = '#9c4dcc';
const PURPLE_GLOW = 'rgba(156, 77, 204, 0.18)';

export default function PendingMoveMarkers({ edits = [], iframeRef, zoom = 1 }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (edits.length === 0) return undefined;
    const iframe = iframeRef?.current;
    if (!iframe) return undefined;
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
    } catch { /* cross-origin */ }
    return () => {
      try {
        win.removeEventListener('scroll', trigger, { capture: true });
        win.removeEventListener('resize', trigger);
        window.removeEventListener('resize', trigger);
      } catch { /* */ }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [edits.length, iframeRef]);

  // 只渲染 React mount 的 pending-move（其它 kind 不需要 marker）
  const items = useMemo(
    () => edits.filter(e =>
      (e.kind === 'pending-move' || e.kind === 'pending-duplicate') && e.reactMount === true
    ),
    [edits]
  );

  if (items.length === 0 || !iframeRef?.current) return null;
  const iframe = iframeRef.current;
  const doc = iframe.contentDocument;
  if (!doc) return null;
  const iframeRect = iframe.getBoundingClientRect();
  const base = overlayBase(iframe);
  if (!base) return null;
  const win = iframe.contentWindow;
  const innerW = win?.innerWidth ?? iframeRect.width / zoom;
  const innerH = win?.innerHeight ?? iframeRect.height / zoom;

  return (
    <>
      {items.map((edit, i) => {
        const el = findElementByAnchor(edit.anchor, doc.body);
        if (!el) return null;
        const elRect = el.getBoundingClientRect();
        if (
          elRect.bottom <= 0 ||
          elRect.top >= innerH ||
          elRect.right <= 0 ||
          elRect.left >= innerW
        ) return null;
        const { top, left } = toOverlayXY(base, elRect.left, elRect.top, zoom);
        const width = elRect.width * zoom;
        const height = elRect.height * zoom;
        const targetLabel = edit.aiContext?.targetContainerTag
          ? `${edit.aiContext.targetContainerTag}`
          : '目标容器';
        return (
          // top/left: 0 不能省，理由同 CommentMarkers（absolute 不写偏移会落在
          // flex 容器的居中静态位置，整组标记右移半个容器宽）
          <div key={i} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
            <div style={{
              position: 'absolute',
              pointerEvents: 'none',
              top: top - 3,
              left: left - 3,
              width: width + 6,
              height: height + 6,
              border: `2px dashed ${PURPLE}`,
              borderRadius: 4,
              boxShadow: `0 0 0 3px ${PURPLE_GLOW}`,
              zIndex: 9,
            }} />
            <div style={{
              position: 'absolute',
              pointerEvents: 'none',
              top: top - 12,
              left: left + width - 8,
              transform: 'translateX(-100%)',
              padding: '2px 6px',
              fontFamily: '"SF Mono", monospace',
              fontSize: 10, lineHeight: '14px', fontWeight: 500,
              color: '#fff',
              background: PURPLE,
              borderRadius: 3,
              whiteSpace: 'nowrap',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              zIndex: 11,
              maxWidth: Math.max(120, width),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {edit.kind === 'pending-duplicate' ? '复制到' : '移到'} &lt;{targetLabel}&gt;
            </div>
          </div>
        );
      })}
    </>
  );
}
