/**
 * web/src/lib/api.js — REST 客户端薄包装
 *
 * 走 vite proxy（dev）/ 同源（prod），所有路径以 /api 开头。
 * 失败统一抛 Error（含 status / code）。
 *
 * 模块：Projects / Skills / Canvas / Assets / Exports / Turn / Health
 */

async function jsonRequest(method, path, body, opts = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 204 No Content
  if (res.status === 204) return null;

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// ── Projects ──
export const Projects = {
  /** 列项目；kind 选填 'project' / 'quick' 过滤 */
  list: ({ kind } = {}) => {
    const tail = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return jsonRequest('GET', `/api/projects${tail}`);
  },
  get: (pid) => jsonRequest('GET', `/api/projects/${pid}`),
  /** create：name 必填；description / kind 可选（kind 默认 'project'） */
  create: ({ name, skillId, description, kind, autoNamed }) =>
    jsonRequest('POST', '/api/projects', { name, skillId, description, kind, autoNamed }),
  update: (pid, patch) => jsonRequest('PATCH', `/api/projects/${pid}`, patch),
  remove: (pid) => jsonRequest('DELETE', `/api/projects/${pid}`),
};

// ── Skills ──
export const Skills = {
  list: (projectId) =>
    jsonRequest('GET', `/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
};

// ── Canvas（H3：session-scoped）──
export const Canvas = {
  read: async (pid, sid) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/canvas`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return res.text();
  },
  // path：任务 deck 是 tasks/<任务>/canvas.html；不传写会话自己的 canvas.html
  write: (pid, sid, html, source = 'user', deckPath = null) =>
    jsonRequest('PUT', `/api/projects/${pid}/sessions/${sid}/canvas`, { html, source, ...(deckPath ? { path: deckPath } : {}) }),
  history: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/canvas/history`),
  revert: (pid, sid, commit) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/canvas/revert`, { commit }),
  // Canvas.undo (git checkout 上一个 commit) 已砍 (2026-05-07) — SDK rewindFiles
  // 通过对话里"回到此处"覆盖所有场景（含历史 session resume 链路）。后端 endpoint
  // 留着不删但无前端调用。
  /** iframe src 用 — sid 必传 */
  artifactUrl: (pid, sid, version) =>
    `/api/projects/${pid}/sessions/${sid}/canvas${version ? `?v=${encodeURIComponent(version)}` : ''}`,
  /** deck 比例信息（前端缩略图按比例设容器尺寸 + iframe size 用） */
  deckMeta: (pid, sid, deckPath = null) =>
    jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/canvas/deck-meta${deckPath ? `?path=${encodeURIComponent(deckPath)}` : ''}`),
};

// ── Spec（设计意图档案，session-scoped）──
export const Spec = {
  read: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/spec`),
};

// ── SessionConfig（用户/前端拥有的 session 配置，区别于 agent 私域 spec.json）──
// 字段：tweaks_mode_enabled
export const SessionConfig = {
  read: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/config`),
  patch: (pid, sid, patch) => jsonRequest('PATCH', `/api/projects/${pid}/sessions/${sid}/config`, patch),
};

// ── Plan（Phase 3.2：SDK 原生 plan mode 审批流）──
// 用户在 PlanReviewCard 点按钮 → approve 切 SDK permissionMode='default'；
// reject 走 cancelRun 中断
export const Plan = {
  approve: ({ pid, runId, toolUseId, editedPlan }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/plan-approve`,
      { ...(toolUseId ? { toolUseId } : {}), ...(editedPlan !== undefined ? { editedPlan } : {}) }),
  reject: ({ pid, runId, toolUseId, reason }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/plan-reject`,
      { ...(toolUseId ? { toolUseId } : {}), ...(reason ? { reason } : {}) }),
  // Phase C：agent 调 mcp__nodesign__request_plan_mode → 前端 PlanRequestBanner
  // 用户点 yes → 调通用 /permission-mode 切到 plan；no 时纯前端 dismiss 不触发后端。
  // 也用于 ChatComposer 手动 toggle on/off 时同步当前活跃 query 的 permissionMode
  // （toggle off 时 mode='bypassPermissions' 让 agent 立即脱出 plan mode）。
  grantViaPermissionMode: ({ pid, runId, mode = 'plan' }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/permission-mode`,
      { mode }),
  // Phase C 阻塞态 plan-request：解阻塞 mcp__nodesign__request_plan_mode。
  // 用户在 PlanRequestBanner 决定后调（approve 完会先调 grantViaPermissionMode 再调这个）。
  decidePlanRequest: ({ pid, runId, toolUseId, approved }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/plan-request/${toolUseId}/decide`,
      { approved }),
};

// 注：Image.approve / regenerate / dismiss 已删除（2026-05-06）。原配 ImageApprovalBanner
// 走 /image-approval endpoint，但 emit 即返不阻塞 agent 形同装饰。改为 generate_image
// 已返 image content block 由前端 chat 自动渲染，agent caption 邀请反馈，下一轮 chat 即 gate。

// Phase B 批次 4：MCP Elicitation —— 工具调 server.elicitInput() 时前端弹 modal 收答案
export const Elicit = {
  /** body: { action: 'accept'|'decline'|'cancel', content?: object } */
  answer: ({ pid, runId, reqId, action, content }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/elicit/${reqId}/answer`,
      { action, content }),
};

