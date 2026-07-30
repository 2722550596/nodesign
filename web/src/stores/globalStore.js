import { create } from 'zustand';

/**
 * 全局轻量状态（toast / modal / 跨组件共享的 UI 状态）
 *
 * 项目级状态（messages / spec / html / comments / inputs / runStatus）
 * 不放这里——走每个 /projects/:id 内的 useReducer + Context。
 */
export const useGlobalStore = create((set) => ({
  // ── 当前登录用户（2026-07-30 多用户内测）──
  // AuthGate 登录/status 后写入；{ id, username, role } | null（登录墙关闭时 null）
  authUser: null,
  setAuthUser: (u) => set({ authUser: u }),

  // ── Toast ──
  toasts: [],
  showToast: (msg, kind = 'info') => set((s) => ({
    toasts: [...s.toasts, { id: Date.now() + Math.random(), msg, kind }],
  })),
  dismissToast: (id) => set((s) => ({
    toasts: s.toasts.filter(t => t.id !== id),
  })),

  // ── Canvas mode（Edit / Preview / Code） ──
  canvasMode: 'edit',
  setCanvasMode: (m) => set({ canvasMode: m }),

  // ── 选中元素锚点（评论 / 直改 / 未来 CAD 共享）──
  selectedAnchor: null,
  setSelectedAnchor: (a) => set({ selectedAnchor: a }),

  // ── Chat draft（让 Inspect "触发新 run" 把元素意图填回 ChatComposer）──
  chatDraft: '',
  setChatDraft: (s) => set({ chatDraft: s }),
  consumeChatDraft: () => {
    const draft = useGlobalStore.getState().chatDraft;
    set({ chatDraft: '' });
    return draft;
  },

  // ── A4：当前活跃 run 上下文 ──
  // AskUserQuestionView 直接 POST /answer 时需要 pid + runId。挂全局
  // 避免 prop drilling 穿过 ChatPanel → MessageList → Message → AskUserQuestionView。
  // ProjectWorkspace 在 run.start 时 setActiveRun({ pid, runId })，
  // run.done/error/cancelled 时 setActiveRun(null)。
  activeRun: null,
  setActiveRun: (activeRun) => set({ activeRun }),

  // ── Phase 3.2：SDK 原生 plan mode 审批 ──
  // run.plan_for_approval 事件 → 设 planForApproval state → ProjectWorkspace
  // 渲染 <PlanReviewCard />。用户 approve/reject 后调 Plan.approve/reject API
  // 然后清空 state。
  planForApproval: null,  // { toolUseId, plan }
  setPlanForApproval: (planForApproval) => set({ planForApproval }),
  clearPlanForApproval: () => set({ planForApproval: null }),

  // ── Phase C：agent 主动请求进 plan mode ──
  // run.plan_mode_requested 事件（agent 调 mcp__nodesign__request_plan_mode）→
  // ProjectWorkspace 设这个 state → 渲染 <PlanRequestBanner />。
  // 用户 yes → Plan.grantViaPermissionMode → SDK 切 plan → agent 自然进 ExitPlanMode 流程
  // （之后会触发 run.plan_for_approval，PlanReviewCard 接力）
  // 用户 no → 单纯清掉 state 不发请求（agent 已被告知"无 mode 通知就继续"）
  planModeRequest: null,  // { reason, estimatedPages?, taskKind?, ts }
  setPlanModeRequest: (r) => set({ planModeRequest: r ? { ...r, ts: Date.now() } : null }),
  clearPlanModeRequest: () => set({ planModeRequest: null }),

  // 注：pendingImageApproval state 已删除（2026-05-06）—— 见 ImageApprovalBanner 移除说明。

  // 注：planModeEnabled（「深度对齐」toggle）已删除（2026-07-30）。plan mode 只剩
  // agent 自己发起那条路：request_plan_mode → PlanRequestBanner → 用户同意 →
  // Plan.grantViaPermissionMode 切 SDK mode。手动开关连 localStorage 一起删掉了 ——
  // 留着状态但没有 UI 关它，等于给开过的人留一个永久开启的 plan mode。

  // ── 模型选择（2026-07-29）──
  // Composer 里的 picker。选择随每条消息的 body.model 下发，服务端写进
  // session-config.json（模型的唯一真相源）并在会话空闲时重启 query 以生效。
  // null = 跟随服务端默认（NODESIGN_MODEL）。localStorage 持久化，跨会话沿用。
  modelPref: (() => {
    try { return localStorage.getItem('nodesign:modelPref') || null; } catch { return null; }
  })(),
  setModelPref: (model) => {
    try {
      if (model) localStorage.setItem('nodesign:modelPref', model);
      else localStorage.removeItem('nodesign:modelPref');
    } catch { /* ignore */ }
    set({ modelPref: model || null });
  },

  // ── Phase B 批次 3：用户主动 recall project memory 到下一轮 chat ──
  // MemoryCard 点"📎 加到下条消息"会 push 一项到这里；ChatComposer 提交时
  // pendingMemoryRecalls 拼到 chat 字段头部（<memory-recall> 包裹），
  // 跟随 user message 一起发给 SDK。提交成功后 store 清空。
  // shape: [{ agentType, content, ts }]
  pendingMemoryRecalls: [],
  addPendingMemoryRecall: (recall) => set((s) => ({
    pendingMemoryRecalls: [...s.pendingMemoryRecalls, { ...recall, ts: Date.now() }],
  })),
  removePendingMemoryRecall: (idx) => set((s) => ({
    pendingMemoryRecalls: s.pendingMemoryRecalls.filter((_, i) => i !== idx),
  })),
  consumePendingMemoryRecalls: () => {
    const recalls = useGlobalStore.getState().pendingMemoryRecalls;
    set({ pendingMemoryRecalls: [] });
    return recalls;
  },

  // ── Phase B 批次 3：SDK 自动 recall 历史（per-project）──
  // run.memory_recall 事件 → append 到对应 project 的历史。MemoryCard 顶部
  // "最近自动召回"折叠区渲染。重启 server 后清空（in-memory）。
  // shape: { [projectId]: [{ mode, memories, ts }] }
  recallHistoryByProject: {},
  appendRecallHistory: (projectId, entry) => set((s) => {
    if (!projectId) return s;
    const cur = s.recallHistoryByProject[projectId] || [];
    // 上限 50 条避免无限堆积
    const next = [{ ...entry, ts: entry.ts || Date.now() }, ...cur].slice(0, 50);
    return { recallHistoryByProject: { ...s.recallHistoryByProject, [projectId]: next } };
  }),

  // ── 站内 Confirm / Prompt 对话框（替代 window.confirm / window.prompt）──
  // 命令式 Promise API：调用方 `await confirm({ message })` 拿 boolean，
  // `await prompt({ initialValue })` 拿 string|null。
  // 实际 UI 由 <GlobalDialogs /> 在根挂载，监听这两个 state 渲染 ConfirmDialog/PromptDialog。
  // resolve 在用户点确认/取消时被调，随后清掉 state。
  confirmDialog: null,
  promptDialog: null,
  confirm: ({ title = '确认', message = '', confirmLabel = '确认', cancelLabel = '取消', danger = false } = {}) =>
    new Promise((resolve) => {
      // 同时只允许一个 confirm 弹窗——若上一个未关，先 resolve(false) 再起新的
      const prev = useGlobalStore.getState().confirmDialog;
      if (prev?.resolve) prev.resolve(false);
      useGlobalStore.setState({
        confirmDialog: { title, message, confirmLabel, cancelLabel, danger, resolve },
      });
    }),
  prompt: ({ title = '请输入', message = '', initialValue = '', placeholder = '', confirmLabel = '确认', cancelLabel = '取消', validate, multiline = false } = {}) =>
    new Promise((resolve) => {
      const prev = useGlobalStore.getState().promptDialog;
      if (prev?.resolve) prev.resolve(null);
      useGlobalStore.setState({
        promptDialog: { title, message, initialValue, placeholder, confirmLabel, cancelLabel, validate, multiline, resolve },
      });
    }),
  closeConfirmDialog: (result) => set((s) => {
    if (s.confirmDialog?.resolve) s.confirmDialog.resolve(result);
    return { confirmDialog: null };
  }),
  closePromptDialog: (result) => set((s) => {
    if (s.promptDialog?.resolve) s.promptDialog.resolve(result);
    return { promptDialog: null };
  }),

  // ── 模拟登录态（MVP 单用户）──
  user: { id: 'u_self', name: '我', avatar: null },
}));
