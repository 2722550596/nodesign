import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Share2, Download, MoreHorizontal } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
// 主区两栏固定（左 chat + 右 canvas 占满）；5 个次级 UI = 浮窗 bounds=parent
// 限制在 canvas section 内（chat / canvas 不再可拖动 — PLAN.md:431 旧决策回归）。
import FloatingPanel from '../components/layout/FloatingPanel.jsx';
import { PanelManagerProvider } from '../components/layout/PanelManager.jsx';
// PanelMenu 已下架（用户反馈"面板"按钮太冗余）— 浮窗仍可通过 hooks 直接 toggle
import { Sliders } from 'lucide-react';
import ChatPanel from '../components/chat/ChatPanel.jsx';
import CanvasFrame from '../components/canvas/CanvasFrame.jsx';
// InspectTab 由 InspectFloatingCard 间接使用（不在此处直接 import）
// CommentsTab 已删 — comments 嵌入到 InspectFloatingCard
import TweaksPanel from '../components/context-panel/TweaksPanel.jsx';
// DecisionsTab / SystemTab 现在由 SystemPopover 间接使用（CanvasFrame 内）
// 不在此处直接 import — C2 撤销 floating panel 注册
import ShareModal from '../components/project/ShareModal.jsx';
import ExportMenu from '../components/project/ExportMenu.jsx';
import ProjectActionsMenu from '../components/project/ProjectActionsMenu.jsx';
import SnapshotModal from '../components/project/SnapshotModal.jsx';
import UpgradeQuickModal from '../components/project/UpgradeQuickModal.jsx';
import DirectEditModal from '../components/canvas/DirectEditModal.jsx';
import PlanReviewCard from '../components/project/PlanReviewCard.jsx';
import PlanRequestBanner from '../components/project/PlanRequestBanner.jsx';
import ContextUsageBar from '../components/project/ContextUsageBar.jsx';
import ExportsListModal from '../components/project/ExportsListModal.jsx';
import SessionListModal from '../components/project/SessionListModal.jsx';
import ElicitationModal from '../components/run/ElicitationModal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO, STAGE } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { MOCK_DECK_SPEC } from '../mock/deck-spec.js';
import { newId } from '../lib/helpers.js';
import { findElementByAnchor } from '../lib/html-utils.js';
import { serializeForAI } from '../lib/element-semantics.js';
import { Canvas, Turn, Assets, Exports, Sessions, PendingChanges } from '../lib/api.js';
import { openProjectWS } from '../lib/ws-client.js';
import { sessionMessagesToDisplay } from '../lib/session-to-messages.js';

