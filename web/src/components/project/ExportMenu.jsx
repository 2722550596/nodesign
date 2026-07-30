import { useEffect, useRef } from 'react';
import { FileCode, FileText, Presentation, Hammer, FolderOpen, CheckSquare, Globe, Share2 } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * 格式 id → 展示元数据。**哪些格式可用由服务端 kinds/ 注册表定**（/artifacts 的
 * tasks[].exports，经 boardUi.artifactExports 传进来）—— 前端只管每个格式长什么样。
 * 这样第三种形态（视频等）上线时菜单自动跟上，不用再改这里的 if。
 * 文案按形态微调（deck 的 handoff 装单文件 HTML，站点的装整站）。
 */
const FORMAT_META = {
  html:    { icon: FileCode,     label: 'Standalone HTML',    desc: '单文件，可双击打开',
             siteLabel: '单页自包含 HTML',  siteDesc: '只当前入口页，图片内联' },
  pdf:     { icon: FileText,     label: 'PDF',                desc: 'playwright print 1920×1080（矢量文字 + 4K-ready）' },
  pptx:    { icon: Presentation, label: 'PowerPoint (.pptx)', desc: '每页截图嵌 PPTX（位图，文字不可编辑）' },
  site:    { icon: Globe,        label: '整站打包 (.zip)',     desc: '全部页面 + 样式 + 图，解压双击就能看' },
  handoff: { icon: Hammer,       label: '源码包',               desc: 'ZIP: HTML + spec + assets + README',
             siteDesc: 'ZIP: 整站 + spec + assets + README' },
};

// 服务端没给格式表时的兜底（旧数据 / 聚焦的不是任务）
const FALLBACK_FORMATS = {
  deck: ['html', 'pdf', 'pptx', 'handoff'],
  site: ['site', 'html', 'handoff'],
};

function itemsFor(artifactKind, artifactExports) {
  const isSite = artifactKind === 'site';
  const ids = (Array.isArray(artifactExports) && artifactExports.length)
    ? artifactExports
    : (FALLBACK_FORMATS[artifactKind] || FALLBACK_FORMATS.deck);
  return ids
    .filter(id => FORMAT_META[id])
    .map(id => {
      const m = FORMAT_META[id];
      return {
        id,
        icon: m.icon,
        label: (isSite && m.siteLabel) || m.label,
        desc: (isSite && m.siteDesc) || m.desc,
      };
    });
}

/**
 * ExportMenu — 顶栏导出下拉
 *
 * 三项 active（HTML / PDF / Handoff）调 GET /api/projects/:pid/exports/:format
 * 由父级 onExport 接走 Exports.download → blob → a.click()
 *
 * PPTX 标灰禁点，留 P0+。
 */
export default function ExportMenu({ open, onClose, onExport, anchorRef, onOpenList, onPick, artifactKind = null, artifactExports = null }) {
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
        background: '#fff',
        border: `1px solid ${COLOR.borderMd}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
        padding: 4,
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
              background: 'transparent', border: 0, borderRadius: 6, cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Share2 size={12} /> 分享链接…
          </button>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
        </>
      )}
      {itemsFor(artifactKind, artifactExports).map(item => {
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
              borderRadius: 4,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              opacity: item.disabled ? 0.45 : 1,
            }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={14} color={COLOR.text4} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>{item.label}</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>{item.desc}</div>
            </div>
          </button>
        );
      })}

      {/* 挑着导出：整包之外，用户经常只要"那三张图"/"就这份 deck"（2026-07-28）*/}
      {onPick && (
        <>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `4px ${GAP.sm}px` }} />
          <button
            onClick={() => { onPick(); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'flex-start', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent', border: 'none', borderRadius: 4,
              cursor: 'pointer', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <CheckSquare size={14} color={COLOR.text4} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>挑着导出…</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>当前任务的产物，勾哪个下哪个</div>
            </div>
          </button>
        </>
      )}

      {/* C31：分隔线 + 已生成的交付文件入口（agent export_handoff 写到 workspace/exports/）*/}
      {onOpenList && (
        <>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `4px ${GAP.sm}px` }} />
          <button
            onClick={() => { onOpenList(); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <FolderOpen size={14} color={COLOR.text4} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>agent 打过的包</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>agent 主动 export_handoff 后产出</div>
            </div>
          </button>
        </>
      )}
    </div>
  );
}
