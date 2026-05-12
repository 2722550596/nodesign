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
import ConstraintPanel from './ConstraintPanel.jsx';
import PendingEditsBar from './PendingEditsBar.jsx';
import PendingMoveMarkers from './PendingMoveMarkers.jsx';
import { applyMoveToRuntime, applyStyleToRuntime } from '../../lib/pending-edit-apply.js';
import { buildPendingStyleConstraint } from '../../lib/drag-intent.js';
import { usePanelManager } from '../layout/PanelManager.jsx';
import { SessionConfig } from '../../lib/api.js';
import { COLOR, STAGE } from '../../lib/theme.js';

/**
 * CanvasFrame — Canvas 中栏总壳
 *
 * 三模式：
 *   - edit    iframe + bridge + overlay（双击 contenteditable + 选中框）
 *   - preview iframe 纯展示（无 bridge）
 *   - code    Monaco（可编辑，blur/debounce 同步回 srcDoc → iframe reload）
 *
 * 多候选：候选 tab 条 + + 新候选 + 删候选（同 htmlSrc，agent 真生成时各 candidate 独立）
 *
 * Slide navigator：扫描 section[data-page]，水平 tab 条 + 当前页高亮
 *
 * A11y：toolbar ✓ A11y 按钮 → popover 显示 mock review 结果
 */
// deck 尺寸跟随 canvas.html 里 wrap data-deck-aspect 决定（4 档预设）：
//   "16:9"   1920×1080（默认）
//   "16:10"  1920×1200（宽屏笔电 / Mac）
//   "9:16"   1080×1920（竖屏）
//   "4:3"    1440×1080（老投影）
// fit = min(wrap.w/W, wrap.h/H) contain letterbox，保证整页可见不裁。
// iframe logical viewport 固定 deck 比例尺寸，frame (100vw×100vh) 正好 =
// 设计稿尺寸 → scroll-snap 一次切一整页，跟 standalone 行为一致。
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