// ── PendingChanges（C4：用户直接编辑 + 评论 buffer，session-scoped）──
// 前端 push edit / comment item，下次发 chat 时 turn.js 在 user message 前
// prepend system 提示 → agent 主动调 mcp__nodesign__get_pending_changes 拉详情。
export const PendingChanges = {
  list: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/pending-changes`),
  push: (pid, sid, item) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/pending-changes`, item),
  clear: (pid, sid, ids) => {
    const qs = Array.isArray(ids) && ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
    return jsonRequest('DELETE', `/api/projects/${pid}/sessions/${sid}/pending-changes${qs}`);
  },
};

// ── Assets（project 共享，写到 shared/assets/）──
export const Assets = {
  upload: async (pid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/projects/${pid}/assets`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return res.json();
  },
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/assets`),
  remove: (pid, filename) =>
    jsonRequest('DELETE', `/api/projects/${pid}/assets/${encodeURIComponent(filename)}`),

  // ── 工作台产物墙（2026-07-27 v1）──
  /** 产物清单（project 级：上传素材 + generated 生成图 + 便签） */
  artifacts: (pid) => jsonRequest('GET', `/api/projects/${pid}/artifacts`),
  /** 新建灵感便签 → shared/assets/notes/<ts>-<slug>.md */
  createNote: (pid, { text, title, sessionId } = {}) =>
    jsonRequest('POST', `/api/projects/${pid}/notes`, { text, title, sessionId }),
  /** 删便签 */
  removeNote: (pid, filename) =>
    jsonRequest('DELETE', `/api/projects/${pid}/notes/${encodeURIComponent(filename)}`),
  /** 画布布局（空间画布，含 zones 分区）*/
  getBoard: (pid) => jsonRequest('GET', `/api/projects/${pid}/board`),
  putBoard: (pid, board) => jsonRequest('PUT', `/api/projects/${pid}/board`, { board }),
  /** diff 合并写：{ size?, objects?: {id: obj|null}, zones?: {id: zone|null} }，null=删 */
  patchBoard: (pid, patch) => jsonRequest('PATCH', `/api/projects/${pid}/board`, { patch }),
  /**
   * 产物文件 URL（project 级，不依赖 session）。
   * relPath 是 artifacts 返回的 agent 视角路径（'assets/...'），
   * artifact-file 路由根=shared/（2026-07-28 任务模型起），路径必须带
   * 'assets/' 或 'tasks/' 前缀原样传递（server 兼容旧的无前缀形态）。
   */
  artifactFileUrl: (pid, relPath) => {
    const sub = String(relPath || '');
    return `/api/projects/${pid}/artifact-file/${sub.split('/').map(encodeURIComponent).join('/')}`;
  },
  /** 删任务文件夹 —— 连它绑定的会话一起删（一对一，不独立存在）*/
  removeTask: (pid, name) =>
    jsonRequest('DELETE', `/api/projects/${pid}/tasks/${encodeURIComponent(name)}`),
};

