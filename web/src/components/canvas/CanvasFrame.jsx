import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { Assets } from '../../lib/api.js';
import { versionOfFile, versionOfTask } from '../../lib/file-versions.js';
import { COLOR } from '../../lib/theme.js';
import BoardCanvas from './BoardCanvas.jsx';

// 懒加载（2026-07-28 重构 4）：DeckWindow 拖着 Monaco 全家，是首屏包的大头，
// 但只在用户 ✏️ 开编辑窗时才需要 —— 动态 import 让它单独分 chunk
const DeckWindow = lazy(() => import('./DeckWindow.jsx'));
const SiteWindow = lazy(() => import('./SiteWindow.jsx'));
const WorldWindow = lazy(() => import('./WorldWindow.jsx'));

/**
 * CanvasFrame — 中栏总壳（2026-07-28 桌面化重构）
 *
 * 工作台（桌面）是唯一顶层曲面，"模式"概念退役：
 *   - 桌面（BoardCanvas）永远渲染；画布层级（项目区 / 工作区）并进顶栏面包屑，
 *     画布自己不再有工具条（2026-07-28）
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
  onRegionComment,
  onSiteDomEdit,
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
  fileVersions,
  boardVersion,
  boardUi = null,
  boardApiRef: boardApiRefProp = null,
  onBoardUiState,
  stageRef = null,
}) {
  // deck 编辑窗口：开/关 + 当前标签页 + 目标（null=当前会话的旧式 deck；{task}=任务 deck）
  const [deckOpen, setDeckOpen] = useState(false);
  const [deckTab, setDeckTab] = useState('edit');
  const [deckTaskSrc, setDeckTaskSrc] = useState(null);
  // BoardCanvas 经 apiRef 暴露操作（顶栏面包屑 / 刷新用；外面给了就用外面那个）
  const ownBoardApiRef = useRef(null);
  const boardApiRef = boardApiRefProp || ownBoardApiRef;
  // ✏️ 跨会话编辑：切会话后再开窗（同会话的 ✏️ 直接 openDeck）
  const editNavRef = useRef(false);
  useEffect(() => {
    if (editNavRef.current) {
      editNavRef.current = false;
      setDeckTaskSrc(null);
      setDeckTab('edit');
      setDeckOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  // 会话没了（回 /work 新对话）→ 会话 deck 窗自然关掉（任务 deck 窗与会话解绑，保留）
  useEffect(() => {
    if (!sessionId && !deckTaskSrc) setDeckOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 站点窗 / 世界窗。三种产物共用 ArtifactWindow 那副外壳（2026-08-07），
  // 但内容层各是各的：deck 是等比 letterbox 的设计稿，站点按真实设备宽取景，
  // 世界是地图 + 世界书。同一时刻只开一扇。
  const [siteSrc, setSiteSrc] = useState(null);
  const [worldSrc, setWorldSrc] = useState(null);

  // BoardCanvas ✏️ 入口：
  //   { kind:'session' } | { kind:'task', task, file, title }
  //   { kind:'site', task, base, entry, title, pages, built } | { kind:'world', task, base, entry, title, nodes }
  const openDeck = (desc) => {
    if (desc?.kind === 'site') {
      setSiteSrc(desc);
      setWorldSrc(null);
      setDeckOpen(false);
      return;
    }
    if (desc?.kind === 'world') {
      setWorldSrc(desc);
      setSiteSrc(null);
      setDeckOpen(false);
      return;
    }
    setSiteSrc(null);
    setWorldSrc(null);
    setDeckTaskSrc(desc?.kind === 'task' ? desc : null);
    setDeckTab('edit');
    setDeckOpen(true);
  };

  // 任务 deck 的 htmlSrc：直接走 artifact-file（tasks/<任务>/canvas.html）
  // 版本按**这一份文件**取：同任务里的别的 deck 被改动时，这扇窗不该重载
  const deckRelPathForSrc = deckTaskSrc
    ? `tasks/${deckTaskSrc.task}/${deckTaskSrc.file || 'canvas.html'}`
    : null;
  const deckHtmlSrc = deckRelPathForSrc
    ? `${Assets.artifactFileUrl(projectId, deckRelPathForSrc)}?v=${versionOfFile(fileVersions, deckRelPathForSrc)}`
    : htmlSrc;
  // 用户在画布上直接改字时，改的是哪一份要跟着走 —— 不带路径会写回会话的
  // canvas.html，前端显示"已保存"而用户看的那份纹丝不动（2026-07-28）
  const deckRelPath = deckTaskSrc
    ? `tasks/${deckTaskSrc.task}/${deckTaskSrc.file || 'canvas.html'}`
    : null;
  const handleTextEditWithPath = onTextEdit
    ? (info) => onTextEdit({ ...info, deckPath: deckRelPath })
    : undefined;

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: COLOR.bgWhite,
      overflow: 'hidden',
    }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <BoardCanvas
          projectId={projectId}
          currentSessionId={sessionId}
          listVersion={artifactRefreshToken}
          fileVersions={fileVersions}
          boardVersion={boardVersion}
          onAddToContext={onAddToContext}
          apiRef={boardApiRef}
          onUiState={onBoardUiState}
          stageRef={stageRef}
          onEditNav={() => { editNavRef.current = true; }}
          onFocusDeck={openDeck}
          deckOpen={deckOpen || !!siteSrc || !!worldSrc}
        />

        {deckOpen && (sessionId || deckTaskSrc) && (
          <Suspense fallback={null}>
          <DeckWindow
            tab={deckTab}
            onTabChange={setDeckTab}
            onClose={() => setDeckOpen(false)}
            title={deckTaskSrc?.title || project?.name || '幻灯'}
            htmlSrc={deckHtmlSrc}
            htmlContent={htmlContent}
            selectedAnchor={selectedAnchor}
            onSelectChange={onSelectChange}
            onTextEdit={handleTextEditWithPath}
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
            // 圈选要落到一份具体的任务文件上 —— 旧式会话 deck（canvas.html 挂在
            // 会话目录下、不在 tasks/ 里）没有这样的路径，那种情况下不给这个工具，
            // 而不是发出去再让服务端 400
            onRegionComment={(sessionId && deckRelPath && onRegionComment)
              ? ((payload) => onRegionComment({ ...payload, path: deckRelPath }))
              : null}
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
          </Suspense>
        )}

        {siteSrc && (
          <Suspense fallback={null}>
            <SiteWindow
              projectId={projectId}
              task={siteSrc.task}
              base={siteSrc.base}
              entry={siteSrc.entry}
              title={siteSrc.title}
              pages={siteSrc.pages}
              built={!!siteSrc.built}
              fileVersions={fileVersions}
              // 直接编辑 + 评论 + 拖拽：交互组件跟 deck 同一套（SiteWindow 内部接线），
              // path 按当前页线程。改字/拖拽都走 onDomEdit 落盘（干净源码重放 + FYI 记录）
              onAddComment={sessionId ? onAddComment : null}
              onResolveComment={onResolveComment}
              onDeleteComment={onDeleteComment}
              onDomEdit={sessionId ? onSiteDomEdit : null}
              onRegionComment={sessionId ? onRegionComment : null}
              comments={comments}
              isStreaming={isStreaming}
              onIframeReady={onIframeReady}
              onClose={() => setSiteSrc(null)}
            />
          </Suspense>
        )}

        {worldSrc && (
          <Suspense fallback={null}>
            <WorldWindow
              projectId={projectId}
              task={worldSrc.task}
              base={worldSrc.base}
              entry={worldSrc.entry}
              title={worldSrc.title}
              nodes={worldSrc.nodes}
              fileVersions={fileVersions}
              onClose={() => setWorldSrc(null)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
