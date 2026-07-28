import { useState, useRef, useEffect, useCallback } from 'react';
import CanvasToolbar from './CanvasToolbar.jsx';
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
import PostDragNotePanel from './PostDragNotePanel.jsx';
import PendingEditsBar from './PendingEditsBar.jsx';
import PendingMoveMarkers from './PendingMoveMarkers.jsx';
import { applyMoveToRuntime, applyStyleToRuntime } from '../../lib/pending-edit-apply.js';
import { usePanelManager } from '../layout/PanelManager.jsx';
import { SessionConfig } from '../../lib/api.js';

/**
 * DeckWindow — 画布内最大化的 deck 编辑窗口（2026-07-28 桌面化）
 *
 * 工作台是唯一顶层曲面：编辑一个 deck 不再是"切走整个中栏"，而是在桌面上
 * 开一扇最大化的窗——铺满视口绝大部分、桌面压暗在底、窗口头部自带
 * Edit/Drag/Preview/Code 标签和关闭钮，关掉落回画布的内嵌预览态。
 *
 * 原 CanvasFrame 的 deck 编辑内脏（iframe + bridge + overlay 全家）整体迁到
 * 这里；窗口铺开后编辑器拿到稳定的 1:1 坐标系（DirectEdit / 拖拽 overlay
 * 不用叠画布缩放）。
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
  project, deckSpec, projectId, sessionId, decisionsReloadKey,
  comments = [],
  onAddComment, onResolveComment, onDeleteComment,
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
    SessionConfig.read(projectId, sessionId).then(({ config }) => {
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
    SessionConfig.patch(projectId, sessionId, { tweaks_mode_enabled: next })
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
  }, [selectedAnchor, iframeDoc, onSelectChange, onClose]);

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

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 120 }}>
      <style>{'@keyframes ndDimIn{from{opacity:0}to{opacity:1}}'}</style>
      {/* 桌面压暗层：点击 = 关窗回桌面 */}
      <div
        onClick={onClose}
        title="点击回到工作台"
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(32, 26, 14, 0.4)',
          animation: 'ndDimIn 200ms ease',
        }}
      />
      {/* 最大化窗口 */}
      <div style={{
        position: 'absolute', inset: '16px 20px',
        background: '#fff', borderRadius: 14, overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(30,22,8,0.45)',
        display: 'flex', flexDirection: 'column',
        animation: 'ndPopIn 240ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}>
        {showCandidateBar && (
          <CanvasCandidateBar
            candidates={candidates}
            activeId={activeCandidateId}
            onSelect={onSelectCandidate}
            onAdd={onAddCandidate}
            onRemove={onRemoveCandidate}
            onRename={onRenameCandidate}
          />
        )}

        <CanvasToolbar
          mode={tab}
          onModeChange={(m) => { onTabChange?.(m); onSelectChange?.(null); }}
          onClose={onClose}
          dragFreeMode={dragFreeMode}
          onDragFreeModeChange={setDragFreeMode}
          isStreaming={isStreaming}
          zoom={effectiveZoom}
          isAutoFit={zoom === 'fit'}
          onZoomChange={(z) => setZoom(z)}
          onFitToggle={() => setZoom('fit')}
          onTweaksClick={handleToggleTweaks}
          tweaksAvailable={tweaksAvailable}
          tweaksOpen={tweaksOpen}
          tweaksEnabled={tweaksEnabled}
          onTweaksEnabledChange={handleTweaksEnabledChange}
          onCommentClick={() => {
            setA11yOpen(false);
            setSystemOpen(false);
            setCommentOverviewOpen(o => !o);
          }}
          commentOverviewOpen={commentOverviewOpen}
          commentBtnRef={commentBtnRef}
          commentCount={Array.isArray(comments) ? comments.filter(c => c.status !== 'resolved').length : 0}
          onReload={handleReload}
          onSystemClick={() => {
            setA11yOpen(false);
            setCommentOverviewOpen(false);
            setSystemOpen(o => !o);
          }}
          systemBtnRef={systemBtnRef}
          systemActive={systemOpen}
        />

        {(tab === 'edit' || tab === 'preview' || tab === 'drag') && (
          <div ref={iframeWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <HtmlIframe
              key={`${activeCandidateId || 'default'}-${reloadKey}-${dirty ? 'doc' : 'src'}`}
              src={dirty ? undefined : htmlSrc}
              srcDoc={dirty ? sourceText : (!htmlSrc ? htmlContent : undefined)}
              mode={tab === 'drag' ? 'preview' : tab}
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
            decisionsReloadKey={decisionsReloadKey}
            onA11yClick={() => { setSystemOpen(false); setA11yOpen(true); }}
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
      </div>
    </div>
  );
}
