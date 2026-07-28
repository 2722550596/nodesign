import { useState, useRef, useEffect } from 'react';
import BoardToolbar from './BoardToolbar.jsx';
import BoardCanvas from './BoardCanvas.jsx';
import DeckWindow from './DeckWindow.jsx';

/**
 * CanvasFrame — 中栏总壳（2026-07-28 桌面化重构）
 *
 * 工作台（桌面）是唯一顶层曲面，"模式"概念退役：
 *   - 桌面（BoardCanvas）永远渲染，全局工具槽只有画布控制（BoardToolbar）
 *   - 编辑 deck = 在桌面上开一扇最大化窗口（DeckWindow）：铺满视口绝大部分、
 *     桌面压暗在底、窗口头部自带 Edit/Drag/Preview/Code 标签 + 关闭钮，
 *     关掉落回画布的内嵌预览态
 *   - 打开窗口的入口：画布物件的 ✏️（同会话直接开；跨会话经 editNavRef，
 *     切完会话再开）
 *
 * 原 deck 编辑内脏（iframe/bridge/overlay/Monaco 全家）整体迁去 DeckWindow.jsx。
 */
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
  onAddToContext,
  artifactRefreshToken,
  boardVersion,
  boardUi = null,
  onBoardUiState,
  stageRef = null,
}) {
  // deck 编辑窗口：开/关 + 当前标签页
  const [deckOpen, setDeckOpen] = useState(false);
  const [deckTab, setDeckTab] = useState('edit');
  // BoardCanvas 经 apiRef 暴露操作给 BoardToolbar
  const boardApiRef = useRef(null);
  // ✏️ 跨会话编辑：切会话后再开窗（同会话的 ✏️ 直接 openDeck）
  const editNavRef = useRef(false);
  useEffect(() => {
    if (editNavRef.current) {
      editNavRef.current = false;
      setDeckTab('edit');
      setDeckOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  // 会话没了（回 /work 新对话）→ 窗口自然关掉
  useEffect(() => {
    if (!sessionId) setDeckOpen(false);
  }, [sessionId]);

  const openDeck = () => {
    setDeckTab('edit');
    setDeckOpen(true);
  };

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: '#fff',
      overflow: 'hidden',
    }}>
      <BoardToolbar board={{ ui: boardUi, api: boardApiRef }} />

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <BoardCanvas
          projectId={projectId}
          currentSessionId={sessionId}
          refreshToken={artifactRefreshToken}
          boardVersion={boardVersion}
          onAddToContext={onAddToContext}
          apiRef={boardApiRef}
          onUiState={onBoardUiState}
          stageRef={stageRef}
          onEditNav={() => { editNavRef.current = true; }}
          onFocusDeck={openDeck}
        />

        {deckOpen && sessionId && (
          <DeckWindow
            tab={deckTab}
            onTabChange={setDeckTab}
            onClose={() => setDeckOpen(false)}
            htmlSrc={htmlSrc}
            htmlContent={htmlContent}
            selectedAnchor={selectedAnchor}
            onSelectChange={onSelectChange}
            onTextEdit={onTextEdit}
            onIframeReady={onIframeReady}
            candidates={candidates}
            activeCandidateId={activeCandidateId}
            onSelectCandidate={onSelectCandidate}
            onAddCandidate={onAddCandidate}
            onRemoveCandidate={onRemoveCandidate}
            onRenameCandidate={onRenameCandidate}
            project={project}
            deckSpec={deckSpec}
            projectId={projectId}
            sessionId={sessionId}
            decisionsReloadKey={decisionsReloadKey}
            comments={comments}
            onAddComment={onAddComment}
            onResolveComment={onResolveComment}
            onDeleteComment={onDeleteComment}
            tweaksAvailable={tweaksAvailable}
            pendingEdits={pendingEdits}
            onCommitMove={onCommitMove}
            onCommitFreePosition={onCommitFreePosition}
            onSubmitDragNote={onSubmitDragNote}
            lastPendingEditId={lastPendingEditId}
            onApplyPendingEdits={onApplyPendingEdits}
            onUndoPending={onUndoPending}
            onClearAllPending={onClearAllPending}
            canUndoPending={canUndoPending}
            isStreaming={isStreaming}
          />
        )}
      </div>
    </div>
  );
}
