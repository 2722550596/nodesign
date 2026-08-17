import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Scan, FileJson, Eye, Loader2 } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import ArtifactWindow, { exportToolGroup } from './ArtifactWindow.jsx';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * DocxWindow —— word 文档的产物窗（2026-08-17，跟 DeckWindow / SiteWindow 并列的第三种）
 *
 * ## 它跟前两扇窗的根本区别
 *
 * deck 和站点都是 **iframe 里跑一个活页面** —— 所以它们能有 DOM 级的能力：
 * 点选元素评论、拖着改位置、读计算样式。docx 没有 DOM，它是**一张一张页图**
 * （服务端 LibreOffice 渲的）。
 *
 * 这条差别决定了复用的边界，不是懒得接：
 *   ✅ 能复用 —— 外壳（ArtifactWindow）、导出工具组、圈选说事（框一块 + 截那块
 *      图 + 一句话，三件里没有一件依赖 DOM）、看源码
 *   ❌ 复用不了 —— 点选元素评论、直接拖拽编辑、取计算样式（都要 findElementByAnchor）
 *
 * 对文档来说这个取舍其实是顺的：人批注纸质文档本来就是**圈一块**说事，
 * 不是点某个字。
 *
 * ## 翻页为什么不预取
 *
 * 服务端一次渲整份、按源 mtime 缓存，翻页命中缓存只要 1ms —— 贵的是第一次
 * 那两秒。所以这里老老实实一页一请求，不做预取窗口。
 */

/** 顶栏之外的内边距，页图四周留白 */
const PAD = 24;

export default function DocxWindow({
  projectId,
  /** 工作区相对路径，例如 '文档.docx' */
  file,
  title,
  /** token 源文件名（有就说明是我们造的，可以看源码 / 改源重建） */
  sourceFile = null,
  /** 服务端形态注册表给的可导出格式 */
  exports: artifactExports,
  onExport,
  onClose,
  onToolbarGroups,
  /** 文件版本号，用来穿透浏览器缓存 */
  version,
}) {
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fit, setFit] = useState('height');     // 'height' 铺满高度 | 'width' 铺满宽度
  const [tab, setTab] = useState('preview');    // 'preview' | 'source'
  const [source, setSource] = useState(null);
  const boxRef = useRef(null);

  const src = useMemo(
    () => Assets.docxPageUrl(projectId, file, page, { v: version }),
    [projectId, file, page, version],
  );

  // 换文档（不是换页）时回到第一页 —— 停在第 7 页看另一份文档是没道理的
  useEffect(() => { setPage(1); setCount(null); }, [file]);

  // 页数从响应头拿（服务端顺带给了，省一次请求）。用 fetch 而不是等 <img>
  // onLoad —— <img> 拿不到响应头。
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError(null);
    fetch(src)
      .then(async (r) => {
        if (dead) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `渲染失败（${r.status}）`);
        }
        const n = Number(r.headers.get('X-Docx-Pages'));
        if (n > 0) setCount(n);
      })
      .catch((e) => { if (!dead) setError(e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [src]);

  // 看源码：token JSON 就是这份文档的真相源
  useEffect(() => {
    if (tab !== 'source' || !sourceFile || source != null) return;
    fetch(Assets.artifactFileUrl(projectId, sourceFile))
      .then(r => r.text())
      .then(setSource)
      .catch(() => setSource('（读不到源文件）'));
  }, [tab, sourceFile, projectId, source]);

  const go = useCallback((delta) => {
    setPage(p => Math.min(Math.max(1, p + delta), count || p + delta));
  }, [count]);

  // 键盘翻页。ESC 归外壳管（这扇窗没有"先清选中"那种优先级）
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const groups = useMemo(() => [
    // ⭐word 特制控件：翻页。deck 的"页"是 section、站点的"页"是文件，
    // 只有文档的页是**排版算出来的** —— 改一个字号页数就变，所以页码不能存，
    // 只能每次问渲染管线。
    {
      id: 'pages',
      items: [
        { id: 'prev', icon: ChevronLeft, title: '上一页（← / PageUp）', disabled: page <= 1, onClick: () => go(-1) },
        { id: 'no', label: count ? `${page} / ${count}` : `${page}`, static: true },
        { id: 'next', icon: ChevronRight, title: '下一页（→ / PageDown）', disabled: !!count && page >= count, onClick: () => go(1) },
      ],
    },
    {
      id: 'fit',
      items: [
        { id: 'fitH', icon: Maximize2, title: '整页（铺满高度）', active: fit === 'height', onClick: () => setFit('height') },
        { id: 'fitW', icon: Scan, title: '铺满宽度（看细节）', active: fit === 'width', onClick: () => setFit('width') },
      ],
    },
    ...(sourceFile ? [{
      id: 'tab',
      items: [
        { id: 'preview', icon: Eye, title: '看页面', active: tab === 'preview', onClick: () => setTab('preview') },
        { id: 'source', icon: FileJson, title: `看源码（${sourceFile}）—— 改这份再 build，别改 .docx`, active: tab === 'source', onClick: () => setTab('source') },
      ],
    }] : []),
    exportToolGroup({ kind: 'docx', exports: artifactExports, onExport }),
  ].filter(Boolean), [page, count, fit, tab, sourceFile, artifactExports, onExport, go]);

  const imgStyle = fit === 'height'
    ? { height: '100%', width: 'auto', maxWidth: '100%' }
    : { width: '100%', height: 'auto' };

  return (
    <ArtifactWindow
      kind="docx"
      title={title || file}
      subtitle={count ? `${count} 页` : null}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      banner={sourceFile ? null : (
        <span>
          这是一份**外来文档**（没有 token 源）。现在能看、能导出，
          <b>改它要等编辑道上线</b> —— 想现在就要改动版本，让 agent 基于它的内容重做一份。
        </span>
      )}
      contentStyle={{ background: COLOR.bg2 || '#efece5' }}
    >
      {tab === 'source' ? (
        <pre style={{
          margin: 0, padding: GAP.lg, height: '100%', overflow: 'auto',
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, lineHeight: 1.6,
          color: COLOR.text, background: COLOR.bgWhite, whiteSpace: 'pre-wrap',
        }}>
          {source ?? '读取中…'}
        </pre>
      ) : (
        <div
          ref={boxRef}
          style={{
            height: '100%', width: '100%', overflow: 'auto',
            display: 'flex', alignItems: fit === 'height' ? 'center' : 'flex-start',
            justifyContent: 'center', padding: PAD, boxSizing: 'border-box',
          }}
        >
          {error ? (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
              textAlign: 'center', maxWidth: 420, lineHeight: 1.7,
            }}>
              {error}
              <div style={{ marginTop: GAP.sm, color: COLOR.sub, fontSize: FONT_SIZE.xs }}>
                渲染链路的问题跟文档本身无关。文档还在，导出照常能用。
              </div>
            </div>
          ) : (
            <div style={{ position: 'relative', height: fit === 'height' ? '100%' : 'auto', maxWidth: '100%' }}>
              <img
                alt={`${title || file} 第 ${page} 页`}
                src={src}
                onLoad={() => setLoading(false)}
                style={{ ...imgStyle, display: 'block', background: '#fff', boxShadow: PAPER_SHADOW, borderRadius: 2 }}
              />
              {loading && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.65)', gap: GAP.sm,
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, borderRadius: 2,
                }}>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  首次打开要渲染，两秒左右
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </ArtifactWindow>
  );
}
