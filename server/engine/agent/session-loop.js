/**
 * server/engine/agent/session-loop.js — Long-running query session loop
 *
 * SDK streamInput 模式：一个 SDK Query 持续吃 user message 跨多 turn，conversation
 * state 留在 SDK binary 内存里，**不依赖 jsonl resume**。这是 NoDesign 主代理唯一
 * 入口（曾有 per-turn 的 loop.js runAgent，2026-05-03 后已彻底移除）。
 *
 * 解决 per-turn query 架构的两个痛点：
 *   1. cancel 时 jsonl 残缺 → 下个 turn resume 失败丢上下文（streamInput 不 resume）
 *   2. 用户在 agent 跑时无法追加消息（streamInput 排队天然支持）
 *
 * 设计要点：
 *   - 不接 brief / userContentBlocks —— 用 inputQueue（AsyncQueue）作 prompt source
 *   - 不接 resumeSessionId —— streamInput 模式下 SDK 自己保 conversation state
 *   - per-turn lifecycle 管理：result message = turn 边界，emit run.done 但 query 不退
 *   - cancel 走 query.interrupt() —— SDK 出 result with terminal_reason='aborted_*'
 *     → 当前 turn emit run.cancelled → 继续等下条 user message
 *   - close session：inputQueue.close() → for-await-of 自然退出 → finally 清理
 *
 * 共享 ctx 策略（妥协）：
 *   一个 sharedCtx 横跨多 turn，每个 turn 边界处覆盖 runId + 重置 counters。
 *   这样 hooks / mcp 闭包持有的 ctx 引用稳定，emit 时 enrich 当前 turn runId。
 *   非 thread-safe（SDK stream 串行处理 message，OK）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { AgentContext } from './context.js';
import { Events } from './events.js';
import { markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata } from '../runs/store.js';
import { randomUUID } from 'node:crypto';
import {
  registerQuerySession,
  attachSessionQuery,
  unregisterQuerySession,
  getCurrentTurnRunId,
  setCurrentTurnRunId,
  registerPendingQuestion,
  registerPendingElicitation,
  registerPendingPlanApproval,
  getSessionPermissionMode,
  getSessionLastActivity,
  closeQuerySession,
  markSessionActivity,
} from '../runs/active-runs.js';
import { loadSkill, ensureSkillStarterFiles } from './skill.js';
import { createHooks } from './hooks.js';
import { createNodesignMcpServer } from '../mcp/index.js';
import { createAgents, resolveDefaultFastModel } from '../agents/index.js';
import { getOrStartProxy } from '../../lib/binary-fixup-proxy.js';
import { AsyncQueue } from '../../lib/async-queue.js';
import { platform } from '../../runtime/platform.js';
import {
  NODESIGN_PRELUDE,
  NODESIGN_PLAN_INSTRUCTIONS,
  DEFAULT_TOOL_ALLOWLIST,
  STREAMING_ENABLED,
  pickThinkingConfig,
  handleSDKMessage,
  detectArtifact,
} from './agent-shared.js';

/**
 * Plan-mode 硬 deny 列表（canUseTool 钩子拦）。Allowlist 反过来推：
 *   ✅ allow: Read / Grep / Glob / WebFetch / Task / AskUserQuestion / TodoWrite
 *            / mcp__nodesign__web_search / mcp__nodesign__generate_image
 *            （+ ExitPlanMode 是 SDK 内置 plan-mode 提交工具，必允许）
 *   ❌ deny: 动主产物 + 决策档案 + 打包 + 改 canvas 状态的工具
 *
 * 设计意图：plan mode 是 brainstorm + 探索阶段，**generate_image 故意放开**让
 * agent 在 brainstorm 时能给用户出小样视觉对齐（详见 SKILL.md § Plan mode），
 * 但 SKILL.md prompt 软约束规定"方向对齐了再生图"，避免一上来就画的浪费。
 */
