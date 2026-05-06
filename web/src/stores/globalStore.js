import { create } from 'zustand';

/**
 * 全局轻量状态（toast / modal / 跨组件共享的 UI 状态）
 *
 * 项目级状态（messages / spec / html / comments / inputs / runStatus）
 * 不放这里——走每个 /projects/:id 内的 useReducer + Context。
 */
export const useGlobalStore = create((set) => ({
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

  // ── Phase 3.2：plan-mode toggle ──
  // ChatComposer 旁边的 segmented control "快速做 / 深度对齐"。开 plan-mode
  // 时下次 turn 会走 SDK 原生 plan mode（permissionMode='plan' + ExitPlanMode 流程）。
  // toggle 持久化到 localStorage（用户偏好），单 session 内保持。
  planModeEnabled: (() => {
    try { return localStorage.getItem('nodesign:planMode') === '1'; } catch { return false; }
  })(),
  setPlanModeEnabled: (enabled) => {
    try { localStorage.setItem('nodesign:planMode', enabled ? '1' : '0'); } catch { /* ignore */ }
    set({ planModeEnabled: enabled });
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

  // ── Phase B 批次 6：TimelineGroup 折叠标题（haiku 总结）──
  // Stop hook 调 summarizeForTimeline 用 last_assistant_message 出 12 字标题
  // → emit run.timeline_summary { runId, summary }，存这里。
  // TimelineGroup 用 group 首条 message 的 runId 查表显示。
  // 不分 project（runId 全局唯一足够），上限 200 条 LRU 防膨胀。
  timelineSummaries: {},  // { [runId]: summary }
  setTimelineSummary: (runId, summary) => set((s) => {
    if (!runId || !summary) return s;
    const next = { ...s.timelineSummaries, [runId]: summary };
    // 简单 LRU：超 200 条删最早 50 条
    const keys = Object.keys(next);
    if (keys.length > 200) {
      const remove = keys.slice(0, 50);
      remove.forEach(k => delete next[k]);
    }
    return { timelineSummaries: next };
  }),

  // ── 模拟登录态（MVP 单用户）──
  user: { id: 'u_self', name: '我', avatar: null },
}));