// ── Exports（H3：session-scoped）──
export const Exports = {
  /** 当前任务里可以单独导出的东西（deck / 图 / 其它产物）*/
  items: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/exports/items`),

  /** 挑几样下载：单个原样、多个打 zip。返回 { blob, filename } */
  pick: async (pid, sid, paths, filename) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/exports/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, filename }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    return { blob: await res.blob(), filename: parseFilenameFromDisposition(res.headers.get('content-disposition')) };
  },

  /** 下载文件，返回 { blob, filename }，调用方自行触发 a.click() */
  download: async (pid, sid, format) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/exports/${format}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    const filename = parseFilenameFromDisposition(res.headers.get('content-disposition'));
    return { blob, filename };
  },

  list: (pid, sid) => jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}/exports`),

  downloadFile: async (pid, sid, filename) => {
    const res = await fetch(`/api/projects/${pid}/sessions/${sid}/exports/file/${encodeURIComponent(filename)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    }
    const blob = await res.blob();
    return { blob, filename };
  },
};

function parseFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  if (m) return decodeURIComponent(m[1].replace(/^"|"$/g, ''));
  const m2 = /filename="([^"]+)"/.exec(disposition);
  return m2 ? m2[1] : null;
}

// ── Turn（唯一 LLM 入口）──
export const Turn = {
  /**
   * body: { chat, attachments[], skillId?, sessionId?, permissionMode? } → { runId }
   * sessionId:
   *   - 不传 → 后端 fallback project.activeSessionId（向后兼容）
   *   - 显式 string → 续约该 session（前端切换 session 走这条）
   *   - 显式 null → 新建 session（用户点"+ 新会话"后第一次发）
   * permissionMode（Phase 3.2）：
   *   - 'plan' → 启用 SDK 原生 plan mode（read-only + ExitPlanMode 审批流）
   *   - 其他/不传 → 默认 bypassPermissions
   */
  send: async ({ pid, chat, attachments = [], skillId, sessionId, permissionMode, requestId, raw }) => {
    // Phase A.6（2026-05-07）：requestId 幂等防重发。
    // 弱网下用户可能点两次发送或 fetch 超时自动重试。后端 LRU 同 requestId 直接返
    // 已存在的 { runId, sessionId } 不重复创建 session/run。
    // 调用方不传 requestId 时本地生成；显式重试时 caller 必须复用 requestId。
    const body = { chat, attachments, skillId };
    if (sessionId !== undefined) body.sessionId = sessionId;
    if (permissionMode) body.permissionMode = permissionMode;
    if (raw === true) body.raw = true;   // 斜杠命令直达（/compact 等），跳过消息装饰
    body.requestId = requestId || (crypto?.randomUUID
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // 自带 1 次重试：网络抖 / 5xx 时同 requestId 重发，命中 LRU 拿到一致 runId
    try {
      return await jsonRequest('POST', `/api/projects/${pid}/turn`, body);
    } catch (err) {
      const code = err?.status;
      const retryable = !code || code >= 500 || code === 0;
      if (!retryable) throw err;
      await new Promise(r => setTimeout(r, 500));
      return jsonRequest('POST', `/api/projects/${pid}/turn`, body);
    }
  },

  /**
   * 终止生成。后端 cancelRun → ctrl.abort('user_cancel') → SDK 中断 →
   * 触发 ctx.signal.aborted → emit run.cancelled。
   * 200 ok / 404 code='RUN_NOT_ACTIVE' (run 已结束 / 不存在)
   */
  cancel: ({ pid, runId }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/cancel`, {}),

  /**
   * A4.2：把用户在 AskUserQuestionView 卡片里点的答案回传后端。
   * 后端 provideAnswer resolve loop.js canUseTool 等待的 Promise →
   * binary 拿到 updatedInput 调 tool.call → 模型看到 "User has answered..."。
   * answers: { [questionText]: optionLabel }
   * 200 ok / 400 缺字段 / 404 code='NO_PENDING_QUESTION'
   */
  answer: ({ pid, runId, toolUseId, answers }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/answer`, { toolUseId, answers }),

  /**
   * SDK Query control: rewindFiles —— 把 cwd 文件回滚到指定 user message 时点。
   * 配合 enableFileCheckpointing。前端 user message 旁的 undo 按钮调这个。
   * 200 { ok:true } / 404 code='RUN_NOT_ACTIVE' / 501 code='METHOD_NOT_AVAILABLE'
   */
  rewind: ({ pid, runId, messageId }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/rewind`, { messageId }),

  /**
   * SDK Query control: setPermissionMode —— 运行时切权限模式。
   * mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'
   * Phase 3 plan-mode native 路径必需。
   */
  setPermissionMode: ({ pid, runId, mode }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/permission-mode`, { mode }),

  /**
   * SDK Query control: setModel —— 运行时切模型。
   * model: 'kimi-k2.6' / 'claude-sonnet-4-6' / 'claude-opus-4-7' 等。
   * 传 null 让 SDK 用默认。
   */
  setModel: ({ pid, runId, model }) =>
    jsonRequest('POST', `/api/projects/${pid}/runs/${runId}/model`, { model }),
};

// ── Instruction（项目级 .claude/CLAUDE.md 读写）──
export const Instruction = {
  read: (pid) => jsonRequest('GET', `/api/projects/${pid}/instruction`),
  write: (pid, content) => jsonRequest('PUT', `/api/projects/${pid}/instruction`, { content }),
};

// ── Memory（项目级 shared/.claude/agent-memory/<agentType>/） ──
export const Memory = {
  /** 列所有 agent 的 memory 概要 */
  list: (pid) => jsonRequest('GET', `/api/projects/${pid}/memory`),
  /** 读单个 agent 全文（agentType='_root' 表示顶层 main agent memory.md） */
  read: (pid, agentType) =>
    jsonRequest('GET', `/api/projects/${pid}/memory/${encodeURIComponent(agentType)}`),
  /** 覆盖写 memory.md */
  write: (pid, agentType, content) =>
    jsonRequest('PUT', `/api/projects/${pid}/memory/${encodeURIComponent(agentType)}`, { content }),
  /** 删整个 agent memory 子目录 / 顶层 memory.md */
  remove: (pid, agentType) =>
    jsonRequest('DELETE', `/api/projects/${pid}/memory/${encodeURIComponent(agentType)}`),
};

// ── Sessions（薄壳走 SDK listSessions / getSessionMessages / forkSession / ...）──
export const Sessions = {
  /** 列项目下所有 session（按 lastModified 倒序，SDK 默认） */
  list: (pid, { limit, offset } = {}) => {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (offset != null) qs.set('offset', String(offset));
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return jsonRequest('GET', `/api/projects/${pid}/sessions${tail}`);
  },
  /** 拉单个 session 的完整 messages（SDK SessionMessage[]） */
  read: (pid, sid, { includeSystem } = {}) => {
    const tail = includeSystem ? '?includeSystem=1' : '';
    return jsonRequest('GET', `/api/projects/${pid}/sessions/${sid}${tail}`);
  },
  /** Fork 出一个新 session，可指定截断点和标题 */
  fork: (pid, sid, { upToMessageId, title } = {}) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/fork`, { upToMessageId, title }),
  /** 改标题 / 标签（patch 任一字段） */
  update: (pid, sid, patch) =>
    jsonRequest('PATCH', `/api/projects/${pid}/sessions/${sid}`, patch),
  /** 删 session JSONL（顺带清 active_session_id 如果指向它） */
  remove: (pid, sid) =>
    jsonRequest('DELETE', `/api/projects/${pid}/sessions/${sid}`),
  /** 关闭活跃 query session（streamInput 模式，inputQueue.close + abortController.abort）。
   *  query 进程退出，下次 turn 该 sid 起新 runSession。session JSONL 不删，jsonl 仍可 resume */
  close: (pid, sid) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/close`),
  /**
   * 调 SDK Query.rewindFiles(userMessageId) 把所有文件回滚到 userMessageId 之前。
   * 仅 streamInput query 活着时可用 —— session 已 close 时返 410。
   * 200 → { canRewind, filesChanged?, insertions?, deletions? }
   */
  rewind: (pid, sid, userMessageId) =>
    jsonRequest('POST', `/api/projects/${pid}/sessions/${sid}/rewind`, { userMessageId }),
  /**
   * 跨项目最近 session 聚合（GET /api/sessions/recent）
   * @param {object} opts
   * @param {number} [opts.limit=20]
   * @param {'project'|'quick'} [opts.kind]
   * @returns Promise<{ sessions: Array<{ projectId, projectName, projectKind,
   *   sessionId, customTitle?, summary?, firstPrompt?, lastModified, tag? }> }>
   */
  recent: ({ limit, kind } = {}) => {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (kind) qs.set('kind', kind);
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return jsonRequest('GET', `/api/sessions/recent${tail}`);
  },
};

// ── Plugins（plugin zip 上传/列表/卸载，2026-05-18）──
// 用户级与 project 级走两套 endpoint；都是 multipart `file` upload。
// 后端校验在 server/lib/plugin-validator.js，返 4xx 时 body.errors[] 含详细原因。
export const Plugins = {
  // 用户级（跨 project 全局）
  listUser: () => jsonRequest('GET', '/api/plugins'),
  installUser: async (file, { force } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = force ? '?force=true' : '';
    const res = await fetch(`/api/plugins/install${qs}`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || res.statusText), {
        status: res.status, body: data,
      });
    }
    return data;
  },
  removeUser: (name) => jsonRequest('DELETE', `/api/plugins/${encodeURIComponent(name)}`),

  // Project 级（仅当前 project）
  listProject: (pid) => jsonRequest('GET', `/api/projects/${pid}/plugins`),
  installProject: async (pid, file, { force } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = force ? '?force=true' : '';
    const res = await fetch(`/api/projects/${pid}/plugins/install${qs}`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || res.statusText), {
        status: res.status, body: data,
      });
    }
    return data;
  },
  removeProject: (pid, name) =>
    jsonRequest('DELETE', `/api/projects/${pid}/plugins/${encodeURIComponent(name)}`),
};

// ── Health ──
export const Health = {
  check: () => jsonRequest('GET', '/api/health'),
};