const PLAN_MODE_DENY = new Set([
  // 写入主产物（canvas.html 等）
  'Write', 'Edit', 'MultiEdit',
  // shell 任意命令（plan 期间不允许 git/playwright/zip/...）
  'Bash',
  // NoDesign MCP 工具：动 canvas 渲染状态 / 决策档案 / 成品打包
  'mcp__nodesign__screenshot_canvas',
  'mcp__nodesign__expose_tweaks',
  'mcp__nodesign__record_decision',
  'mcp__nodesign__export_handoff',
  'mcp__nodesign__navigate_to_page',
  'mcp__nodesign__highlight',
  'mcp__nodesign__clear_pending_changes',
]);

/**
 * 起一个 session-level long-running SDK query。runs 是 per-turn 概念（SDK 每见
 * 到一条 user message 起一轮 LLM 调用直到 stop_reason='end_turn'）。
 *
 * **必须**外部维护 inputQueue —— 调用方（turn.js）提前 push 第一条 message 后再
 * 调 runSession，session-loop 立即拉到处理。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.projectId
 * @param {string} opts.sessionWorkspaceRoot
 * @param {import('./events.js').EventBus} opts.eventBus
 * @param {import('../../lib/async-queue.js').AsyncQueue} opts.inputQueue
 * @param {string} [opts.skillId='deskskill-engine-mini']
 * @param {string} [opts.sessionTitle]
 * @param {object} [opts.modelOverride={}]
 * @param {string[]} [opts.toolAllowlist=DEFAULT_TOOL_ALLOWLIST]
 * @param {string} [opts.initialPermissionMode]
 * @param {string} [opts.initialRunId] - 首条 turn 的 run record id；若给则 register
 *                                       完立即设 currentRunId，避免 turn.js race
 *                                       condition（push 早于 register 没法关联 runId）
 * @returns {Promise<void>}  - inputQueue 关闭时 resolve
 */