export default function ProjectWorkspace() {
  // H1：URL 作为 session 唯一 source of truth
  //   - /projects/:id/work        → 无 sid（新会话）
  //   - /projects/:id/sessions/:sid → 带 sid（恢复某 session）
  // 切换 session 走 navigate；run.done 后若 url 没 sid（新会话刚跑完）
  // navigate replace 到 /sessions/<sid> 让 URL 反映真实 sid，刷新可恢复
  const { id, sid: urlSid } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const currentSessionId = urlSid || null;

  // Phase A.1（2026-05-07）：sessionId Ref 避开 React 闭包陈旧。
  // handleSend 是 async 闭包，await Turn.send 后再读 currentSessionId 拿的是闭包
  // 创建那一刻的值；navigate 异步触发 useParams 重渲染，但 handleSend 闭包持的还是旧
  // currentSessionId。结果：用户连发两条 chat（极快），第二条 handleSend 读到 null
  // 把 sessionId=null 传给 turn.js → hasActiveQuerySession 返 false → 起新 session。
  // 修法：实时维护 sessionIdRef.current = 当前真值，handleSend 优先读 ref。
  const sessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // ── store ──
  const project = useProjectStore(s => s.projects.find(p => p.id === id));
  const hydrateOne = useProjectStore(s => s.hydrateOne);
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const applyRunEvent = useProjectStore(s => s.applyRunEvent);
  // V2：context 状态从局部 useState 提到 projectStore（per-pid map）—— mount/unmount 不丢，
  // partial event 走 merge 不覆盖已有非空字段。
  const setProjectSystemInfo = useProjectStore(s => s.setProjectSystemInfo);
  const mergeProjectContextUsage = useProjectStore(s => s.mergeProjectContextUsage);
  const systemInfo = useProjectStore(s => s.contextByProject[id]?.systemInfo || null);
  const contextUsage = useProjectStore(s => s.contextByProject[id]?.contextUsage || null);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const prompt = useGlobalStore(s => s.prompt);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);
  // A4.3：维护活跃 run 的 (pid, runId)，让 AskUserQuestionView 能直接 POST /answer
  const setActiveRun = useGlobalStore(s => s.setActiveRun);

  // ── local state ──（所有 useState 必须在 early return 之前；hooks 顺序敏感）
  const [hydrated, setHydrated] = useState(false);
  const [hydrateError, setHydrateError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);  // streamInput 模式下 inputQueue 积压数（"已排队 N 条"）
  const [isTweaksExposed, setIsTweaksExposed] = useState(false);  // agent 调过 expose_tweaks 才在 ChatPanel 显示打开按钮
  const [wsStatus, setWsStatus] = useState('connecting');     // 'connecting' | 'open' | 'reconnecting' | 'closed'
  const [lastEventAt, setLastEventAt] = useState(Date.now()); // 用来检测"isStreaming 但长时间无事件"
  const [stuckSeconds, setStuckSeconds] = useState(0);        // 0=正常；>=30=显示"agent 还在思考"
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  const [iframeDoc, setIframeDoc] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  // ── P0+ s1 C17：SDK 高频事件提升的 state（被 C18/C19/C20 各组件消费）──
  // systemInfo: SDK 'system init' 事件（model / tools / mcp_servers / agents 元信息）
  // promptSuggestion: 每轮后 piggyback 预测的下条 prompt
  // agentProgress: subagent 30s 摘要（"正在分析颜色对比度…"）
  // P0+ s1 C23：toolElapsed 从单独 state 改为写到 message 对象的 elapsed 字段，
  // 消除 prop drilling，Message 组件直接读 message.elapsed。
  // V2：systemInfo / contextUsage 已上提到 projectStore（contextByProject[id]），
  // 走 setProjectSystemInfo / mergeProjectContextUsage 更新；旧的局部 useState 删掉。
  const [promptSuggestion, setPromptSuggestion] = useState(null);
  const [agentProgress, setAgentProgress] = useState(null);
  // C29：DecisionsTab 自动刷新触发器（agent 调 record_decision / compact 后 bump）
  const [decisionsReloadKey, setDecisionsReloadKey] = useState(0);
  // C5：TweaksPanel 自动刷新触发器（agent 调 expose_tweaks 后 bump）
  const [tweaksReloadKey, setTweaksReloadKey] = useState(0);
  // 终止生成：当前活跃 run 的 id（Turn.send 返回时记，run.done/error/cancelled 清）
  const [currentRunId, setCurrentRunId] = useState(null);
  // Phase A.5：currentRunIdRef 跟 state 同步，给 handleEvent 闭包用（防 stale closure）。
  // run.done/cancelled/error 必须 guard `evt.runId === currentRunIdRef.current` 才清 state，
  // 否则 stale 事件（WS 重放 / 后端慢）会清掉新一 turn 的状态。
  const currentRunIdRef = useRef(null);
  useEffect(() => { currentRunIdRef.current = currentRunId; }, [currentRunId]);
  // SDK TodoWrite 工具的实时计划清单（run.todo.updated 推）
  // 新一轮 run.start 清空；done/cancelled/error 保留作"上一轮完成情况"
  const [todos, setTodos] = useState([]);
  // H1：currentSessionId 来自 URL（urlSid，已在 useParams 上面）
  // title 用 list session 后 match URL sid 拿到
  const [currentSessionTitle, setCurrentSessionTitle] = useState('');
  const [sessionListOpen, setSessionListOpen] = useState(false);

  // Phase B 批次 4：MCP elicitation request 状态。SDK onElicitation 通过
  // run.elicitation_request 事件推 { reqId, request, runId } 进来；
  // ElicitationModal 处理 accept/decline → POST 给 /elicit/:reqId/answer
  const [elicitRequest, setElicitRequest] = useState(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportsListOpen, setExportsListOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [directEditOpen, setDirectEditOpen] = useState(false);
  const [directEditAnchor, setDirectEditAnchor] = useState(null);
  const [patches, setPatches] = useState([]);     // P0 mock：D 流盲区，C7 真接
  const [comments, setComments] = useState([]);   // P0 mock：D 流不在范围
  const exportBtnRef = useRef(null);
  const actionsBtnRef = useRef(null);
  // A2.2b：autoCompact 阈值预警的"已警告"flag。同一轮接近阈值只 toast 一次，
  // 真 compact_boundary 触发时 reset 为 false（下一轮重新累积时可再次预警）。
  const compactWarnedRef = useRef(false);

  // ── memo / callback（必须在 early return 之前）──
  const deckSpec = useMemo(() => MOCK_DECK_SPEC, []);

  // 浮窗默认 layout —— chat / canvas 改回固定栏（不浮）；
  // 5 个次级 UI 仍是浮窗（bounds = canvas 容器），默认 hidden 按需 spawn。
  // position 是相对 canvas 容器的坐标系（不是 viewport）。
  // y 起点 64 = 避开 canvas toolbar（~44px）+ 留 20px 呼吸。
  // C2/C3：浮窗体系收口
  //  - system / decisions → toolbar Settings popover（C2）
  //  - inspect / comments → 选中元素自动弹的 contextual InspectFloatingCard（C3）
  //  - 仅 tweaks 保留 floating panel（C5 schema 驱动）
  const defaultPanels = useMemo(() => ({
    tweaks:    { position: { x: 96, y: 160 },  size: { width: 320, height: 360 }, visible: false, zIndex: 100 },
  }), []);

  const panelMeta = useMemo(() => ({
    tweaks:    { label: 'Tweaks',    icon: Sliders },
  }), []);

  const handleIframeReady = useCallback((iframe) => {
    try { setIframeDoc(iframe.contentDocument); } catch { /* cross-origin */ }
  }, []);

  // ── mount: hydrate project ──
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setHydrateError(null);
    hydrateOne(id)
      .then(() => { if (!cancelled) setHydrated(true); })
      .catch((err) => { if (!cancelled) { setHydrated(true); setHydrateError(err); } });
    return () => { cancelled = true; };
  }, [id, hydrateOne]);

  // H1：拉 session 元信息更新 title（依赖 url sid + project ready + titleRefreshKey）
  // titleRefreshKey 每次 run.done 时 bump，让 SDK 自动总结的最新 summary 能反映到 UI
  // （SDK 用 haiku helper 在每个 turn 后 incrementally 更新 summary，落 JSONL）
  const refreshSessionTitle = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      const { sessions = [] } = await Sessions.list(id, { limit: 100 });
      const match = sessions.find(s => s.sessionId === currentSessionId);
      if (match) setCurrentSessionTitle(match.customTitle || match.summary || '');
    } catch (err) {
      console.warn('[Project] list sessions failed:', err.message);
    }
  }, [id, currentSessionId]);

  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    if (!currentSessionId) {
      setCurrentSessionTitle('');
      return;
    }
    refreshSessionTitle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hydrated, hydrateError, project?.id, currentSessionId]);

  // H1：hydrate session messages（依赖 url sid）
  // 防 wipe optimistic：streamInput 模式下 user msg 是 push 进 inputQueue（内存）
  // 不立即写 JSONL，handleSend 后 navigate `/work` → `/sessions/<sid>` 触发本
  // useEffect 时 Sessions.read 拿到的 JSONL 还没含刚发的 user msg → display 空 →
  // 直接 setMessages(display) 会把 handleSend 乐观插入的 user msg 覆盖丢失。
  // 现象：用户发首条消息后前端不显示，但后端已在跑 → assistant delta 突然推上来。
  // 修法 ①：新建 session 路径（prevHydrateSidRef=null + prev 已含乐观 msg）跳过
  //   hydrate，信任前端 state + WS run.delta.* 流式更新。
  // 修法 ②：display 缺的乐观 user msg（按 content 匹配）保留——server 慢一拍 flush 时不丢。
  const prevHydrateSidRef = useRef(null);
  useEffect(() => {
    if (!currentSessionId) {
      // /work 路径 = 新会话 → 空 chat 让用户从头开始
      setMessages([]);
      prevHydrateSidRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { messages: sessionMsgs = [] } = await Sessions.read(id, currentSessionId);
        if (cancelled) return;
        const display = sessionMessagesToDisplay(sessionMsgs);
        setMessages(prev => {
          // 修法 ①：新建 session navigate 路径（null → 真 sid，prev 已乐观插入）
          // → streamInput user msg 在 inputQueue 不在 JSONL，hydrate 拿到空数组
          // 会把乐观插入吞掉。直接信任 prev 不替换。
          const isNewSessionNavigation = prevHydrateSidRef.current === null && prev.length > 0;
          if (isNewSessionNavigation) {
            if (import.meta.env.DEV) console.info('[H1] skip hydrate on new-session navigation, trust optimistic + WS delta');
            return prev;
          }
          // 修法 ②：display 缺的乐观 user msg（content 不匹配）保留——双保险
          const displayUserContents = new Set(
            display.filter(m => m.role === 'user').map(m => (m.content || '').trim())
          );
          const orphans = prev.filter(m =>
            m.role === 'user' && !displayUserContents.has((m.content || '').trim())
          );
          if (orphans.length > 0) {
            if (import.meta.env.DEV) console.warn(`[H1] kept ${orphans.length} orphan optimistic user msg(s) — JSONL flush race`);
            return [...display, ...orphans];
          }
          return display;
        });
        prevHydrateSidRef.current = currentSessionId;
      } catch (err) {
        console.warn('[Project] hydrate session messages failed:', err.message);
        setMessages([]);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentSessionId]);

  // 检测"isStreaming 但长时间无新事件" —— agent 长 thinking 期间 SDK 可能不
  // emit stream_event（取决于模型 / gateway 行为），用户体感是"前端卡死"。
  // 每 5s tick：如 isStreaming + 距上次事件 > 30s → 显示 stuck 警告 chip
  // 让用户知道 agent 仍在跑（vs WS 真断 → wsStatus='reconnecting' 单独显示）
  useEffect(() => {
    if (!isStreaming) {
      if (stuckSeconds !== 0) setStuckSeconds(0);
      return undefined;
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - lastEventAt) / 1000);
      setStuckSeconds(elapsed >= 30 ? elapsed : 0);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, lastEventAt]);

  // session/project 切换时重置 per-session UI state，防止跨 session/project 串话：
  // - comments：纯前端 state（D 流接通前没持久化），切 session 旧 session 评论
  //   仍残留在数组里，用户在新 session 看到错的评论
  // - patches：同上
  // - selectedAnchor：上个 session 选中的元素 anchor 切到新 session 不再有意义
  // - 浮窗（inspect / a11y popover）切 session 时该关掉
  useEffect(() => {
    setComments([]);
    setPatches([]);
    setSelectedAnchor(null);
    setInputs([]);                    // 清空附件托盘
    setPromptSuggestion(null);        // 清掉上 session 残留 SuggestionChip
    setAgentProgress(null);           // 清 subagent progress
    setQueueDepth(0);                 // 清 queue depth（切 session 跨 query 不延续）
    setStuckSeconds(0);               // 清 stuck 计时
    setLastEventAt(Date.now());       // 重置事件时间避免切 session 时误报"卡住"
    setIsTweaksExposed(false);        // 切 session 时清，新 session 待 agent 重 expose
    useGlobalStore.getState().clearPlanForApproval();  // 清 plan 卡（如果切 session 时还在等 approval）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentSessionId]);

  // ── open WS once project exists ──
  // 依赖 project?.id 而非整个 project 对象，避免 status patch 触发重连
  // Phase A.4：wsRef 让 currentSessionId 变化时能调 reconnectForSession 让 server 用新 sid 推 hydrate
  const wsRef = useRef(null);
  // Phase A.4：hydrate 缓冲 — chunks 累积到 end 一次性 setMessages
  const hydrateBufferRef = useRef([]);
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    const ws = openProjectWS({
      projectId: id,
      // Phase A.4：getSid callback 让 ws-client 重连时能拿到最新 sid（避免闭包陈旧）
      getSid: () => sessionIdRef.current,
      onEvent: (evt) => {
        setLastEventAt(Date.now());     // 记录最近一次事件时间，给"无事件超时"用
        applyRunEvent(id, evt);
        handleEvent(evt);
      },
      onStatusChange: (status) => {
        setWsStatus(status);
        // Phase A.2（2026-05-07）：WS 断 / 重连中时强制 reset isStreaming —— 否则
        // UI 卡 isStreaming=true 但收不到 delta，用户看到"在跑"实际没事件来。
        // 不清 currentRunId（cancel 仍可用）；重连后若 run 还活着 SDK 会接续推。
        // open / connecting 不动 state。
        if (status === 'reconnecting' || status === 'closed') {
          setIsStreaming(false);
        }
      },
    });
    wsRef.current = ws;
    return () => {
      wsRef.current = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hydrated, hydrateError, project?.id]);

  // Phase A.4：currentSessionId 变化时重连 WS 让 server 用新 sid 推 hydrate
  // （首挂载除外 — 那时 wsRef 刚 open，它已经用最新 sid）
  const lastReconnectedSidRef = useRef(null);
  useEffect(() => {
    if (!wsRef.current) return;
    if (lastReconnectedSidRef.current === currentSessionId) return;
    // 首次挂载（lastReconnectedSidRef.current === null && currentSessionId === null）
    // 或 WS 刚 open 时 currentSessionId 已经是初值，不需要重连
    if (lastReconnectedSidRef.current !== null) {
      wsRef.current.reconnectForSession?.();
    }
    lastReconnectedSidRef.current = currentSessionId;
  }, [currentSessionId]);

  // ── H4a: auto-send initialMessage from location.state（HubInput 入口）──
  // Hub 用户在 input box 输入 → navigate('/work', { state: { initialMessage } })
  // 这里 mount 完毕 + project hydrated + WS 上线后自动发送一次，无感跳转。
  // 用 ref 防双发（StrictMode + state 闭包都可能触发重入）；发完 navigate
  // replace 清 state 防刷新重发。
  const initialMessageSentRef = useRef(false);
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    if (initialMessageSentRef.current) return;
    const initial = location.state?.initialMessage;
    if (typeof initial !== 'string' || !initial.trim()) return;
    // QuickEntry / HubInput 入口在 navigate state 里捎带 attachments（已上传到
    // shared/assets/，格式 [{ type:'asset', path, name, size, mime }]）—— 首条 turn
    // 一起喂给 agent，turn.js composeUserMessage 会自动加"已附上 N 张参考图 / 可用素材路径"
    // 的系统提示，agent 这一轮就能看到/读到。
    const stateAttachments = Array.isArray(location.state?.attachments)
      ? location.state.attachments
      : [];
    initialMessageSentRef.current = true;

    const text = initial.trim();
    // 等 WS 连上一两个 tick 再发，确保 run.start 等事件能收到
    const t = setTimeout(async () => {
      setMessages((ms) => [...ms, { id: newId('msg'), role: 'user', content: text }]);
      try {
        const { runId } = await Turn.send({
          pid: id,
          chat: text,
          attachments: stateAttachments,
          sessionId: currentSessionId,  // /work 路径 → null（新会话）；/sessions/:sid → 续约
        });
        setCurrentRunId(runId);
        setActiveRun({ pid: id, runId });  // A4.3：让 AskUserQuestionView 直 POST /answer
      } catch (err) {
        setMessages((ms) => [...ms, {
          id: newId('msg'), role: 'assistant',
          content: `_⚠️ 发送失败：${err.message}_`,
        }]);
        showToast(`发送失败：${err.message}`, 'error');
      }
      // 清 location.state 防 navigate 后退/刷新重发
      navigate(location.pathname, { replace: true, state: null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, hydrateError, project?.id, location.state]);

  /** WS 事件 → chat messages / iframe reload 翻译层 */
  function handleEvent(evt) {
    switch (evt.type) {
      // ── Phase A.4：WS hydrate 协议（server 推完整 messages 让前端不依赖 HTTP Sessions.read）──
      case 'ws.hydrate.start':
        // start { total, asOfSeq } 或 { kind:'error' }
        if (evt.kind === 'error') {
          // hydrate 失败兜底：原 useEffect[currentSessionId] Sessions.read 仍跑，作为 HTTP fallback
          if (import.meta.env.DEV) console.warn('[ws.hydrate] server-side error:', evt.error);
          break;
        }
        hydrateBufferRef.current = [];
        break;
      case 'ws.hydrate.chunk':
        if (Array.isArray(evt.messages)) {
          hydrateBufferRef.current = [...hydrateBufferRef.current, ...evt.messages];
        }
        break;
      case 'ws.hydrate.end': {
        const buffer = hydrateBufferRef.current;
        hydrateBufferRef.current = [];
        const display = sessionMessagesToDisplay(buffer);
        // 防 wipe optimistic：hydrate 拿到空 messages（jsonl 还没 flush）但 current 有
        // 内容（用户刚 setMessages 的 user msg + 流式 delta）→ 信任 current 不替换
        setMessages(prev => {
          if (display.length === 0 && prev.length > 0) return prev;
          // orphan merge：display 不空但缺乐观 user msg（server flush 了 metadata 但
          // user msg 还在 inputQueue 没落 JSONL）—— 保留 prev 里 content 不匹配的 user msg
          const displayUserContents = new Set(
            display.filter(m => m.role === 'user').map(m => (m.content || '').trim())
          );
          const orphans = prev.filter(m =>
            m.role === 'user' && !displayUserContents.has((m.content || '').trim())
          );
          if (orphans.length > 0) {
            if (import.meta.env.DEV) console.warn(`[hydrate.end] kept ${orphans.length} orphan optimistic user msg(s) — JSONL flush race`);
            return [...display, ...orphans];
          }
          return display;
        });
        break;
      }
      case 'ws.connected':
        // ws.connected 由 ws-client 处理 lastSeq；此处不需做事。但若 gap=true 且
        // 没收到对应的 ws.hydrate.start（无 sid 路径 / hydrate 失败），可考虑退到
        // HTTP Sessions.read fallback 重新 hydrate（暂不主动触发，由 useEffect[sid]
        // 兜底）
        break;

      case 'run.start':
        setIsStreaming(true);
        setTodos([]);
        break;
      case 'run.queue.depth':
        // streamInput 模式：inputQueue 积压数变化（push 后 / 处理完一条后）
        setQueueDepth(typeof evt.depth === 'number' ? evt.depth : 0);
        break;
      case 'run.query.end':
        // 整个 session 的 query 死了 —— 清 queue depth + 提示用户
        setQueueDepth(0);
        break;
      case 'run.todo.updated':
        setTodos(Array.isArray(evt.todos) ? evt.todos : []);
        break;
      case 'run.delta.text':
        setMessages(prev => appendTextDelta(prev, 'assistant', evt.text, evt.runId));
        break;
      case 'run.delta.thinking':
        setMessages(prev => appendTextDelta(prev, 'thinking', evt.text, evt.runId));
        break;
      case 'run.tool_use.started':
        // 工具 streaming 起点（SDK content_block_start 触发）。立即推 icon + name
        // 让用户看到"agent 在调 X 工具"，input 待 run.delta.tool_use 来时补。
        setMessages(prev => {
          // 防御：如果同 blockId 已经在（理论上不会，但 ws 重连重放可能），noop
          if (prev.some(m => m.role === 'tool' && m.id === evt.blockId)) return prev;
          return [...prev, {
            id: evt.blockId,
            role: 'tool',
            toolName: evt.name,
            toolInput: undefined,  // 还没流完
            status: 'running',
            runId: evt.runId,  // 用于 delta merge 时判断同一 turn 边界
          }];
        });
        break;
      case 'run.delta.tool_use':
        // assistant message 完成时 SDK 推完整 tool_use block 来。如果同 blockId
        // 的 tool message 已存在（被 run.tool_use.started 推过），就 update input；
        // 否则补 push（兼容 SDK 没出 content_block_start 的情况，如某些 stream 边界）。
        setMessages(prev => {
          const existingIdx = prev.findIndex(m => m.role === 'tool' && m.id === evt.blockId);
          if (existingIdx >= 0) {
            const updated = [...prev];
            updated[existingIdx] = { ...updated[existingIdx], toolInput: evt.input };
            return updated;
          }
          return [...prev, {
            id: evt.blockId || newId('tool'),
            role: 'tool',
            toolName: evt.name,
            toolInput: evt.input,
            status: 'running',
            runId: evt.runId,
          }];
        });
        break;
      case 'run.delta.tool_result':
        setMessages(prev => prev.map(m =>
          m.role === 'tool' && m.id === evt.blockId
            ? {
                ...m,
                status: evt.ok ? 'success' : 'error',
                toolOutput: evt.output,
                toolError: evt.error,
                // C24：image content blocks（screenshot_canvas 等返回的图片）
                toolImages: evt.images,
              }
            : m,
        ));
        break;
      case 'run.done': {
        // Phase A.5：用 ref 拿最新 currentRunId（handleEvent 闭包持的 currentRunId
        // 可能 stale）。stale run.done（WS 重放 / 后端慢推上一 turn 的 result）来时
        // 如果当前已是新 turn，不能清 state（会让用户的新 turn 假死）。
        const liveRunId = currentRunIdRef.current;
        if (liveRunId && evt.runId && evt.runId !== liveRunId) {
          // stale event，仅 clearThinking 兜底但不动 isStreaming / currentRunId
          if (import.meta.env.DEV) console.warn(`[event] stale run.done ${evt.runId} (current ${liveRunId}), ignoring state cleanup`);
          setMessages(prev => clearThinkingStreaming(prev));
          break;
        }
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        useGlobalStore.getState().clearPlanForApproval();  // Phase 3.2：run 终止时清残留 plan 卡
        // 收尾：清 thinking 流式光标（run 结束后最后一条 thinking 不该一直闪）
        setMessages(prev => clearThinkingStreaming(prev));
        // 双保险：FileChanged hook（run.file_changed）应该已 bump 过 reloadToken
        // 但万一 hook 不触发（如 SDK 边角问题），这里兜底再 bump 一次
        setReloadToken(t => t + 1);
        // Phase B 批次 5：SDK 用 haiku helper incrementally 更新 session summary
        // 落 JSONL，run.done 后 refetch 让 chat 头部 / 面包屑 title 反映最新总结。
        // 已有 sid 的场景立即刷；新建场景下面 navigate 完会触发 useEffect 重 fetch。
        if (currentSessionId) {
          refreshSessionTitle();
        }
        // H1：从"新会话"（/work 路径）刚跑完 → SDK 已建新 sid → navigate
        // replace 到 /sessions/<sid>，让 URL 反映真实 sid（刷新可恢复，
        // SessionListModal 现在能高亮当前 session）
        if (!currentSessionId) {
          Sessions.list(id, { limit: 1 }).then(({ sessions = [] }) => {
            if (sessions.length > 0) {
              navigate(`/projects/${id}/sessions/${sessions[0].sessionId}`, { replace: true });
            }
          }).catch(() => { /* ignore */ });
        }
        break;
      }
      case 'run.file_changed':
        // C4: FileChanged hook → 仅对 canvas.html / *.html 后缀触发 iframe reload
        // 其他文件（spec.json / assets/* / .git/*）忽略
        if (typeof evt.filePath === 'string'
            && (evt.filePath.endsWith('canvas.html') || evt.filePath.endsWith('.html'))) {
          setReloadToken(t => t + 1);
        }
        break;
      case 'run.error': {
        // Phase A.5：stale event guard，同 run.done
        const liveRunId = currentRunIdRef.current;
        if (liveRunId && evt.runId && evt.runId !== liveRunId) {
          if (import.meta.env.DEV) console.warn(`[event] stale run.error ${evt.runId} (current ${liveRunId}), ignoring`);
          break;
        }
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        useGlobalStore.getState().clearPlanForApproval();  // Phase 3.2：run 终止时清残留 plan 卡
        setMessages(prev => [...clearThinkingStreaming(prev), {
          id: newId('msg'),
          role: 'assistant',
          content: `_⚠️ ${evt.message || '运行出错'}_`,
        }]);
        showToast(`运行失败：${evt.message || '未知错误'}`, 'error');
        break;
      }
      case 'run.cancelled': {
        // Phase A.5：stale event guard，同 run.done
        const liveRunId = currentRunIdRef.current;
        if (liveRunId && evt.runId && evt.runId !== liveRunId) {
          if (import.meta.env.DEV) console.warn(`[event] stale run.cancelled ${evt.runId} (current ${liveRunId}), ignoring`);
          break;
        }
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        useGlobalStore.getState().clearPlanForApproval();  // Phase 3.2：run 终止时清残留 plan 卡
        setPromptSuggestion(null);
        setAgentProgress(null);
        setMessages(prev => clearThinkingStreaming(prev));
        showToast('已取消', 'info');
        // streamInput 模式：cancel 只是 interrupt 当前 turn，query 仍活着接下条 message。
        // 跟 run.done 同步：从"新会话"（/work）路径 cancel 时也要 navigate 到 /sessions/<sid>，
        // 否则 URL 还是 /work，下次发 chat sessionId=null 会起新 session 跟原 session 脱钩
        if (!currentSessionId) {
          Sessions.list(id, { limit: 1 }).then(({ sessions = [] }) => {
            if (sessions.length > 0) {
              navigate(`/projects/${id}/sessions/${sessions[0].sessionId}`, { replace: true });
            }
          }).catch(() => { /* ignore */ });
        }
        break;
      }

      // ── SDK helper events（P0：Phase B 批次 1）──

      case 'run.rate_limit': {
        // 速率限制状态变化（rate_limit_event）。SDK 只在状态变化时推，不会刷屏。
        // - rejected：真触发限制 → error toast
        // - allowed_warning：接近限制 → warn toast 带使用率
        // - allowed：恢复正常 → 不 toast（避免噪声）
        const info = evt.info || {};
        if (info.status === 'rejected') {
          showToast(`已触发速率限制（${info.rateLimitType || 'unknown'}）`, 'error');
        } else if (info.status === 'allowed_warning') {
          const pct = Math.round((info.utilization || 0) * 100);
          showToast(`接近速率限制：已用 ${pct}%`, 'warn');
        }
        break;
      }

      case 'run.status':
        // SDK 内部状态：'compacting' | 'requesting' | null。
        // requesting 每个 LLM call 都触发，太频繁 → 跳过；只 toast compacting
        // （少见但耗时长，需要让用户知道"在压缩、不是卡住"）。
        if (evt.status === 'compacting') {
          showToast('正在压缩上下文...', 'info');
        }
        break;

      case 'run.system_init':
        // SDK 启动元信息：model / tools / mcp_servers / agents
        setProjectSystemInfo(id, evt.info);
        break;

      case 'run.context_usage': {
        // A2.1 后端 loop.js 每个 assistant message 后推一次。
        // 整条 evt 已是 ContextUsageBar 期望的 liveUsage 形态（events.js
        // Events.contextUsage 已轻量化）。merge 而非 replace —— partial event 缺字段时不
        // 覆盖已有值（用户反馈"动不动丢失信息"，根因是直接 replace 把上次的 messageBreakdown
        // 等慢字段清掉了）。
        mergeProjectContextUsage(id, evt);
        // A2.3：autoCompact 阈值预警。当 totalTokens >= 90% threshold 时
        // toast 提示"快压缩了"。compactWarnedRef 防止同一轮重复 toast；
        // 真 compact_boundary 触发时 reset，让下一段可以再次预警。
        if (evt.isAutoCompactEnabled && evt.autoCompactThreshold && evt.totalTokens) {
          const ratio = evt.totalTokens / evt.autoCompactThreshold;
          if (ratio >= 0.9 && !compactWarnedRef.current) {
            compactWarnedRef.current = true;
            const remainingK = ((evt.autoCompactThreshold - evt.totalTokens) / 1000).toFixed(0);
            showToast(
              `⚠ 上下文接近自动压缩阈值（${(ratio * 100).toFixed(0)}%），剩 ${remainingK}k tokens`,
              'error',  // 用 error kind 拿橙红色配色凸显严重性
            );
          }
        }
        break;
      }

      case 'run.prompt_suggestion':
        // 每轮后预测的下条 prompt（C19 SuggestionChip 消费）
        setPromptSuggestion(evt.suggestion);
        break;

      case 'run.task.started':
        // C28：把 task 元信息绑到 main agent 的 Task tool message
        // tool_use_id 关联 → 用户能在 Task chip 上看到 agentType / description
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  taskId: evt.taskId,
                  agentType: evt.taskType,
                  taskDescription: evt.description,
                  taskStatus: 'running',
                }
              : m,
          ));
        }
        break;

      case 'run.task.progress':
        // subagent 30s 摘要（ChatPanel header progress chip 消费）+ 同步到 Task tool message
        setAgentProgress({
          taskId: evt.taskId,
          description: evt.description,
          summary: evt.summary || null,
          lastTool: evt.lastToolName || null,
        });
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? { ...m, taskSummary: evt.summary, taskLastTool: evt.lastToolName }
              : m,
          ));
        }
        break;

      case 'run.task.notification':
        // subagent 完成 / 失败 / 停止 → 更新对应 Task tool message status
        setAgentProgress(null);
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  taskStatus: evt.status,           // 'completed' | 'failed' | 'stopped'
                  taskSummary: evt.summary,
                }
              : m,
          ));
        }
        if (evt.status === 'failed') {
          showToast(`子代理失败：${evt.summary || ''}`, 'error');
        } else if (evt.status === 'stopped') {
          showToast('子代理已停止', 'info');
        }
        break;

      case 'run.tool_progress':
        // 工具执行 >1s 时定期推 → 写到对应 tool message 的 elapsed 字段
        // C23 Message ToolMessage 渲染 "· 12s" 在工具调用 chip 旁边
        if (evt.blockId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.blockId
              ? { ...m, elapsed: evt.elapsedSeconds }
              : m,
          ));
        }
        break;

      case 'run.bash_blocked':
        // C25：PreToolUse hook 拦了一条 Bash —— 用 system role 区分自 assistant 消息
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'system',
          variant: 'warn',
          content: `Bash 命令被拦截：${evt.command || ''}\n${evt.reason || '不在白名单'}`,
        }]);
        break;

      case 'run.screenshot_taken':
        // MCP screenshot_canvas 调用成功（agent 在自检）
        showToast('agent 正在视觉自检', 'info');
        break;

      case 'run.export_built':
        // MCP export_handoff 调用成功 —— agent 主动打了交付包
        showToast(`已生成交付包：${evt.path || ''}`, 'success');
        break;

      case 'run.decision_recorded':
        // MCP record_decision 调用成功 —— agent 沉淀了一条设计决策
        // 不弹 toast 避免噪音（agent 可能频繁调）；
        // 触发 DecisionsTab 自动刷新 + console 留痕
        setDecisionsReloadKey(k => k + 1);
        if (typeof window !== 'undefined') {
          // eslint-disable-next-line no-console
          console.log(`[decision] ${evt.title} (now ${evt.decisionsCount} decisions)`);
        }
        break;

      case 'run.compact_persisted':
        // PostCompact hook 写完 spec.json → DecisionsTab 也更新
        setDecisionsReloadKey(k => k + 1);
        showToast(`已沉淀 compact 摘要（${evt.summaryLength || '?'} chars）`, 'info');
        break;

      case 'run.tweaks_exposed':
        // C5: agent 调 expose_tweaks 写 spec.tweaks → TweaksPanel reload schema
        setTweaksReloadKey(k => k + 1);
        setIsTweaksExposed(true);  // ChatPanel header 上显示打开按钮（PanelMenu 下架后唯一入口）
        showToast(`Tweaks 已更新（${evt.count} 个控件）`, 'info');
        break;

      case 'run.canvas_navigate': {
        // C6: agent 调 navigate_to_page → 前端 scrollIntoView 该 section
        try {
          const iframeEl = document.querySelector('iframe');
          const target = iframeEl?.contentDocument?.querySelector(`section[data-page="${evt.page}"]`);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch { /* cross-origin / iframe missing */ }
        break;
      }

      case 'run.canvas_highlight': {
        // C6: agent 调 highlight → pulse outline 短暂高亮匹配元素
        try {
          const iframeEl = document.querySelector('iframe');
          const target = iframeEl?.contentDocument?.querySelector(evt.selector);
          if (target) {
            const origOutline = target.style.outline;
            const origOffset = target.style.outlineOffset;
            const origTransition = target.style.transition;
            target.style.transition = 'outline 0.2s ease, outline-offset 0.2s ease';
            target.style.outline = '3px solid rgba(255, 196, 0, 0.85)';
            target.style.outlineOffset = '4px';
            setTimeout(() => {
              try {
                target.style.outline = origOutline;
                target.style.outlineOffset = origOffset;
                target.style.transition = origTransition;
              } catch { /* element might be gone */ }
            }, evt.durationMs || 1500);
          }
        } catch { /* */ }
        break;
      }

      case 'run.stop_reflection':
        // C6 Stop hook（占位，stage 1 不消费）
        break;

      // ── P1：Phase 1+2 漏接事件补齐 ──

      case 'run.tool_failure':
        // PostToolUseFailure hook → 让用户看到"哪个工具失败了"
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'system',
          variant: 'warn',
          content: `工具失败：${evt.toolName} — ${formatToolError(evt.error)}`,
        }]);
        break;

      case 'run.notification':
        // SDK / hook 主动 emit 的通知 → toast
        // priority 映射：error/high → error；success → success；其他 → info
        showToast(evt.text || '通知', mapNotificationKind(evt.priority));
        break;

      case 'run.compact_boundary': {
        // 上下文压缩边界 —— 让用户知道"agent 重新整理了上下文"
        // A2.3：升级提示带 pre/post token 数 + trigger（manual/auto）
        const meta = evt.compactMetadata;
        let msg = '上下文已自动压缩';
        if (meta?.pre_tokens && meta?.post_tokens) {
          const preK = (meta.pre_tokens / 1000).toFixed(0);
          const postK = (meta.post_tokens / 1000).toFixed(0);
          const trigger = meta.trigger === 'manual' ? '手动' : '自动';
          msg = `上下文已${trigger}压缩 ${preK}k → ${postK}k tokens`;
        }
        showToast(msg, 'info');
        // reset 预警 flag，下一段再次接近阈值时可以重新提示
        compactWarnedRef.current = false;
        break;
      }

      case 'run.api_retry': {
        // SDK API 重试（rate limit / server error 等）。
        // 多次重试用 fixed id 替换，避免刷屏。
        const text = `API 重试中（${evt.attempt}/${evt.maxRetries}）${evt.errorKind ? ` — ${evt.errorKind}` : ''}${evt.errorStatus != null ? ` HTTP ${evt.errorStatus}` : ''}`;
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === 'api-retry');
          const msg = { id: 'api-retry', role: 'system', variant: 'warn', content: text };
          if (idx >= 0) return [...prev.slice(0, idx), msg, ...prev.slice(idx + 1)];
          return [...prev, msg];
        });
        break;
      }

      case 'run.subagent.stop': {
        // S3b：子代理收尾的 lastAssistantMessage 挂回对应 Task tool message。
        // 前端 Message.jsx ToolMessage 在 agentType === 'vision-checker' 时
        // 渲染 critique 卡（VERDICT/ISSUES/OVERALL），其他 subagent 暂不渲染（可拓展）。
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  subagentResult: {
                    lastAssistantMessage: evt.lastAssistantMessage || null,
                    transcriptPath: evt.transcriptPath || null,
                    agentId: evt.agentId,
                    agentType: evt.agentType,
                  },
                }
              : m,
          ));
        }
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[event] ${evt.type}`, evt);
        }
        break;
      }

      case 'run.plan_for_approval': {
        // Phase 3.2：SDK 原生 plan mode — agent 调 ExitPlanMode 提交 plan，
        // 显示 PlanReviewCard 让用户 approve / edit / reject
        useGlobalStore.getState().setPlanForApproval({
          toolUseId: evt.toolUseId,
          plan: evt.plan,
        });
        showToast('设计计划待审批', 'info');
        break;
      }

      case 'run.plan_mode_requested': {
        // Phase C：agent 调 mcp__nodesign__request_plan_mode 主动请求进 plan mode。
        // 阻塞态（2026-05-07）：agent 工具 await 用户决定，前端 banner 处理：
        //   - yes → POST /permission-mode { mode:'plan' } + POST /plan-request/:tid/decide { approved:true }
        //   - no  → POST /plan-request/:tid/decide { approved:false }
        // toolUseId 必带（agent decide endpoint 找 pending Promise 的 key）。
        useGlobalStore.getState().setPlanModeRequest({
          toolUseId: evt.toolUseId,
          reason: evt.reason,
          estimatedPages: evt.estimatedPages,
          taskKind: evt.taskKind,
        });
        showToast('agent 请求进入 plan 模式（已暂停等你决定）', 'info');
        break;
      }

      case 'run.image_generated': {
        // generate_image MCP 工具完成 → toast 提示。
        // 注：原 Phase Image-1 的自动 ImageApprovalBanner gate 已废弃（2026-05-06）—
        // generate_image CallToolResult 已返 image content block，前端 chat 自动渲染；
        // agent 在 caption 邀请反馈，用户下一轮 chat 即天然 gate。
        const role = evt.assetRole ? `[${evt.assetRole}] ` : '';
        showToast(`${role}已生成图片：${evt.path}`, 'success');
        break;
      }

      // Phase B 批次 3：SDK 自动 recall 写入 globalStore，MemoryCard 折叠区显示
      case 'run.memory_recall':
        useGlobalStore.getState().appendRecallHistory(id, {
          mode: evt.mode,
          memories: evt.memories,
          ts: evt.ts,
        });
        break;

      // Phase B 批次 4：MCP 工具 elicitInput 请求 → 弹 ElicitationModal
      // request 形如 { reqId, request: {...}, runId }
      case 'run.elicitation_request':
        setElicitRequest({ reqId: evt.reqId, request: evt.request, runId: evt.runId });
        break;

      // 运维 / 调试信号——不展示 UI，只 console 留痕（dev 模式）。
      // 这些事件用于排查问题，不该 spam 用户视图。
      case 'run.subagent.start':
      case 'run.session_state':
      case 'run.session_start':
      case 'run.files_persisted':
      case 'run.hook.started':
      case 'run.hook.response':
      case 'run.task.updated':
      case 'run.round.start':
      case 'run.round.end':
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[event] ${evt.type}`, evt);
        }
        break;

      default:
        break;
    }
  }

  // ── early return ──
  if (!hydrated) {
    return (
      <AppShell breadcrumb={[{ label: '加载中...' }]}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '60vh',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
        }}>
          加载项目中…
        </div>
      </AppShell>
    );
  }
  if (hydrateError || !project) {
    return <NotFound id={id} error={hydrateError?.message} />;
  }

  // V2：TopBar status chip 整个去掉（用户反馈"运行中"/"上次失败"/"就绪"全违和）
  //   - running 由 ChatComposer 的 Send → 停止 按钮承担
  //   - failed 由 chat 内 ⚠️ inline assistant 消息承担
  //   - idle 没信息价值，删掉

  // ── handlers ──

  /**
   * ChatComposer send → POST /turn（流 A/C/B）
   * 把托盘里的 attachments（已上传成功的 asset）一起带；上传中 / 失败的不发。
   * send 成功后清空托盘。
   */
  const handleSend = async (text) => {
    if (!text || !text.trim()) return;
    // mime 字段必传：Phase 1.4 后端 image inline 检测用 mime 判断是不是图
    const attachments = inputs
      .filter(it => it.type === 'asset' && it.path)
      .map(it => ({ type: 'asset', path: it.path, name: it.name, size: it.size, mime: it.mime }));

    // Phase 3.2：plan-mode toggle 状态决定本次 turn 走 SDK 原生 plan mode
    const planModeEnabled = useGlobalStore.getState().planModeEnabled;

    // Phase B 批次 3：用户主动 recall 的 project memory 拼到 chat 头部
    // <memory-recall> 包裹让 agent 知道这是用户主动注入的记忆而不是普通文本
    const pendingRecalls = useGlobalStore.getState().consumePendingMemoryRecalls();
    let chatWithRecalls = text;
    if (pendingRecalls.length > 0) {
      const recallBlocks = pendingRecalls.map(r => {
        const tag = r.agentType || 'main';
        return `<memory-recall agent="${tag}">\n${r.content}\n</memory-recall>`;
      }).join('\n\n');
      chatWithRecalls = `${recallBlocks}\n\n${text}`;
    }

    setMessages(ms => [...ms, { id: newId('msg'), role: 'user', content: text }]);
    try {
      // Phase A.1：优先用 ref 拿 sessionId，避开 React async 闭包陈旧。
      // 极快连发场景下 currentSessionId（useParams）还没刷过来，ref 已是最新。
      const sidForRequest = sessionIdRef.current ?? currentSessionId;
      const { runId, sessionId: returnedSid } = await Turn.send({
        pid: id,
        chat: chatWithRecalls,
        attachments,
        // S4：显式传选中的 sessionId；null 时后端识别为"新建 session"
        sessionId: sidForRequest,
        permissionMode: planModeEnabled ? 'plan' : undefined,
      });
      setCurrentRunId(runId);  // 终止生成用
      setActiveRun({ pid: id, runId });  // A4.3：让 AskUserQuestionView 直 POST /answer
      setInputs([]);  // 已发送的托盘清空
      // streamInput 重构修：从 /work 路径起新 session 时立刻 navigate 到 /sessions/<sid>
      // —— 否则用户在第一 turn 跑完前发追加，currentSessionId 还是 null 会被当新 session
      // 起，跟原 session 脱钩（之前只在 run.done/cancelled 后 navigate，慢了一拍）
      if (!sidForRequest && returnedSid) {
        // Phase A.1：立即同步 ref，让下一条极快追加的 handleSend 拿到正确 sid（不依赖 navigate 的 useParams 异步刷新）
        sessionIdRef.current = returnedSid;
        navigate(`/projects/${id}/sessions/${returnedSid}`, { replace: true });
      }
    } catch (err) {
      setMessages(ms => [...ms, {
        id: newId('msg'),
        role: 'assistant',
        content: `_⚠️ 发送失败：${err.message}_`,
      }]);
      showToast(`发送失败：${err.message}`, 'error');
    }
  };

  /** streamInput 重构：用户主动结束当前 session（终结 query handle）
   *  - 调 close endpoint → backend inputQueue.close + abortController.abort
   *  - navigate to /work → currentSessionId 变 null → useEffect 自动 reset 前端 state
   *  - session JSONL 不删，从 SessionListModal 仍可找回（resume 走 forkSession）
   */
  const handleCloseSession = async () => {
    if (!currentSessionId) return;
    try {
      await Sessions.close(id, currentSessionId);
    } catch (err) {
      // close 失败不阻塞前端 — 仍 navigate 让用户能继续
      console.warn('[Project] close session failed:', err.message);
    }
    setIsStreaming(false);
    setCurrentRunId(null);
    setActiveRun(null);
    navigate(`/projects/${id}/work`, { replace: true });
  };

  /** 终止当前活跃 run（用户点 ChatPanel 的 Stop 按钮） */
  const handleStop = async () => {
    if (!currentRunId) return;
    try {
      await Turn.cancel({ pid: id, runId: currentRunId });
      // 真正的状态清理走 run.cancelled WS 事件（SDK abort 后端会 emit）
      // 这里只触发请求；UI 立即响应：currentRunId 暂不清，等事件回
    } catch (err) {
      if (err.code === 'RUN_NOT_ACTIVE') {
        // run 已结束（race：用户点的瞬间 agent 自然完成）
        setCurrentRunId(null);
        setActiveRun(null);
        useGlobalStore.getState().clearPlanForApproval();  // Phase 3.2：run 终止时清残留 plan 卡
        setIsStreaming(false);
      } else {
        showToast(`取消失败：${err.message}`, 'error');
      }
    }
  };

  /**
   * 流 B：附件入托盘。File → 立即 push pending 占位 → Assets.upload → 拿到 path 后 patch
   * 失败：标记 error，留在托盘里让用户决定（删 / 重传）。
   *
   * 兼容：旧路径（InputsTab 的 handlePasteUrl / handleConnectRepo）传 metadata 对象，
   * 不是 File；直接 push 到托盘。这些 P0 不真发给 agent（attachments filter 只取
   * type=asset+path），P0+ 接通 URL ingest 时再扩展。
   */
  const handleAddInput = async (input) => {
    // metadata 对象（URL / repo）走原路径
    if (!(input instanceof File)) {
      setInputs(arr => [...arr, input]);
      return;
    }
    const tempId = newId('asset');
    setInputs(arr => [...arr, {
      id: tempId,
      type: 'asset',
      name: input.name,
      size: input.size,
      mime: input.type,
      // path: undefined → 渲染为 uploading
    }]);
    try {
      const { asset } = await Assets.upload(id, input);
      setInputs(arr => arr.map(it => it.id === tempId
        ? { ...it, path: asset.path, size: asset.size, name: asset.name, mime: asset.mime }
        : it,
      ));
    } catch (err) {
      setInputs(arr => arr.map(it => it.id === tempId
        ? { ...it, error: err.message }
        : it,
      ));
      showToast(`上传失败：${err.message}`, 'error');
    }
  };
  const handleRemoveInput = (assetId) => setInputs(arr => arr.filter(a => a.id !== assetId));

  /**
   * 流 E direct edit：bridge 在 blur 时已清 contentEditable=false（见 DirectEditBridge
   * cleanup() 在 onTextEdit 回调之前），此时 iframeDoc 是用户改过的最新最干净状态。
   *
   * 序列化整页 outerHTML（前缀 <!doctype html> 避免 doctype 丢失）→ PUT /canvas。
   * 不 bump reloadToken — iframe DOM 已经是最新，重 fetch 反而会闪一下还会丢用户操作焦点。
   */
  const handleTextEdit = async (info) => {
    setPatches(arr => [...arr, {
      id: newId('patch'),
      type: 'text-edit',
      anchor: info.anchor,
      oldValue: info.oldText,
      newValue: info.newText,
      ts: new Date().toISOString(),
    }]);
    if (!iframeDoc) {
      showToast('iframe 未就绪', 'error');
      return;
    }
    try {
      const html = '<!doctype html>\n' + iframeDoc.documentElement.outerHTML;
      if (!currentSessionId) {
        showToast('请先开始一个会话再编辑 canvas', 'error');
        return;
      }
      await Canvas.write(id, currentSessionId, html, 'user');
      showToast(`已保存：「${info.newText.slice(0, 20)}」`, 'success');

      // C4：push 进 pending-changes buffer，下次发 chat 时 agent 主动拉
      try {
        const el = findElementByAnchor(info.anchor, iframeDoc.body);
        const aiContext = el ? serializeForAI(el) : null;
        await PendingChanges.push(id, currentSessionId, {
          kind: 'edit',
          anchor: info.anchor,
          aiContext,
          diff: { oldText: info.oldText, newText: info.newText },
        });
      } catch (err) {
        // buffer push 失败不影响主流程（落盘已成功）
        console.warn('[pending-changes] push edit failed:', err.message);
      }
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    }
  };

  // C3 起：InspectFloatingCard 内嵌 textarea 直接传 ctx.text；老调用兼容 prompt
  const handleAddComment = async (ctx) => {
    let text = ctx?.text && ctx.text.trim();
    if (!text) {
      text = await prompt({
        title: '元素评论',
        message: '之后 AI 会按这条评论改它',
        placeholder: '描述要改的样子……',
        multiline: true,
      });
    }
    if (!text || !text.trim()) return;
    const trimmed = text.trim();
    setComments(arr => [...arr, {
      id: newId('cmt'),
      anchor: ctx.anchor,
      aiContext: ctx.aiContext,
      text: trimmed,
      status: 'open',
      createdAt: new Date().toISOString(),
    }]);
    // C4：push 进 pending-changes buffer
    if (currentSessionId) {
      try {
        await PendingChanges.push(id, currentSessionId, {
          kind: 'comment',
          anchor: ctx.anchor,
          aiContext: ctx.aiContext,
          text: trimmed,
        });
      } catch (err) {
        console.warn('[pending-changes] push comment failed:', err.message);
      }
    }
  };
  const handleJumpToComment = (comment) => {
    if (!iframeDoc) return;
    const el = findElementByAnchor(comment.anchor, iframeDoc.body);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setSelectedAnchor(comment.anchor);
    } else {
      showToast('元素已不存在', 'error');
    }
  };
  const handleResolveComment = (cid) => {
    setComments(arr => arr.map(c =>
      c.id === cid ? { ...c, status: c.status === 'resolved' ? 'open' : 'resolved' } : c,
    ));
  };
  const handleDeleteComment = (cid) => {
    setComments(arr => arr.filter(c => c.id !== cid));
  };
  const handleDirectEdit = (ctx) => {
    setDirectEditAnchor(ctx.anchor);
    setDirectEditOpen(true);
  };
  const handleApplyDirectEdit = ({ anchor, changes }) => {
    setPatches(arr => [...arr, {
      id: newId('patch'),
      type: 'attr',
      anchor,
      changes,
      ts: new Date().toISOString(),
    }]);
    showToast(`已应用（P0 中：D 流真接留 P0+）`, 'info');
  };
  const handleTriggerRun = (ctx) => {
    const ai = ctx.aiContext;
    const tag = ai?.tag || 'element';
    const pageInfo = ai?.pageInfo;
    const pagePart = pageInfo?.index != null ? `第 ${pageInfo.index + 1} 页` : '';
    const draft = `针对 ${pagePart}的 <${tag}>：\n\n…`;
    setChatDraft(draft);
    showToast('已填回对话框，编辑后发送', 'info');
  };

  // ── 顶栏 actions（async store ops）──
  const handleRename = async () => {
    setActionsOpen(false);
    const next = await prompt({
      title: '重命名项目',
      initialValue: project.name,
      placeholder: '项目名',
      validate: (v) => v.trim() ? null : '不能为空',
    });
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };
  const handleDuplicate = async () => {
    setActionsOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) {
        showToast(`已复制为「${copy.name}」（P0 简版：新建空项目，没复制 canvas）`, 'success');
        navigate(`/projects/${copy.id}`);
      }
    } catch (err) {
      showToast(`复制失败：${err.message}`, 'error');
    }
  };
  const handleDelete = async () => {
    setActionsOpen(false);
    if (!(await confirm({
      title: '删除项目',
      message: `删除「${project.name}」？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await deleteProject(project.id);
      showToast('项目已删除', 'info');
      navigate('/');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };
  const handleViewCode = () => {
    setActionsOpen(false);
    console.log('[spec mock]', deckSpec);
    showToast('spec mock 已 console.log（真 spec.json 在 workspace）', 'info');
  };

  // ── snapshot / candidate handlers（P0 占位，noop）──
  const handleSaveSnapshotQuick = () => {
    setActionsOpen(false);
    showToast('快照 = git history（P0 用 git，UI 入口 C9 加）', 'info');
  };
  const handleOpenSnapshots = () => {
    setActionsOpen(false);
    setSnapshotOpen(true);
  };
  const handleSnapshotSave = () => showToast('P0+：用 git history 取代', 'info');
  const handleSnapshotRestore = () => showToast('P0+：git checkout', 'info');
  const handleSnapshotDelete = () => {};
  const handleSnapshotRename = () => {};

  const handleAddCandidate = () => showToast('P0+：candidate 由 agent fork_variant 主动开', 'info');
  const handleRemoveCandidate = () => {};
  const handleRenameCandidate = () => {};
  const handleSelectCandidate = () => setSelectedAnchor(null);

  /**
   * 流 I 导出（用户主动按钮）：调 GET /api/projects/:pid/exports/:format
   * → blob → a.click() 触发浏览器下载
   * filename 从 content-disposition 解析；解析失败退化为 <project-name>.<ext>
   */
  const handleExport = async (format) => {
    try {
      if (!currentSessionId) {
        showToast('请先选中一个会话再导出', 'error');
        return;
      }
      const { blob, filename } = await Exports.download(id, currentSessionId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename
        || `${project.name || 'design'}.${format === 'handoff' ? 'zip' : format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`已下载：${a.download}`, 'success');
    } catch (err) {
      showToast(`导出失败：${err.message}`, 'error');
    }
  };

  return (
    <PanelManagerProvider projectId={id} defaultPanels={defaultPanels} panelMeta={panelMeta}>
    <AppShell
      breadcrumb={[
        { label: '项目', to: '/' },
        { label: project.name, to: `/projects/${id}` },
        { label: currentSessionTitle || '新会话' },
      ]}
      actions={
        <>
          {(systemInfo || contextUsage) && (
            <ContextUsageBar info={systemInfo} liveUsage={contextUsage} />
          )}
          {/* UndoButton (git checkout) 已砍（2026-05-07）—— SDK rewindFiles 通过
              对话里"回到此处"覆盖所有 undo 场景（含历史 session resume 链路）。
              git undo 不再必要，且语义跟对话里的精确 undo 重叠混淆。 */}
          <button style={iconBtnStyle} onClick={() => setShareOpen(true)}>
            <Share2 size={13} /> 分享
          </button>
          <div style={{ position: 'relative' }}>
            <button
              ref={exportBtnRef}
              style={primaryBtnStyle}
              onClick={() => { setExportOpen(v => !v); setActionsOpen(false); }}
            >
              <Download size={13} /> 导出
            </button>
            <ExportMenu
              open={exportOpen}
              onClose={() => setExportOpen(false)}
              onExport={handleExport}
              onOpenList={() => setExportsListOpen(true)}
              anchorRef={exportBtnRef}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <button
              ref={actionsBtnRef}
              style={iconBtnStyle}
              onClick={() => { setActionsOpen(v => !v); setExportOpen(false); }}
            >
              <MoreHorizontal size={14} />
            </button>
            <ProjectActionsMenu
              open={actionsOpen}
              onClose={() => setActionsOpen(false)}
              anchorRef={actionsBtnRef}
              onRename={handleRename}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onSaveSnapshot={handleSaveSnapshotQuick}
              onOpenSnapshots={handleOpenSnapshots}
              snapshotCount={(project.snapshots || []).length}
              onViewCode={handleViewCode}
              isQuickProject={project.kind === 'quick'}
              onUpgrade={() => { setActionsOpen(false); setUpgradeOpen(true); }}
            />
          </div>
        </>
      }
    >
      {/* 主区两栏：左 ChatPanel 固定 + 右 Canvas section（占满 + 浮窗叠加） */}
      {/* AppShell children 包装层是普通 div（非 flex），用 height:100% 拿满 */}
      <div style={{
        height: '100%', display: 'flex', minHeight: 0,
        background: STAGE.bg,
        overflow: 'hidden',
      }}>
        {/* 左栏 chat 固定 */}
        <aside style={{
          width: 360, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: '#fff',
          borderRight: `1px solid ${COLOR.border}`,
          minHeight: 0,
        }}>
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            isStreaming={isStreaming}
            queueDepth={queueDepth}
            wsStatus={wsStatus}
            stuckSeconds={stuckSeconds}
            trayItems={inputs}
            onRemoveTrayItem={handleRemoveInput}
            onPickFile={handleAddInput}
            promptSuggestion={promptSuggestion}
            onDismissSuggestion={() => setPromptSuggestion(null)}
            agentProgress={agentProgress}
            onStop={currentRunId ? handleStop : null}
            todos={todos}
            sessionTitle={currentSessionTitle}
            onOpenSessionList={() => setSessionListOpen(true)}
            onCloseSession={handleCloseSession}
            hasActiveSession={!!currentSessionId}
            projectId={id}
            sessionId={currentSessionId}
            onCanvasReload={() => setReloadToken(t => t + 1)}
          />
        </aside>

        {/* 右主区：CanvasFrame 占满（边到边，无 padding 卡片）+ 5 浮窗叠加 */}
        {/* bounds='parent' 限制浮窗在此 section 内，不跑屏外、不跑到 chat 上 */}
        <section style={{
          flex: 1, minWidth: 0,
          position: 'relative',
          display: 'flex', flexDirection: 'column',
          background: '#fff',
        }}>
          <CanvasFrame
            htmlSrc={currentSessionId ? Canvas.artifactUrl(id, currentSessionId, reloadToken) : null}
            selectedAnchor={selectedAnchor}
            onSelectChange={setSelectedAnchor}
            onTextEdit={handleTextEdit}
            onIframeReady={handleIframeReady}
            candidates={project.candidates || []}
            activeCandidateId={project.activeCandidateId}
            onSelectCandidate={handleSelectCandidate}
            onAddCandidate={handleAddCandidate}
            onRemoveCandidate={handleRemoveCandidate}
            onRenameCandidate={handleRenameCandidate}
            project={project}
            deckSpec={deckSpec}
            projectId={id}
            sessionId={currentSessionId}
            decisionsReloadKey={decisionsReloadKey}
            comments={comments}
            onAddComment={handleAddComment}
            onResolveComment={handleResolveComment}
            onDeleteComment={handleDeleteComment}
            onDirectEdit={handleDirectEdit}
            onTriggerRun={handleTriggerRun}
            tweaksAvailable={isTweaksExposed}
          />

          {/* 浮窗层 —— bounds='parent' = 不出 canvas section
              C3：inspect / comments 删 — 改用 InspectFloatingCard（CanvasFrame 内贴选中元素） */}
          <FloatingPanel id="tweaks" title="Tweaks" icon={Sliders} bodyStyle={{ padding: 0 }}>
            <TweaksPanel
              projectId={id}
              sessionId={currentSessionId}
              iframeDoc={iframeDoc}
              reloadKey={tweaksReloadKey}
              onChat={handleSend}
            />
          </FloatingPanel>
        </section>
      </div>

      <ShareModal show={shareOpen} onClose={() => setShareOpen(false)} project={project} />
      <ExportsListModal
        show={exportsListOpen}
        onClose={() => setExportsListOpen(false)}
        projectId={id}
        sessionId={currentSessionId}
      />
      <SnapshotModal
        show={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
        project={project}
        onSave={handleSnapshotSave}
        onRestore={handleSnapshotRestore}
        onDelete={handleSnapshotDelete}
        onRename={handleSnapshotRename}
      />
      <DirectEditModal
        show={directEditOpen}
        onClose={() => setDirectEditOpen(false)}
        anchor={directEditAnchor}
        iframeDoc={iframeDoc}
        onApply={handleApplyDirectEdit}
      />
      <SessionListModal
        show={sessionListOpen}
        onClose={() => setSessionListOpen(false)}
        projectId={id}
        currentSessionId={currentSessionId}
        onSwitch={(sid) => {
          // H1：切换 session 走 URL navigate（URL 是 sid 唯一 source of
          // truth），useEffect 会自动重 hydrate messages。
          // sid=null → 新会话路径 /work；有 sid → /sessions/<sid>
          navigate(sid ? `/projects/${id}/sessions/${sid}` : `/projects/${id}/work`);
        }}
      />
      {elicitRequest && (
        <ElicitationModal
          projectId={id}
          request={elicitRequest}
          onClose={() => setElicitRequest(null)}
        />
      )}
      <UpgradeQuickModal
        show={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        project={project}
        onUpgraded={(updated) => {
          showToast(`已升级为标准项目「${updated.name}」`, 'success');
        }}
      />
      <PlanReviewCard />
      <PlanRequestBanner />

    </AppShell>
    </PanelManagerProvider>
  );
}

// ── helpers ──

/**
 * 同 role 连续 text delta 累加为一条消息；否则 push 新消息。
 * thinking 自带 isStreaming=true（用于尾部光标）；非 thinking 内容产生时
 * 自动关掉之前所有 thinking 的 isStreaming 标记（那段思考已经结束了）。
 */
function appendTextDelta(messages, role, text, runId) {
  if (!text) return messages;
  const cleared = role === 'thinking' ? messages : clearThinkingStreaming(messages);
  const last = cleared[cleared.length - 1];
  // Phase A.5（2026-05-07）：merge 时加 runId 匹配检查 — 防 cross-turn 粘连
  // 老逻辑：last.role === role 就 merge → 上一 turn 的 assistant text 会跟当前 turn
  // 第一段 delta 粘到一起。新逻辑：role 同 + runId 同（或都没 runId）才 merge，
  // 否则 push 新消息让两个 turn 自然分隔。
  if (
    last
    && last.role === role
    && (!runId || !last.runId || last.runId === runId)
  ) {
    const merged = { ...last, content: (last.content || '') + text };
    if (role === 'thinking') merged.isStreaming = true;
    // runId 用第一次创建时的（同一段连续 delta 共享一个 turn 的 runId）；若 last 还没 runId 而新 delta 带了，补上
    if (runId && !last.runId) merged.runId = runId;
    return [...cleared.slice(0, -1), merged];
  }
  const created = { id: newId('msg'), role, content: text };
  if (role === 'thinking') created.isStreaming = true;
  if (runId) created.runId = runId;  // 用于 delta merge 时判断同一 turn 边界
  return [...cleared, created];
}

/** 关掉所有 thinking 消息的流式光标（run 结束 / 切到非 thinking 内容时调）*/
function clearThinkingStreaming(messages) {
  let changed = false;
  const next = messages.map(m => {
    if (m.role === 'thinking' && m.isStreaming) {
      changed = true;
      return { ...m, isStreaming: false };
    }
    return m;
  });
  return changed ? next : messages;
}

/** 工具错误对象 → 用户可读字符串 */
function formatToolError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** SDK notification priority → toast kind */
function mapNotificationKind(priority) {
  if (priority === 'error' || priority === 'high') return 'error';
  if (priority === 'success') return 'success';
  return 'info';
}

function NotFound({ id, error }) {
  return (
    <AppShell breadcrumb={[{ label: '未找到' }]}>
      <div style={{
        maxWidth: 600, margin: '0 auto', padding: `${GAP.page * 2}px ${GAP.page}px`,
        textAlign: 'center',
      }}>
        <h1 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
          color: COLOR.text, marginBottom: GAP.lg,
        }}>项目 <code style={{ color: COLOR.error }}>{id}</code> 不存在</h1>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, color: COLOR.sub, marginBottom: GAP.xl }}>
          {error || '可能 ID 写错了，或这个项目已被删除。'}
        </p>
        <Link to="/" style={{
          display: 'inline-block',
          padding: `${GAP.md}px ${GAP.xl}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
          color: COLOR.btnText, background: COLOR.btn,
          borderRadius: 8,
        }}>返回首页</Link>
      </div>
    </AppShell>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  background: 'rgba(0,0,0,0.04)',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: 6,
  cursor: 'pointer',
};