export default function CanvasFrame({
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
  // C2: System popover 数据透传
  project, deckSpec, projectId, sessionId, decisionsReloadKey,
  // C3: Inspect contextual + Comments 嵌入
  comments = [],
  onAddComment, onResolveComment, onDeleteComment,
  // onDirectEdit / onTriggerRun 已不在 InspectFloatingCard 使用（DirectEdit UI 砍 — 2026-05-07）
  // 父组件仍可能传入，destructure 忽略即可（未来 Tweaks v2 接管后再取用）
  // Tweaks 浮窗 toggle 按钮：仅 agent expose 过 controls 才显示
  tweaksAvailable = false,
  // 2026-05-12 起：画布拖移工具（drag mode）
  pendingEdits = [],
  onCommitMove,           // (payload) => void —— 嵌入模式 (DOM 树 move)
  onCommitFreePosition,   // (payload) => void —— 自由模式 (position: absolute)
  onApplyPendingEdits,    // () => void —— 触发 agent run
  onUndoPending,          // () => void
  onClearAllPending,      // () => void
  canUndoPending = false,
  isStreaming = false,
}) {
  // 直接 hook PanelManager 拿 tweaks 浮窗当前 visible 状态 + setter（用于 toggle）
  const { panels, setPanelVisible } = usePanelManager();
  const tweaksOpen = !!panels?.tweaks?.visible;
  const handleToggleTweaks = () => setPanelVisible('tweaks', !tweaksOpen);
  const [mode, setMode] = useState('edit');
  // Drag 模式下的"自由模式 / 嵌入模式" toggle —— 自由模式 = absolute 落点；嵌入 = DOM 树 move
  const [dragFreeMode, setDragFreeMode] = useState(false);

  // P3 #4 协作 lock：agent run 期间强制退出 drag 模式 + 锁 Apply 按钮，避免 agent 改源码
  // 和用户改 DOM 同时进行（虽然 race 不会真损坏数据，但视觉上会闪烁/错位）
  useEffect(() => {
    if (isStreaming && mode === 'drag') {
      setMode('edit');
    }
  }, [isStreaming, mode]);
  // P2 D: GrabHandle 触发 drag → DragOverlay.startDrag(sourceEl, parentX, parentY)
  // dragApiRef.current = { startDrag, pickDragSource }，由 DragOverlay 在 mount 时填充
  const dragApiRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  // P2 Constraints: 拖完保留 selection 给 ConstraintPanel + 键盘 nudge
  const [draggedSource, setDraggedSource] = useState(null);
  const [activeConstraint, setActiveConstraint] = useState({ x: 'left', y: 'top' });
  const [zoom, setZoom] = useState('fit');     // 'fit' | number
  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceText, setSourceText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [iframeDoc, setIframeDoc] = useState(null);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [commentOverviewOpen, setCommentOverviewOpen] = useState(false);
  // tweaks 启用/禁用 — 从 session-config.json 拉初始值
  const [tweaksEnabled, setTweaksEnabled] = useState(true);
  const iframeWrapRef = useRef(null);
  // a11yBtnRef 已废 — A11y 按钮砍 toolbar 移到 SystemPopover；
  // A11yReviewPopover 改 anchor 到 systemBtnRef（同 toolbar 位置）
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

  // 测 iframe wrap 尺寸（W + H）— fit 取 min 让单页完整可见 letterbox
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
  }, [mode]);

  // 从源码抽 deck 比例（默认 16:9）；sourceText 在下面 useEffect 里 fetch
  const aspect = extractAspect(sourceText);
  const deckDim = ASPECT_DIMS[aspect] || ASPECT_DIMS[DEFAULT_ASPECT];

  // fit = contain min(wrap.w / W, wrap.h / H)：单页完整可见 + letterbox。
  // iframe logical viewport 固定 deck 比例 (W×H)，内部 fit script 包 frame
  // (100vw×100vh = W×H = section 设计稿尺寸) → scroll-snap 切页。
  const effectiveZoom = zoom === 'fit'
    ? (wrapSize.width > 0 && wrapSize.height > 0
        ? Math.min(wrapSize.width / deckDim.w, wrapSize.height / deckDim.h)
        : 1)
    : zoom;

  const showCandidateBar = candidates && candidates.length >= 1;

  // 当 candidate 切换时，重置 dirty
  useEffect(() => {
    setDirty(false);
    setIframeDoc(null);
  }, [activeCandidateId]);

  // C3：ESC 关 InspectFloatingCard / 清选中
  // 同时挂 window + iframe.contentDocument keydown（iframe 内焦点不冒泡到 parent）
  // 避开 contenteditable 编辑态（DirectEditBridge 的 ESC = revert 文本，优先级更高）
  useEffect(() => {
    if (!selectedAnchor) return;
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t?.getAttribute?.('contenteditable') === 'true') return;
      onSelectChange?.(null);
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
  }, [selectedAnchor, iframeDoc, onSelectChange]);

  // Phase D3：iframe 主动 postMessage 同步当前页（canvas.template.html 内的
  // keyboard nav script 在用户按 ←→ / Space / PgUp/PgDn 切页时 emit）。
  // SlideNavigator 已经有自己的 IntersectionObserver 跟踪滚动，这里订阅
  // postMessage 是补充信号 + 给未来 features（pulse 高亮 / agent 通知 /
  // analytics）一个稳定 hook 点。
  useEffect(() => {
    const onMsg = (ev) => {
      const data = ev?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'canvas-page-change' && Number.isFinite(data.page)) {
        // 暂时只 dispatch 个 CustomEvent，让任何关心当前页的组件按需订阅
        // 不直接 setState 避免 CanvasFrame 因翻页 re-render（影响 iframe 滚动）
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

  // 加载源码（用于 Code mode 显示 + dirty 后切 srcDoc）
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
    setReloadKey(k => k + 1);  // 重新 fetch 源码
    onSelectChange?.(null);    // 清掉选中
  };

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: '#fff',
      overflow: 'hidden',
    }}>
      {/* 多候选切换条（≥1 个候选时显示）*/}
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
        mode={mode}
        onModeChange={(m) => { setMode(m); onSelectChange?.(null); }}
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

      {/* SlideNavigator 已删（2026-05-07）— 用户翻页用滚动 / 键盘 ←→ */}

      {(mode === 'edit' || mode === 'preview' || mode === 'drag') && (
        <div ref={iframeWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          <HtmlIframe
            key={`${activeCandidateId || 'default'}-${reloadKey}-${dirty ? 'doc' : 'src'}`}
            src={dirty ? undefined : htmlSrc}
            srcDoc={dirty ? sourceText : (!htmlSrc ? htmlContent : undefined)}
            // drag 模式下 iframe 内不挂 contenteditable / click 选中，DragOverlay 自己接管
            mode={mode === 'drag' ? 'preview' : mode}
            onSelect={handleSelect}
            onTextEdit={handleTextEdit}
            onIframeReady={handleIframeReady}
            zoom={effectiveZoom}
            deckW={deckDim.w}
            deckH={deckDim.h}
          />
          {mode === 'edit' && selectedAnchor && (
            <EditOverlay
              selectedAnchor={selectedAnchor}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
            />
          )}
          {/* 已评论元素橙色 overlay 标记 — edit/preview 都显示，让用户随时看到反馈点 */}
          <CommentMarkers
            comments={comments}
            iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
            zoom={effectiveZoom}
            onSelectAnchor={(anchor) => {
              if (mode !== 'edit') setMode('edit');
              onSelectChange?.(anchor);
            }}
          />
          {/* React 区 pending-move/duplicate 紫色 marker（纯 HTML 区已真搬 DOM，不需要 marker）*/}
          <PendingMoveMarkers
            edits={pendingEdits}
            iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
            zoom={effectiveZoom}
          />
          {/* Drag 模式核心 overlay — 仅 mode === 'drag' 时挂事件 */}
          {/* GrabHandle —— 只显示 hover preview 框 + tag label，提示"按这个就能拖"。
              真正的 drag-start 由 DragOverlay 接 iframe doc mousedown 触发（mousedown 用
              pickDragSource 自动找 block-level 祖先，避免选错 inline 子节点）*/}
          <GrabHandle
            active={mode === 'drag' && !isDragging}
            iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
            zoom={effectiveZoom}
            pickDragSource={pickDragSource}
            isDragging={isDragging}
          />
          <DragOverlay
            active={mode === 'drag'}
            iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
            zoom={effectiveZoom}
            freeMode={dragFreeMode}
            onFreeModeChange={setDragFreeMode}
            apiRef={dragApiRef}
            onDraggingChange={setIsDragging}
            onSelectionChange={setDraggedSource}
            onCommitMove={(payload, refs) => {
              if (refs.duplicate) {
                // Alt-drag 复制：clone source 后 insert 到 target；原 source 不动
                const clone = refs.sourceEl?.cloneNode(true);
                let revertClone = () => {};
                if (clone && refs.targetContainer) {
                  // 清掉 clone 上跟 anchor 系统冲突的 data-anchor（保持唯一）
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
                parentNeedsRelative: payload.parentNeedsRelative,
              });
              onCommitFreePosition?.(payload, result?.revert);
            }}
          />
          {/* P2 Constraints: 自由模式下选中元素后浮窗显示 anchor grid */}
          <ConstraintPanel
            active={mode === 'drag' && dragFreeMode && !isDragging && !!draggedSource}
            iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
            zoom={effectiveZoom}
            sourceEl={draggedSource}
            currentConstraint={activeConstraint}
            onChange={(c) => {
              setActiveConstraint(c);
              if (!draggedSource) return;
              const parent = draggedSource.parentElement;
              const payload = buildPendingStyleConstraint({
                sourceEl: draggedSource,
                parentEl: parent,
                constraint: c,
              });
              if (!payload) return;
              const result = applyStyleToRuntime({
                sourceEl: draggedSource,
                parentEl: parent,
                styleDelta: payload.styleDelta,
                parentNeedsRelative: payload.parentNeedsRelative,
              });
              onCommitFreePosition?.({
                ...payload,
                // ProjectWorkspace.handleCommitFreePosition 收 sourceAnchor / styleDelta / aiContext
                // 这里把 constraint 嵌进 styleDelta 之外的字段一同传上去
              }, result?.revert);
            }}
          />
          {mode === 'edit' && selectedAnchor && iframeDoc && (
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
          {/* 底部 pending edits 操作栏 — 仅在有 pending-* 时显示 */}
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

      {mode === 'code' && (
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
            if (mode !== 'edit') setMode('edit');
            onSelectChange?.(anchor);
          }}
        />
      )}
    </div>
  );
}
