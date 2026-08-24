import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Eye, Edit3, Move, Code2, Pin, Maximize2, Minus, Plus, SquareDashedMousePointer,
  Sliders, MessageSquare, RotateCcw, Settings,
} from 'lucide-react';
import ArtifactWindow, { exportToolGroup } from './ArtifactWindow.jsx';
import RegionSelect from './RegionSelect.jsx';
import HtmlIframe from './HtmlIframe.jsx';
import EditOverlay from './EditOverlay.jsx';
import CodeCanvas from './CodeCanvas.jsx';
import CanvasCandidateBar from './CanvasCandidateBar.jsx';
import A11yReviewPopover from './A11yReviewPopover.jsx';
import SystemPopover from './SystemPopover.jsx';
import InspectFloatingCard from './InspectFloatingCard.jsx';
import CommentOverview from './CommentOverview.jsx';
import CommentMarkers from './CommentMarkers.jsx';
import DragOverlay, { pickDragSource } from './DragOverlay.jsx';
import GrabHandle from './GrabHandle.jsx';
import PagePager from './PagePager.jsx';
import PostDragNotePanel from './PostDragNotePanel.jsx';
import PendingEditsBar from './PendingEditsBar.jsx';
import PendingMoveMarkers from './PendingMoveMarkers.jsx';
import { applyMoveToRuntime, applyStyleToRuntime } from '../../lib/pending-edit-apply.js';
import { usePanelManager } from '../layout/PanelManager.jsx';
import { SessionConfig } from '../../lib/api.js';

/**
 * DeckWindow — deck 的内容层（2026-07-28 桌面化；2026-08-07 外壳收归 ArtifactWindow）
 *
 * 工作台是唯一顶层曲面：编辑一个 deck 不再是"切走整个中栏"，而是在桌面上
 * 开一扇最大化的窗——铺满视口绝大部分、桌面压暗在底、关掉落回画布的内嵌预览态。
 *
 * 原 CanvasFrame 的 deck 编辑内脏（iframe + bridge + overlay 全家）整体迁到
 * 这里；窗口铺开后编辑器拿到稳定的 1:1 坐标系（DirectEdit / 拖拽 overlay
 * 不用叠画布缩放）。
 *
 * 2026-08-07：窗框和工具的容器都交给 ArtifactWindow（三种产物同一扇窗），
 * 这里只负责 deck 自己的内容与那套工具的定义。原来那条 44px 的 CanvasToolbar
 * 整条退役 —— 它的按钮变成浮动工具栏的三组，Tweaks 的启用开关挪进 System
 * （它是会话设置不是工具）。
 */
const ASPECT_DIMS = {
  '16:9':  { w: 1920, h: 1080 },
  '16:10': { w: 1920, h: 1200 },
  '9:16':  { w: 1080, h: 1920 },
  '4:3':   { w: 1440, h: 1080 },
};
const DEFAULT_ASPECT = '16:9';