export async function runSession({
  sessionId,
  projectId,
  sessionWorkspaceRoot,
  eventBus,
  inputQueue,
  skillId = 'deskskill-engine-mini',
  sessionTitle = null,
  modelOverride = {},
  toolAllowlist = DEFAULT_TOOL_ALLOWLIST,
  initialPermissionMode = null,
  initialRunId = null,
}) {
  if (!sessionId) throw new Error('runSession: sessionId required');
  if (!sessionWorkspaceRoot) throw new Error('runSession: sessionWorkspaceRoot required');
  if (!inputQueue || !(inputQueue instanceof AsyncQueue)) {
    throw new Error('runSession: inputQueue (AsyncQueue) required');
  }
  if (!eventBus) throw new Error('runSession: eventBus required');

  const cwdRoot = sessionWorkspaceRoot;
  const sharedRoot = projectId
    ? path.join(sessionWorkspaceRoot, '..', '..', 'shared')
    : null;

  const sessionAbortController = new AbortController();
  // initialPermissionMode 落进 active-runs，canUseTool 通过 getSessionPermissionMode 读
  // 当前 mode 决定要不要 deny 写工具（plan mode 硬约束）。/permission-mode endpoint
  // 切 mode 时也会同步更新本字段。
  const initialModeNormalized =
    initialPermissionMode === 'plan' ? 'plan' : 'bypassPermissions';
  // sessionToken：身份证。closeQuerySession 已同步让出 sid 后用户立即重发起新
  // runSession → 新 register 拿到新 token；旧 runSession finally 调 unregister 带
  // 旧 token 比对不匹配 → noop 不误删新 entry。
  const sessionToken = registerQuerySession(sessionId, {
    abortController: sessionAbortController,
    inputQueue,
    initialPermissionMode: initialModeNormalized,
  });
  // 关键 race guard：registerQuerySession 拒绝重复注册（同 sid 已活跃）→ 这次
  // runSession 是冗余调用（前端 race / 后端 fallback / resume race），直接 early
  // return 不 spawn 第二个 SDK binary。否则两个 binary 并行 Write 同 canvas.html
  // 就是用户报告的"独立 main 进程在 write"。
  if (!sessionToken) {
    console.warn(
      `[session-loop] runSession sid=${sessionId.slice(0, 8)} skipped — already active. `
      + `Caller (turn.js) should have used pushUserMessage instead of startNewRunSession.`
    );
    return;
  }
  // initialRunId：register 后立刻设 currentRunId，让 for-await-of 第一次见到
  // SDK 转发首条 user message 时直接知道当前 turn 的 runId（否则 turn.js 那边
  // 必须在 register 之后才能调 pushUserMessage —— race window）
  if (initialRunId) setCurrentTurnRunId(sessionId, initialRunId);

  // session-level start event（Phase 2，前端识别 query alive）
  eventBus.publish({ type: 'run.query.start', sessionId, ts: new Date().toISOString() });

  // sharedCtx：跨 turn 复用。每个 turn 边界覆盖 runId + 重置 counters。
  // hooks / mcp 闭包持稳定引用即可。
  // sessionId 传入让 ctx.emit 自动 enrich event.sessionId，WS handler 按 sid 过滤
  // 防多 session / 多 tab 跨 session 串扰（project bus 共享）。
  const sharedCtx = new AgentContext({
    runId: '__session_pending__',
    skillId,
    eventBus,
    abortController: sessionAbortController,
    workspaceRoot: cwdRoot,
    sessionId,
  });

  const wsRoot = await sharedCtx.workspace.ensure();
  const skill = await loadSkill(skillId);

  // Path 整理（2026-05-06）：把 skill 自带的起手文件（canvas.template.html
  // 等）拷到 session cwd —— SKILL.md 教 agent `Read canvas.template.html`
  // 直接生效。幂等 + fail-soft。
  try {
    const r = await ensureSkillStarterFiles(wsRoot, skill.id);
    if (r.copied.length > 0) {
      console.log(`[session-loop] starter files copied: ${r.copied.join(', ')}`);
    }
  } catch (err) {
    console.warn(`[session-loop] ensureSkillStarterFiles failed:`, err.message);
  }

  const model = modelOverride.model || process.env.NODESIGN_MODEL || 'kimi-k2.6';

  const realGatewayUrl = process.env.NODESIGN_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL;
  let baseUrlForBinary = realGatewayUrl;
  if (realGatewayUrl) {
    try {
      const proxy = await getOrStartProxy(realGatewayUrl);
      // 编码 sessionId 进 BASE_URL 路径 → proxy 解析后透传给 NoDesk 的 ND-Thread-Id
      baseUrlForBinary = `${proxy.baseUrl}/__nd/${encodeURIComponent(sessionId)}`;
    } catch (err) {
      console.warn(`[session-loop] proxy start failed, fallback direct: ${err.message}`);
    }
  }

  // 快速 model（subagent + SDK helper 共用）
  const fastModel = process.env.NODESIGN_FAST_MODEL || resolveDefaultFastModel(model);

  // 检测 jsonl 是否已存在 —— 决定走 resume（已存在）还是 sessionId（新建）
  // 之前的 bug：session-loop 永远传 sessionId，但如果用户 close session 后又
  // 用同 sid 起 query（hasActiveQuerySession=false 走 startNewRunSession），
  // SDK binary 看 jsonl 已存在抛 "Session ID ... is already in use"，
  // 子进程死，nodejs 端 stdin write EPIPE 整个 server 挂。
  const isResume = await jsonlExistsForSession(cwdRoot, sessionId);

  const sdkOptions = {
    cwd: cwdRoot,
    abortController: sessionAbortController,
    // 新建 → sessionId 让 SDK 用我们的 sid；已存在 → resume 续 jsonl 历史
    ...(isResume ? { resume: sessionId } : { sessionId }),
    // title 仅在新建时有效（resume 用持久化的 title）
    ...(sessionTitle && !isResume ? { title: sessionTitle.slice(0, 80) } : {}),
    ...(sharedRoot ? { additionalDirectories: [sharedRoot] } : {}),

    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrlForBinary,
      ANTHROPIC_API_KEY: process.env.NODESIGN_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
      CLAUDE_CONFIG_DIR: platform.claudeConfigDir,
      // 快速 helper model：默认 claude-haiku-4-5-20251001-cc，env 可覆盖。
      // 用于 SDK 内部 helper（如 task title 总结、auto-compaction 等小调）。
      ...(fastModel ? { ANTHROPIC_SMALL_FAST_MODEL: fastModel } : {}),
    },

    model,
    tools: toolAllowlist,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [NODESIGN_PRELUDE, skill.systemPrompt].filter(Boolean).join('\n\n---\n\n'),
    },

    // resume 时不传 permissionMode：SDK 会从 JSONL 读原 session flags + 检查
    // bypassPermissions 必须有 --dangerously-skip-permissions 启动才允许。如果
    // 老 session 是在没这个 flag 的版本下创建的（老 SDK / 老代码），现在硬传
    // permissionMode: 'bypassPermissions' 会让 SDK 抛：
    //   "Cannot set permission mode to bypassPermissions because the session
    //    was not launched with --dangerously-skip-permissions"
    // 这个错没有 runId 会被前端 stale guard 吞掉 → 用户看到"完全没反应"。
    // 修：resume 不传 permissionMode 让 SDK 用 JSONL 保存的；运行时切 mode 通过
    // query.setPermissionMode + turn.js POST /turn 入口的 mode 校正路径完成。
    ...(isResume
      ? {}
      : { permissionMode: initialPermissionMode === 'plan' ? 'plan' : 'bypassPermissions' }),
    // 永远 true：与 permissionMode 正交——只是"允许运行时切 bypassPermissions"的安全
    // 开关，启动当下的 mode 由 permissionMode 字段定。plan-mode 启动也必须带，否则用户
    // 批准 plan 后 host 调 query.setPermissionMode('bypassPermissions') 会被 SDK 拒：
    // "session was not launched with --dangerously-skip-permissions"。
    allowDangerouslySkipPermissions: true,
    planModeInstructions: NODESIGN_PLAN_INSTRUCTIONS,

    // 通用 permission gate
    //
    // ⚠️ SDK 0.2.x permission decision schema 要求 'allow' branch 必带 updatedInput
    // （Zod union 严格验证）；返 `{ behavior: 'allow' }` 缺 updatedInput 会触发
    // ZodError 让工具被拒。'allow' 都要带 updatedInput（不改的话原样透传 input）。
    //
    // Plan-mode 工具白名单（2026-05-06 增）：用户进 plan mode 后 agent 可以做
    // brainstorm + 探索 + 候选样张，但**不能动主产物 / 跑 shell / 落决策档案**。
    // - 允许：Read/Grep/Glob/WebFetch/Task/AskUserQuestion，以及
    //   mcp__nodesign__web_search / mcp__nodesign__generate_image（探索性候选样张）
    // - 拒绝：Write/Edit/MultiEdit/Bash + screenshot_canvas / expose_tweaks /
    //   record_decision / export_handoff / navigate_to_page / highlight 等动状态工具
    // 拒绝时 message 解释让 agent 改流程（先 ExitPlanMode 提交 plan 让用户批）。
    canUseTool: async (toolName, input, options) => {
      // Plan-mode 硬 enforce（model 看的 prompt 是软约束，这里是硬约束兜底）
      const currentMode = getSessionPermissionMode(sessionId);
      if (currentMode === 'plan' && PLAN_MODE_DENY.has(toolName)) {
        return {
          behavior: 'deny',
          message:
            `plan mode 不能调 ${toolName}（动主产物 / 决策档案 / 打包都是 generate 阶段的活）。\n`
            + `当前阶段：用 AskUserQuestion 跟用户逐页对齐 + 必要时用 generate_image 出小样确认方向。\n`
            + `所有页对齐了 → 调 ExitPlanMode 提交 design-plan.md → 用户批准后 SDK 自动切 default → 那时再做这个。`,
          interrupt: false,
        };
      }

      // ExitPlanMode 阻塞：agent 调 ExitPlanMode 后必须等用户审批 PlanReviewCard
      // 才能继续。原 PostToolUse hook 只 emit 不阻塞 → agent 直接 next turn ≈
      // "自动批准"体感（hooks.js:756 旧版只 ctx.emit 不 await）。改用 canUseTool
      // 拦截：emit + await registerPendingPlanApproval —— 跟 AskUserQuestion 同
      // 模式。host 调 plan-approve/reject 时通过 providePlanApprovalDecision resolve。
      if (toolName === 'ExitPlanMode') {
        const toolUseId = options?.toolUseID;
        if (!toolUseId) {
          return { behavior: 'deny', message: 'ExitPlanMode missing toolUseID', interrupt: false };
        }
        const plan = String(input?.plan || '').trim();
        if (!plan) {
          return { behavior: 'deny', message: 'ExitPlanMode plan content empty', interrupt: false };
        }
        sharedCtx.emit({ type: 'run.plan_for_approval', toolUseId, plan });
        try {
          const decision = await registerPendingPlanApproval(sessionId, toolUseId);
          if (decision?.approved) {
            // 用户 approve（含编辑过的 plan）→ host 已先调 setPermissionMode('default')
            // 让 SDK 切回；canUseTool 这边 allow + 把 editedPlan 替换原 input.plan 让
            // ExitPlanMode tool 落档用户实际批准的版本
            const finalPlan = (typeof decision.editedPlan === 'string' && decision.editedPlan.trim())
              ? decision.editedPlan
              : plan;
            return { behavior: 'allow', updatedInput: { ...input, plan: finalPlan } };
          }
          // 用户 reject —— 通常 plan-reject endpoint 已 cancelRun (abort 整个 query)，
          // 走到这里是兜底：deny 让 agent 重新对齐
          return { behavior: 'deny', message: '用户希望重新对齐，请基于反馈重新组织 plan', interrupt: true };
        } catch (err) {
          return { behavior: 'deny', message: err.message, interrupt: true };
        }
      }

      if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
      const toolUseId = options?.toolUseID;
      if (!toolUseId) {
        return { behavior: 'deny', message: 'AskUserQuestion missing toolUseID', interrupt: false };
      }
      const currentRunId = getCurrentTurnRunId(sessionId);
      if (!currentRunId) {
        return { behavior: 'deny', message: 'no active turn for AskUserQuestion', interrupt: false };
      }
      sharedCtx.emit({ type: 'run.ask_user_question', toolUseId, input });
      try {
        const answers = await registerPendingQuestion(currentRunId, toolUseId);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (err) {
        return { behavior: 'deny', message: err.message, interrupt: true };
      }
    },

    // Phase B 批次 4：MCP elicitation 接通前端 Modal。
    // 流程：MCP 工具调 server.elicitInput() → SDK 调这个回调 → 我们 emit
    // run.elicitation_request 给前端 → ElicitationModal 弹出 → 用户填完 POST
    // /elicit/:reqId/answer → provideElicitation 返回 { action, content } → SDK
    // 拿到结果继续工具调用。
    // 60s 超时是为了给用户填表时间（之前 5s 太短，未来真用 elicit 时永远没机会答）；
    // 仍兜底防 MCP 工具卡死整个 agent loop。
    onElicitation: async (request, _options) => {
      const reqId = randomUUID();
      const currentRunId = getCurrentTurnRunId(sessionId);
      try {
        sharedCtx.emit({ type: 'run.elicitation_request', reqId, request, runId: currentRunId });
      } catch { /* ignore */ }
      if (!currentRunId) {
        return { action: 'decline' };
      }
      try {
        const p = registerPendingElicitation(currentRunId, reqId);
        const timeoutPromise = new Promise(resolve =>
          setTimeout(() => resolve({ action: 'decline' }), 60_000),
        );
        return await Promise.race([p, timeoutPromise]);
      } catch {
        return { action: 'decline' };
      }
    },

    persistSession: true,
    settingSources: ['project'],

    // skipWebFetchPreflight 来自 runtime/platform.js（gateway key 模式永远关）
    // 详细因果链见 platform.js 的 skipWebFetchPreflight 注释
    settings: {
      skipWebFetchPreflight: platform.skipWebFetchPreflight,
    },

    includePartialMessages: STREAMING_ENABLED,

    thinking: modelOverride.thinking || pickThinkingConfig(model),
    effort: modelOverride.effort || 'medium',
    // streamInput 模式 query 横跨整个 session，maxTurns 是**全局累计**（每条
    // user message 起一轮 agent loop，turn 数不重置）。15 太低 —— 用户聊几
    // 轮就触顶导致 'error_max_turns' 误中断。改 50 给复杂 deck（多页 +
    // 多次自检 + 子代理）足够余量；env override 给极端情况用
    maxTurns: modelOverride.maxTurns
      || Number(process.env.NODESIGN_MAX_TURNS)
      || 50,

    // 不传 resume —— streamInput 模式 SDK 内存保 history，不依赖 jsonl
    enableFileCheckpointing: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    forwardSubagentText: true,

    // streamInput 模式 budget 也是全局累计 —— 长 session 1$ 极易触顶。改默
    // 认 10$（env override 仍生效）。原 default 5$ 实测让 agent 后期偏保守
    // （少调工具 / 少派子代理 / 收尾仓促）。10$ 给充裕迭代空间，K2.6 价位下
    // 也极少真烧到上限；Claude/Opus 长 session 可以再 env 提到 20。
    maxBudgetUsd: (() => {
      const v = Number(process.env.NODESIGN_MAX_BUDGET_USD);
      return Number.isFinite(v) && v > 0 ? v : 10;
    })(),

    // Sandbox 开/关来自 runtime/platform.js（NODESIGN_SANDBOX=on 显式打开）
    // 现状：默认关 —— bwrap 不解析 session root 的 symlink。详见 platform.js
    sandbox: {
      enabled: platform.sandboxEnabled,
      failIfUnavailable: false,
      network: {
        allowLocalBinding: false,
        // MVP 全域允许；生产可改具体白名单（unsplash / google-fonts / jsdelivr 等）
        allowedDomains: ['*'],
      },
      filesystem: {
        allowWrite: [
          cwdRoot,
          ...(sharedRoot ? [
            path.join(sharedRoot, '.claude', 'agent-memory'),
            path.join(sharedRoot, 'assets'),
          ] : []),
        ],
        denyWrite: ['/etc', '/usr', '/bin', '/sbin', '/private/etc'],
        denyRead: platform.credentialBlacklist(),
      },
    },

    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },

    hooks: createHooks({ ctx: sharedCtx, workspaceRoot: wsRoot }),

    mcpServers: {
      nodesign: createNodesignMcpServer({ workspaceRoot: wsRoot, sessionId, ctx: sharedCtx }),
    },

    agents: createAgents({ mainModel: model, fastModel }),

    stderr: (data) => {
      console.error(`[session ${sessionId.slice(0, 8)}/claude.stderr]`, data.trim());
    },
  };

  // ── per-turn lifecycle helpers ──

  let activeTurnRunId = null;

  const startTurn = (runId) => {
    activeTurnRunId = runId;
    markSessionActivity(sessionId);  // turn 边界 = 活跃信号
    // 重置 sharedCtx 的 per-turn state
    sharedCtx.runId = runId;
    sharedCtx.counters = {
      turns: 0, toolCalls: 0, toolFailures: 0,
      compactBoundaries: 0, apiRetries: 0,
      durationMs: 0, durationApiMs: 0, totalCostUsd: 0,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
    };
    sharedCtx.startedAt = Date.now();
    sharedCtx._cancelled = false;        // context.js cancel 幂等 flag 重置
    // 当前 turn id 写到 process.env，让 binary-fixup-proxy 拦截 LLM 请求时拿到
    // 透传成 ND-Trace-Id（NoDesk 后台按 trace 串单轮 LLM 调用链路）。SDK 串行
    // 处理 turn，全局变量在同一时刻只对应一个活动 turn，无 race。
    process.env.NODESIGN_CURRENT_TURN_ID = runId;
    markRunStarted(runId);
    sharedCtx.emit(Events.start());
  };

  const finishTurn = async (status, info) => {
    if (!activeTurnRunId) return;
    const runId = activeTurnRunId;
    if (status === 'success') {
      const artifactPath = await detectArtifact(sharedCtx);
      mergeRunMetadata(runId, { sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters });
      try { markRunSucceeded(runId, { artifactPath }); } catch { /* idempotent */ }
      sharedCtx.emit(Events.done(info?.finalText || '', artifactPath, sharedCtx.snapshot ? sharedCtx.snapshot() : { counters: sharedCtx.counters }));
    } else if (status === 'cancelled') {
      mergeRunMetadata(runId, { aborted: true, abortReason: info?.reason || 'user_cancel' });
      try { markRunFailed(runId, `cancelled: ${info?.reason || 'user_cancel'}`); } catch { /* */ }
      sharedCtx.emit({ type: 'run.cancelled', reason: info?.reason || 'user_cancel' });
    } else if (status === 'error') {
      mergeRunMetadata(runId, {
        sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters,
        errorCode: info?.code, errorMessage: info?.message,
      });
      try { markRunFailed(runId, info?.message || 'unknown'); } catch { /* */ }
      sharedCtx.emit(Events.error(info?.message || 'unknown', info?.code, info?.stack));
    }
    activeTurnRunId = null;
    markSessionActivity(sessionId);  // turn 结束 = 活跃信号；下次 idle 计时重置
    // 同步清 active-runs 的 currentRunId —— 否则 SDK 在 result 之后推的"尾巴
    // system message"（status / post_turn_summary 等）进 stream 时，cid 仍 = 已结束
    // 的老 runId 会触发 startTurn() 再调 markRunStarted() 抛"不在 pending 状态"
    setCurrentTurnRunId(sessionId, null);
    // 清掉 turn id 环境变量；下个 turn 的 startTurn 会重设
    delete process.env.NODESIGN_CURRENT_TURN_ID;
  };

  // ── idle timeout 兜底 ──
  // 用户关 tab 后 WS-disconnect grace 是常规清理路径；这里再加一道：
  // session 超过 IDLE_TIMEOUT 无任何活动（push message / turn 边界）→ 自动关。
  // 防止"WS 还在但 user 走开几小时"的隐性占用。
  const IDLE_TIMEOUT_MS = Number(process.env.NODESIGN_SESSION_IDLE_MS) || 30 * 60_000;
  const IDLE_SCAN_INTERVAL_MS = Math.min(5 * 60_000, IDLE_TIMEOUT_MS);
  const idleScanTimer = setInterval(() => {
    const last = getSessionLastActivity(sessionId);
    if (last == null) return;  // session 已被 unregister，scan 等会儿自然结束
    if (Date.now() - last > IDLE_TIMEOUT_MS) {
      console.info(`[session-loop] sid=${sessionId.slice(0, 8)} idle > ${IDLE_TIMEOUT_MS}ms, closing`);
      closeQuerySession(sessionId, 'idle_timeout');
    }
  }, IDLE_SCAN_INTERVAL_MS);
  idleScanTimer.unref?.();

  // ── main stream loop ──

  let stream;
  try {
    stream = query({ prompt: inputQueue, options: sdkOptions });
    attachSessionQuery(sessionId, stream);

    // emitContextUsage：fire-and-forget per assistant message
    let usageInFlight = false;
    const emitContextUsage = () => {
      if (usageInFlight) return;
      usageInFlight = true;
      stream.getContextUsage()
        .then((usage) => { if (usage) sharedCtx.emit(Events.contextUsage(usage)); })
        .catch(() => { /* fail-soft */ })
        .finally(() => { usageInFlight = false; });
    };

    for await (const message of stream) {
      // 检测 turn 边界：currentRunId 切换 → 新 turn
      const cid = getCurrentTurnRunId(sessionId);
      if (cid && cid !== activeTurnRunId) {
        // 新 turn 开始（前一 turn 应该已 finishTurn — 防御性兜底）
        if (activeTurnRunId) {
          await finishTurn('error', { message: 'turn boundary skipped without result', code: 'TURN_LEAK' });
        }
        startTurn(cid);
      }

      handleSDKMessage(sharedCtx, message);

      if (message.type === 'assistant') emitContextUsage();

      if (message.type === 'result') {
        const isCancelled = message.terminal_reason === 'aborted_streaming'
          || message.terminal_reason === 'aborted_tools';

        if (isCancelled) {
          await finishTurn('cancelled', { reason: message.terminal_reason });
        } else if (message.subtype === 'success') {
          await finishTurn('success', { finalText: message.result || '' });
        } else {
          await finishTurn('error', {
            message: `agent run failed: ${message.subtype}`
              + (message.errors?.length ? ` — ${message.errors.join('; ')}` : ''),
            code: message.subtype,
          });
        }
        // turn 处理完 emit 当前 queue 积压（让前端"已排队 N 条"递减）
        eventBus.publish({
          type: 'run.queue.depth',
          sessionId,
          depth: inputQueue.size,
          ts: new Date().toISOString(),
        });
        // 不 throw —— query 继续等下一条 user message
      }
    }

    // for-await-of 自然结束（inputQueue.close 触发）→ session 完整收尾
    if (activeTurnRunId) {
      // input 关闭时还有 in-flight turn —— 当作 cancelled 收尾
      await finishTurn('cancelled', { reason: 'session_closed' });
    }
  } catch (err) {
    // 区分两种"抛错"：
    //   1. 用户主动 close session（abortController.abort() 触发 SDK binary
    //      子进程被 SIGTERM kill → 抛"Claude Code process aborted by user"）
    //      —— 这是预期行为，不是 error，不应该让前端弹"运行失败"toast
    //   2. 真错（网络断、SDK init 失败、Kimi gateway 5xx 等）—— 走 error 路径
    if (sessionAbortController.signal.aborted) {
      // close session 路径：当前 turn 当 cancelled 收尾，不 emit run.error
      if (activeTurnRunId) {
        await finishTurn('cancelled', {
          reason: sessionAbortController.signal.reason || 'session_closed',
        });
      }
      // 静默退出 —— finally 仍 emit run.query.end 让前端识别 session 关了
    } else {
      // 真错路径
      if (activeTurnRunId) {
        await finishTurn('error', err);
      } else if (initialRunId) {
        // 错误发生在 startTurn 之前（如 SDK query() 启动权限冲突 / workspace.ensure
        // 抛错等）→ activeTurnRunId 还是 null，sharedCtx.runId 仍是占位符
        // '__session_pending__'。直接 emit run.error 会让 enriched event 带这个占位
        // runId，前端 stale guard `evt.runId !== liveRunId` 把事件吞掉 → 用户看到
        // "完全没反应"。修：手动把 sharedCtx.runId 设到本次 turn 的 initialRunId 让
        // emit 出去的 run.error 带正确 runId 让前端能渲染错误。
        sharedCtx.runId = initialRunId;
        try { markRunFailed(initialRunId, err.message || 'unknown'); } catch { /* ignore */ }
      }
      sharedCtx.emit(Events.error(err.message, err.code, err.stack));
      throw err;
    }
  } finally {
    clearInterval(idleScanTimer);
    // 带 token 比对：sid 若已被新 register 占用（closeQuerySession 已同步让位 +
    // 用户重发起新 runSession），unregister 看到 _token 不匹配 → noop 不误删新 entry
    unregisterQuerySession(sessionId, sessionToken);
    // session-level end event（Phase 2）
    try {
      eventBus.publish({
        type: 'run.query.end',
        sessionId,
        reason: sessionAbortController.signal.aborted
          ? (sessionAbortController.signal.reason || 'aborted')
          : 'closed',
        ts: new Date().toISOString(),
      });
    } catch { /* */ }
  }
}

