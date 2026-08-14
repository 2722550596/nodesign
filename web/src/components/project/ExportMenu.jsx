import { exportItemsFor } from '../../lib/export-formats.js';
import { useEffect, useRef } from 'react';
import { FileCode, FileText, Presentation, Hammer, FolderOpen, CheckSquare, Globe, Share2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * ExportMenu — 顶栏导出下拉
 *
 * 三项 active（HTML / PDF / Handoff）调 GET /api/projects/:pid/exports/:format
 * 由父级 onExport 接走 Exports.download → blob → a.click()
 *
 * PPTX 标灰禁点，留 P0+。
 */
export default function ExportMenu({ open, onClose, onExport, anchorRef, onOpenList, onPick, onShare, artifactKind = null, artifactExports = null }) {
  const ref = useRef(null);

  // 点外面关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', right: 0,
        minWidth: 240,
        background: COLOR.bgWhite,
        borderRadius: 2,
        boxShadow: SHADOW.pop,
        padding: GAP.xs,
        zIndex: 50,
      }}
    >
      {/* 分享排第一（2026-07-30）：对创作者，分享链接和导出文件是同一件事的两种出口，
          原来它们是顶栏上两个并排按钮，合并成一个菜单省一个常驻元素。 */}
      {onShare && (
        <>
          <button
            onClick={() => { onClose?.(); onShare(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: GAP.sm, width: '100%',
              padding: `${GAP.sm}px ${GAP.md}px`,
              background: 'transparent', border: 0, borderRadius: RADIUS.md, cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Share2 size={12} /> 分享链接…
          </button>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
        </>
      )}
      {exportItemsFor(artifactKind, artifactExports).map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onExport?.(item.id);
              onClose?.();
            }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'flex-start', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent',
              border: 'none',
              borderRadius: RADIUS.sm,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              opacity: item.disabled ? 0.45 : 1,
            }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={14} color={COLOR.text4} style={{ flexShrink: 0, marginTop: GAP.xxs }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>{item.label}</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1 }}>{item.desc}</div>
            </div>
          </button>
        );
      })}

      {/* 挑着导出：整包之外，用户经常只要"那三张图"/"就这份 deck"（2026-07-28）*/}
      {onPick && (
        <>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
          <button
            onClick={() => { onPick(); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'flex-start', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent', border: 'none', borderRadius: RADIUS.sm,
              cursor: 'pointer', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <CheckSquare size={14} color={COLOR.text4} style={{ flexShrink: 0, marginTop: GAP.xxs }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>挑着导出…</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1 }}>当前任务的产物，勾哪个下哪个</div>
            </div>
          </button>
        </>
      )}

      {/* C31：分隔线 + 已生成的交付文件入口（agent export_handoff 写到 workspace/exports/）*/}
      {onOpenList && (
        <>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
          <button
            onClick={() => { onOpenList(); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent',
              border: 'none',
              borderRadius: RADIUS.sm,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <FolderOpen size={14} color={COLOR.text4} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>agent 打过的包</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1 }}>agent 主动 export_handoff 后产出</div>
            </div>
          </button>
        </>
      )}
    </div>
  );
}
