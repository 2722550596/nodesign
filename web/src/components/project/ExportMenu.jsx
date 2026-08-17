import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Share2, Download } from 'lucide-react';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Assets } from '../../lib/api.js';
import { groupArtifacts } from '../../lib/export-groups.js';

/**
 * ExportMenu — 顶栏导出下拉
 *
 * 2026-08-17 改成**类型优先**：直接列项目里有哪几类产物（带数量），点一类进
 * ExportPicker 挑具体哪几个。
 *
 * 之前是跟着**当前聚焦的产物**给格式（聚焦 deck 就给 PDF/PPTX，聚焦站点就给
 * 整站打包）。那个设计把内部实现泄给了用户：想导几张图，得先去画布上点开某个
 * 任务 —— 而图根本不属于哪个任务。用户原话是「导出按钮应该直接提供产物类型
 * 按钮，点击后选择想要导出的产物」。
 *
 * 类型和数量从 `/artifacts` 现拉（菜单开的时候才拉），判据全在服务端，
 * 这里不自己数也不自己判。
 */
export default function ExportMenu({ open, onClose, projectId, onPickType, onOpenList, onShare, anchorRef }) {
  const ref = useRef(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true);
    Assets.artifacts(projectId)
      .then(p => { if (!cancelled) setGroups(groupArtifacts(p)); })
      .catch(() => { if (!cancelled) setGroups([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  if (!open) return null;

  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: GAP.sm, width: '100%',
    padding: `${GAP.sm}px ${GAP.md}px`,
    background: 'transparent', border: 0, borderRadius: RADIUS.sm, cursor: 'pointer',
    fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, textAlign: 'left',
  };
  const hover = {
    onMouseEnter: e => { e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; },
    onMouseLeave: e => { e.currentTarget.style.background = 'transparent'; },
  };
  const divider = <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />;

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', right: 0,
        minWidth: 240, background: COLOR.bgWhite, borderRadius: 2,
        boxShadow: SHADOW.pop, padding: GAP.xs, zIndex: 50,
      }}
    >
      {/* 分享排第一（2026-07-30）：对创作者，分享链接和导出文件是同一件事的两种出口 */}
      {onShare && (
        <>
          <button onClick={() => { onClose?.(); onShare(); }} style={rowStyle} {...hover}>
            <Share2 size={12} /> 分享链接…
          </button>
          {divider}
        </>
      )}

      {loading && (
        <div style={{ ...rowStyle, cursor: 'default', color: COLOR.sub }}>读取产物…</div>
      )}

      {!loading && !groups.length && (
        <div style={{ ...rowStyle, cursor: 'default', color: COLOR.sub }}>还没有可导出的产物</div>
      )}

      {!loading && groups.map(g => (
        <button
          key={g.type}
          onClick={() => { onClose?.(); onPickType?.(g.type); }}
          style={rowStyle}
          {...hover}
        >
          <Download size={13} color={COLOR.text4} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, fontFamily: FONT_MONO, fontWeight: 500, color: COLOR.text }}>{g.label}</span>
          {/* 数量写出来 —— 「图片 47」比光写「图片」有用得多，用户据此判断值不值得点 */}
          <span style={{ color: COLOR.sub, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs }}>{g.items.length}</span>
        </button>
      ))}

      {onOpenList && (
        <>
          {divider}
          <button onClick={() => { onOpenList(); onClose?.(); }} style={rowStyle} {...hover}>
            <FolderOpen size={12} /> 已生成的交付文件
          </button>
        </>
      )}
    </div>
  );
}