/**
 * 检查给定 sessionId 是否已经有 SDK jsonl 落盘 —— 决定走 resume 还是新建。
 *
 * SDK 落盘路径：<sessionRoot>/.claude/projects/<encoded-cwd>/<sid>.jsonl
 * encoded-cwd 把 cwd 绝对路径里 '/' 换成 '-'。我们不复制 SDK 编码逻辑，
 * 直接遍历 .claude/projects/* 看哪个子目录里有 <sid>.jsonl。
 */
async function jsonlExistsForSession(sessionRoot, sessionId) {
  // SDK 将 JSONL 存在 CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl
  // 编码规则（grep 自 sdk.mjs）：所有非字母数字字符转 '-'
  const encodedCwd = sessionRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const globalJsonl = path.join(platform.claudeConfigDir, 'projects', encodedCwd, `${sessionId}.jsonl`);
  try {
    await fs.access(globalJsonl);
    return true;
  } catch { /* not at global location */ }

  // fallback：检查本地 .claude/projects/（兼容旧行为 / sandbox 模式）
  const projectsDir = path.join(sessionRoot, '.claude', 'projects');
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(projectsDir, e.name, `${sessionId}.jsonl`);
    try {
      await fs.access(f);
      return true;
    } catch { /* not here, try next */ }
  }
  return false;
}