function extractAspect(html) {
  if (!html || typeof html !== 'string') return DEFAULT_ASPECT;
  const m = html.match(/<div\b[^>]*class\s*=\s*['"][^'"]*__nd-deck-wrap[^'"]*['"][^>]*data-deck-aspect\s*=\s*['"]([^'"]+)['"]/i)
        || html.match(/<div\b[^>]*data-deck-aspect\s*=\s*['"]([^'"]+)['"][^>]*class\s*=\s*['"][^'"]*__nd-deck-wrap[^'"]*['"]/i);
  return (m && ASPECT_DIMS[m[1]]) ? m[1] : DEFAULT_ASPECT;
}

export default function DeckWindow({
  tab, onTabChange, onClose,
  /** 服务端给的可导出格式 + 导出动作（2026-08-13 从顶栏搬进工具栏） */
  artifactExports = null, onExport = null,
  /** 工具组交给外层那条常驻工具栏（窗自己不渲工具栏了） */
  onToolbarGroups = null,
  title = '幻灯',
  htmlSrc, htmlContent,
  selectedAnchor, onSelectChange,
  onTextEdit,
  onIframeReady,
  candidates,
  activeCandidateId,
  onSelectCandidate,
  onAddCandidate,
  onRemoveCandidate,
  onRenameCandidate,
  project, deckSpec, projectId, sessionId,
  comments = [],
  onAddComment, onResolveComment, onDeleteComment,
  onRegionComment = null,   // 圈选评论（要会话才有）
  tweaksAvailable = false,
  pendingEdits = [],
  onCommitMove,
  onCommitFreePosition,
  onSubmitDragNote,
  lastPendingEditId = null,
  onApplyPendingEdits,
  onUndoPending,
  onClearAllPending,
  canUndoPending = false,
  isStreaming = false,
}) {
  const { panels, setPanelVisible } = usePanelManager();
  const tweaksOpen = !!panels?.tweaks?.visible;
  const handleToggleTweaks = () => setPanelVisible('tweaks', !tweaksOpen);

  const [dragFreeMode, setDragFreeMode] = useState(false);
  // P3 #4 协作 lock：agent run 期间强制退出 drag，避免 agent 改源码和用户改 DOM 并行
  useEffect(() => {
    if (isStreaming && tab === 'drag') onTabChange?.('edit');
  }, [isStreaming, tab, onTabChange]);

  const dragApiRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedSource, setDraggedSource] = useState(null);
  const [notePanelOpen, setNotePanelOpen] = useState(false);
  const [zoom, setZoom] = useState('fit');     // 'fit' | number（窗口内 deck 缩放）
  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceText, setSourceText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [iframeDoc, setIframeDoc] = useState(null);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [commentOverviewOpen, setCommentOverviewOpen] = useState(false);
  const [tweaksEnabled, setTweaksEnabled] = useState(true);
  const iframeWrapRef = useRef(null);
  const systemBtnRef = useRef(null);
  const commentBtnRef = useRef(null);

  // 拉 session config 初始 tweaksEnabled
  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;
    SessionConfig.read(projectId).then(({ config }) => {
      if (cancelled) return;
      if (config && typeof config.tweaks_mode_enabled === 'boolean') {
        setTweaksEnabled(config.tweaks_mode_enabled);
      }
    }).catch(() => { /* ignore；用默认值 true */ });
    return () => { cancelled = true; };
  }, [projectId, sessionId]);

  const handleTweaksEnabledChange = useCallback((next) => {
    setTweaksEnabled(next);
    if (!projectId || !sessionId) return;
    SessionConfig.patch(projectId, { tweaks_mode_enabled: next })
      .catch(() => { /* ignore；下次 turn 重新读取 */ });
  }, [projectId, sessionId]);

  // 测 iframe wrap 尺寸（fit 取 min 让单页完整可见 letterbox）
  useEffect(() => {
    const el = iframeWrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setWrapSize(prev => (prev.width === r.width && prev.height === r.height) ? prev : { width: r.width, height: r.height });
    };
    measure();
    let ro = null;
    try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* fallback to window */ }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [tab]);

  const aspect = extractAspect(sourceText);
  const deckDim = ASPECT_DIMS[aspect] || ASPECT_DIMS[DEFAULT_ASPECT];
  const effectiveZoom = zoom === 'fit'
    ? (wrapSize.width > 0 && wrapSize.height > 0
        ? Math.min(wrapSize.width / deckDim.w, wrapSize.height / deckDim.h)
        : 1)
    : zoom;

  const showCandidateBar = candidates && candidates.length >= 1;

  // candidate 切换重置 dirty
  useEffect(() => {
    setDirty(false);
    setIframeDoc(null);
  }, [activeCandidateId]);

  // ESC：有选中先清选中（DirectEdit revert 优先级更高）；没选中 = 关窗口回桌面
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t?.getAttribute?.('contenteditable') === 'true') return;
      // 浮层开着时 ESC 归浮层（它们自己会关）—— 不然一下 ESC 把浮层和窗一起关了
      if (systemOpen || a11yOpen || commentOverviewOpen) return;
      if (selectedAnchor) onSelectChange?.(null);
      else onClose?.();
    };
    window.addEventListener('keydown', handler);
    let iframeDocRef = null;
    try {
      iframeDocRef = iframeDoc;
      iframeDocRef?.addEventListener('keydown', handler);
    } catch { /* cross-origin: skip */ }
    return () => {
      window.removeEventListener('keydown', handler);
      try { iframeDocRef?.removeEventListener('keydown', handler); } catch { /* */ }
    };
  }, [selectedAnchor, iframeDoc, onSelectChange, onClose, systemOpen, a11yOpen, commentOverviewOpen]);

  // iframe 主动 postMessage 同步当前页（翻页信号 hook 点）
  useEffect(() => {
    const onMsg = (ev) => {
      const data = ev?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'canvas-page-change' && Number.isFinite(data.page)) {
        try {
          window.dispatchEvent(new CustomEvent('nd-canvas-page-change', {
            detail: { page: data.page },
          }));
        } catch { /* ignore */ }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 加载源码（Code tab 显示 + dirty 后切 srcDoc）
  useEffect(() => {
    if (!htmlSrc) {
      setSourceText(htmlContent || '');
      setDirty(false);
      return;
    }
    fetch(htmlSrc).then(r => r.text()).then((text) => {
      setSourceText(text);
      setDirty(false);
    }).catch(() => setSourceText('<!-- 无法加载源码 -->'));
  }, [htmlSrc, htmlContent, reloadKey]);

  const handleSelect = (info) => {
    onSelectChange?.(info?.anchor || null);
  };

  const handleTextEdit = (info) => {
    onTextEdit?.(info);
    console.log('[direct edit]', info);
  };

  const handleSourceChange = useCallback((newText) => {
    setSourceText(newText);
    setDirty(true);
  }, []);

  const handleIframeReady = useCallback((iframe) => {
    try {
      setIframeDoc(iframe.contentDocument);
    } catch { /* cross-origin */ }
    onIframeReady?.(iframe);
  }, [onIframeReady]);

  const handleReload = () => {
    setReloadKey(k => k + 1);
    onSelectChange?.(null);
  };

  const openComments = () => {
    setA11yOpen(false);
    setSystemOpen(false);
    setCommentOverviewOpen(o => !o);
  };
  const openSystem = () => {
    setA11yOpen(false);
    setCommentOverviewOpen(false);
    setSystemOpen(o => !o);
  };

  const openCommentCount = Array.isArray(comments)
    ? comments.filter(c => c.status !== 'resolved').length
    : 0;

  const groups = useMemo(() => [
    exportToolGroup({ kind: 'deck', exports: artifactExports, onExport }),
    {
      id: 'mode',
      type: 'mode',
      value: tab,
      onChange: (m) => { onTabChange?.(m); onSelectChange?.(null); },
      items: [
        { id: 'preview', icon: Eye, label: '预览', title: '看成品（左右键翻页）' },
        { id: 'edit', icon: Edit3, label: '编辑', title: '双击文字直接改 · 单击元素弹评论卡' },
        {
          id: 'drag', icon: Move, label: '拖拽',
          disabled: isStreaming,
          title: isStreaming ? 'agent 正在跑，拖拽暂停以免和它抢同一份源码' : '拖动元素调布局',
        },
        {
          id: 'region', icon: SquareDashedMousePointer, label: '圈选',
          disabled: !onRegionComment,
          title: onRegionComment
            ? '框一块地方说事 —— 框住谁、当时长什么样、你想说什么，一起交给 agent'
            : '要先开一个会话才能把圈选交给 agent',
        },
        { id: 'code', icon: Code2, label: '源码', title: '看/改这一份 HTML' },
      ],
    },
    tab === 'drag' && {
      id: 'dragmode',
      items: [{
        id: 'free', icon: Pin, label: dragFreeMode ? '自由' : '嵌入',
        active: dragFreeMode,
        title: dragFreeMode
          ? '自由摆放 · 松手落到像素位置（P 切回嵌入）'
          : '嵌入 · 松手按 DOM 树插进容器（P 切自由摆放）',
        onClick: () => setDragFreeMode(v => !v),
      }],
    },
    tab !== 'code' && {
      id: 'zoom',
      items: [
        { id: 'zoomOut', icon: Minus, title: '缩小', onClick: () => setZoom(Math.max(0.25, effectiveZoom - 0.1)) },
        {
          id: 'zoomLevel', label: `${Math.round(effectiveZoom * 100)}%`,
          active: zoom === 'fit',
          title: zoom === 'fit' ? '当前自适应窗口' : '点一下自适应窗口',
          onClick: () => setZoom('fit'),
        },
        { id: 'zoomIn', icon: Plus, title: '放大', onClick: () => setZoom(Math.min(3, effectiveZoom + 0.1)) },
        { id: 'fit', icon: Maximize2, title: '自适应窗口', onClick: () => setZoom('fit') },
      ],
    },
    {
      id: 'actions',
      items: [
        {
          id: 'tweaks', icon: Sliders,
          active: tweaksOpen,
          disabled: !tweaksEnabled,
          title: !tweaksEnabled
            ? 'Tweaks 模式已关（在 System 里开）'
            : tweaksAvailable ? 'Tweaks：拖控件实时改样式' : 'Tweaks（agent 还没暴露参数 — 跟它说一句让它 expose_tweaks）',
          onClick: handleToggleTweaks,
        },
        {
          id: 'comment', icon: MessageSquare,
          label: openCommentCount > 0 ? String(openCommentCount) : undefined,
          active: commentOverviewOpen,
          btnRef: commentBtnRef,
          title: '这一份上已有的评论',
          onClick: openComments,
        },
        { id: 'reload', icon: RotateCcw, title: '重载（agent 改完没刷新时用）', onClick: handleReload },
        {
          id: 'system', icon: Settings,
          active: systemOpen,
          btnRef: systemBtnRef,
          title: 'System：项目档案 / Tweaks 模式 / A11y',
          onClick: openSystem,
        },
      ],
    },
  ].filter(Boolean),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [tab, isStreaming, dragFreeMode, zoom, effectiveZoom, tweaksOpen, tweaksEnabled,
    tweaksAvailable, commentOverviewOpen, systemOpen, openCommentCount, onRegionComment,
    artifactExports, onExport]);

  return (
    <ArtifactWindow
      kind="deck"
      title={title}
      subtitle={aspect}
      onClose={onClose}
      escToClose={false}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      headerExtra={showCandidateBar ? (
        <CanvasCandidateBar
          candidates={candidates}
          activeId={activeCandidateId}
          onSelect={onSelectCandidate}
          onAdd={onAddCandidate}
          onRemove={onRemoveCandidate}
          onRename={onRenameCandidate}
        />
      ) : null}
    >
        {(tab === 'edit' || tab === 'preview' || tab === 'drag' || tab === 'region') && (
          <div ref={iframeWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <HtmlIframe
              key={`${activeCandidateId || 'default'}-${reloadKey}-${dirty ? 'doc' : 'src'}`}
              src={dirty ? undefined : htmlSrc}
              srcDoc={dirty ? sourceText : (!htmlSrc ? htmlContent : undefined)}
              mode={(tab === 'drag' || tab === 'region') ? 'preview' : tab}
              onSelect={handleSelect}
              onTextEdit={handleTextEdit}
              onIframeReady={handleIframeReady}
              zoom={effectiveZoom}
              deckW={deckDim.w}
              deckH={deckDim.h}
            />
            {tab === 'edit' && selectedAnchor && (
              <EditOverlay
                selectedAnchor={selectedAnchor}
                iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
                zoom={effectiveZoom}
              />
            )}
            <CommentMarkers
              comments={comments}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
              onSelectAnchor={(anchor) => {
                if (tab !== 'edit') onTabChange?.('edit');
                onSelectChange?.(anchor);
              }}
            />
            <PendingMoveMarkers
              edits={pendingEdits}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
            />
            {/* 预览态左右翻页（2026-07-28）：看成品就该像看幻灯片一样翻 */}
            <PagePager iframeDoc={iframeDoc} active={tab === 'preview'} />
            <GrabHandle
              active={tab === 'drag' && !isDragging}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
              pickDragSource={pickDragSource}
              isDragging={isDragging}
            />
            <DragOverlay
              active={tab === 'drag'}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
              freeMode={dragFreeMode}
              onFreeModeChange={setDragFreeMode}
              apiRef={dragApiRef}
              onDraggingChange={setIsDragging}
              onSelectionChange={(src) => {
                setDraggedSource(src);
                if (src) setNotePanelOpen(true);
              }}
              onCommitMove={(payload, refs) => {
                if (refs.duplicate) {
                  const clone = refs.sourceEl?.cloneNode(true);
                  let revertClone = () => {};
                  if (clone && refs.targetContainer) {
                    try { clone.removeAttribute('data-anchor'); } catch { /* */ }
                    if (refs.beforeEl && refs.beforeEl.parentNode === refs.targetContainer) {
                      refs.targetContainer.insertBefore(clone, refs.beforeEl);
                    } else {
                      refs.targetContainer.appendChild(clone);
                    }
                    revertClone = () => { try { clone.remove(); } catch { /* */ } };
                  }
                  onCommitMove?.(payload, revertClone);
                  return;
                }
                const result = applyMoveToRuntime({
                  iframeDoc,
                  sourceEl: refs.sourceEl,
                  targetContainer: refs.targetContainer,
                  beforeEl: refs.beforeEl,
                });
                onCommitMove?.(payload, result?.revert);
              }}
              onCommitFreePosition={(payload, refs) => {
                const result = applyStyleToRuntime({
                  sourceEl: refs.sourceEl,
                  parentEl: refs.parentEl,
                  styleDelta: payload.styleDelta,
                  runtimeLocks: payload.runtimeLocks,
                  parentNeedsRelative: payload.parentNeedsRelative,
                });
                onCommitFreePosition?.(payload, result?.revert);
              }}
            />
            <PostDragNotePanel
              active={tab === 'drag' && notePanelOpen && !isDragging && !!draggedSource}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
              sourceEl={draggedSource}
              hasPendingEditId={!!lastPendingEditId}
              onSubmit={onSubmitDragNote}
              onDismiss={() => setNotePanelOpen(false)}
            />
            {tab === 'edit' && selectedAnchor && iframeDoc && (
              <InspectFloatingCard
                selectedAnchor={selectedAnchor}
                iframeDoc={iframeDoc}
                iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
                iframeRect={wrapSize}
                zoom={effectiveZoom}
                comments={comments}
                onClose={() => onSelectChange?.(null)}
                onAddComment={onAddComment}
                onResolveComment={onResolveComment}
                onDeleteComment={onDeleteComment}
              />
            )}
            <RegionSelect
              active={tab === 'region' && !!onRegionComment}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
              onSubmit={(payload) => onRegionComment?.(payload)}
              onExit={() => onTabChange?.('preview')}
            />
            <PendingEditsBar
              edits={pendingEdits}
              onApply={onApplyPendingEdits}
              onUndo={onUndoPending}
              onClearAll={onClearAllPending}
              canUndo={canUndoPending}
              isRunning={isStreaming}
            />
          </div>
        )}

        {tab === 'code' && (
          <CodeCanvas value={sourceText} onChange={handleSourceChange} readOnly={false} />
        )}

        {a11yOpen && (
          <A11yReviewPopover
            anchorRef={systemBtnRef}
            onClose={() => setA11yOpen(false)}
            iframeDoc={iframeDoc}
          />
        )}

        {systemOpen && (
          <SystemPopover
            anchorRef={systemBtnRef}
            onClose={() => setSystemOpen(false)}
            project={project}
            deckSpec={deckSpec}
            projectId={projectId}
            sessionId={sessionId}
            onA11yClick={() => { setSystemOpen(false); setA11yOpen(true); }}
            tweaksEnabled={tweaksEnabled}
            onTweaksEnabledChange={handleTweaksEnabledChange}
          />
        )}

        {commentOverviewOpen && (
          <CommentOverview
            comments={comments}
            iframeDoc={iframeDoc}
            iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
            anchorRef={commentBtnRef}
            onClose={() => setCommentOverviewOpen(false)}
            onResolveComment={onResolveComment}
            onDeleteComment={onDeleteComment}
            onSelectAnchor={(anchor) => {
              setCommentOverviewOpen(false);
              if (tab !== 'edit') onTabChange?.('edit');
              onSelectChange?.(anchor);
            }}
          />
        )}
    </ArtifactWindow>
  );
}
