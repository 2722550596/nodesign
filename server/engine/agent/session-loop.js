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
import { createRun, markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata, setRunMetrics, setRunModelUsage } from '../runs/store.js';
import { getProject } from '../../projects/store.js';
import { randomUUID } from 'node:crypto';
import {
  registerQuerySession,
  attachSessionQuery,
  unregisterQuerySession,
  getCurrentTurnRunId,
  setCurrentTurnRunId,
  promoteNextPendingRunId,
  registerPendingQuestion,
  registerPendingElicitation,
  registerPendingPlanApproval,
  getSessionPermissionMode,
  getSessionLastActivity,
  closeQuerySession,
  markSessionActivity,
} from '../runs/active-runs.js';
// skill 起手文件拷贝已挪 hooks.js PreToolUse(Skill/Bash)（2026-07-27），
// session-loop 不再直接依赖 skill.js；skillId 参数仅作兼容保留。
import { loadInstalledPlugins } from './plugin-loader.js';
import { createHooks } from './hooks.js';
import { buildIsolationOptions, prepareAgentDirs, sandboxShimEnv } from './isolation.js';
import { PLAN_MODE_DENY, isReadonlyBashCommand } from './plan-mode-gate.js';
import { createNodesignMcpServer } from '../mcp/index.js';
import { recordIssue, signatureOf } from '../../lib/issues-store.js';
import { createAgents, resolveDefaultFastModel } from '../agents/index.js';
import { resolveSdkSpoofModel, pickThinkingConfig } from './model-context.js';
import { resolveSessionModel } from './session-model.js';
import { getOrStartProxy } from '../../lib/binary-fixup-proxy.js';
import { summarizeReply, summarizeRecap, clampFirstClause } from '../../lib/quick-summary.js';
import { AsyncQueue } from '../../lib/async-queue.js';
import { platform } from '../../runtime/platform.js';
import {
  NODESIGN_PRELUDE,
  renderPrelude,
  NODESIGN_PLAN_INSTRUCTIONS,
  DEFAULT_TOOL_ALLOWLIST,
  STREAMING_ENABLED,
  handleSDKMessage,
  detectArtifact,
} from './agent-shared.js';
import { autoNameProjectFromSession } from '../../projects/auto-name.js';
// 合流并集（2026-08-13）：commitWorkspace/taskManifest 是扁平化这边的，
// getUserById/levelFor 是 main 的每用户内容尺度旋钮（78ceaac）；
// main 的 listTasks 已随任务层退役，不再引入
import { commitTaskWorkspace, commitWorkspace, PROJECTS_DATA_ROOT } from '../../projects/workspace.js';
import { taskManifest } from '../../lib/artifact-target.js';
import { getUserById } from '../../auth/users-store.js';
import { levelFor } from '../../lib/moderation.js';

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
 * @param {string[]} [opts.toolAllowlist=DEFAULT_TOOL_ALLOWLIST]
 * @param {string} [opts.initialPermissionMode]
 * @param {string} [opts.initialRunId] - 首条 turn 的 run record id；若给则 register
 *                                       完立即设 currentRunId，避免 turn.js race
 *                                       condition（push 早于 register 没法关联 runId）
 * @returns {Promise<void>}  - inputQueue 关闭时 resolve
 */
/**
 * SDK 自发 turn 的开启信号：真实的模型/对话活动（assistant 输出、流式增量、
 * SDK 注入的 user 消息）。task_notification / task_progress / notification 等
 * 旁路事件**不算** —— 通知之后 SDK 不一定真的唤起模型，铸了 run 却等不来
 * result 收尾就是僵尸 run。
 */
function isBackgroundTurnOpener(message) {
  return message?.type === 'assistant'
    || message?.type === 'stream_event'
    || message?.type === 'user';
}

export async function runSession({
  sessionId,
  projectId,
  sessionWorkspaceRoot,
  eventBus,
  inputQueue,
  skillId = 'deskskill-engine-mini',
  sessionTitle = null,
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

  // 2026-08-07 扁平化：cwd 就是项目工作区，`sharedRoot` 和它是同一个目录。
  // 旧代码在这里用 `../../shared` 从会话沙盒爬回共享目录 —— 那条相对路径现在
  // 会爬到数据根之外，两个名字保留只是为了不动下游几十处引用。
  const cwdRoot = sessionWorkspaceRoot;
  const sharedRoot = cwdRoot;
  const sessionMetaRoot = path.join(cwdRoot, '.nd', sessionId);

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
    // 这条消息 push 进了一个无人消费的新 inputQueue —— 不能静默丢。标 run 失败 +
    // emit run.error 让前端弹提示，用户重发即走 pushUserMessage 正常路径。
    if (initialRunId) {
      try { markRunFailed(initialRunId, 'duplicate session registration race'); } catch { /* */ }
    }
    try {
      eventBus.publish({
        type: 'run.error',
        sessionId,
        ...(initialRunId ? { runId: initialRunId } : {}),
        message: '会话正忙，这条消息没有进入队列，请重发一次',
        code: 'DUPLICATE_SESSION',
        ts: new Date().toISOString(),
      });
    } catch { /* */ }
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
  // model 优先级：调用方显式 > session-config.json（用户在 picker 选的，随会话
  // 持久）> env 全局默认。这条链现在只写在 session-model.js 一处 —— 以前它在这里、
  // turn.js、canvas.js 各有一份写法不同的复制品，对不上的时候没人发现。
  const { model: resolvedModel } = await resolveSessionModel(sessionMetaRoot);
  const model = resolvedModel;
  const sdkModel = resolveSdkSpoofModel(model);

  // appModel env：session-level，由 try 块内 + finally 配对管理。详见 line 558 注释。

  const sharedCtx = new AgentContext({
    runId: '__session_pending__',
    skillId,
    eventBus,
    abortController: sessionAbortController,
    workspaceRoot: cwdRoot,
    sessionId,
    appModel: model,
  });

  // ── init 段（2026-07-27 起整体 try/catch）——
  // 老代码这些 await 在主 try 块之外，任一抛错 → Promise reject 只被 turn.js
  // console.error，没有 run.start 也没有 run.error，run 行永远 pending，
  // 前端完全零反馈（丢状态路径 P5）。现在失败时补 run.error + markRunFailed。
  let wsRoot, realGatewayUrl, baseUrlForBinary, fastModel, isResume, installed;
  try {
    wsRoot = await sharedCtx.workspace.ensure();

    // 起手文件拷贝（canvas.template.html 等）2026-07-27 起不再在 init 无条件做 ——
    // 挪到 hooks.js 的 PreToolUse(Skill/Bash)：agent 真的开始 deck 工作
    // （加载 deskskill / cp 模板）才拷。非 deck 会话（便签 / 整理画布）cwd 干净。

    realGatewayUrl = process.env.NODESIGN_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL;
    baseUrlForBinary = realGatewayUrl;
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
    fastModel = process.env.NODESIGN_FAST_MODEL || resolveDefaultFastModel(model);

    // 检测 jsonl 是否已存在 —— 决定走 resume（已存在）还是 sessionId（新建）
    // 之前的 bug：session-loop 永远传 sessionId，但如果用户 close session 后又
    // 用同 sid 起 query（hasActiveQuerySession=false 走 startNewRunSession），
    // SDK binary 看 jsonl 已存在抛 "Session ID ... is already in use"，
    // 子进程死，nodejs 端 stdin write EPIPE 整个 server 挂。
    isResume = await jsonlExistsForSession(cwdRoot, sessionId);

    // 扫已装 plugin（内置 + 用户级 + project 级），返 SDK options 直接用的形态。
    // 装新 plugin 只有重启 session 才生效（v1 接受，详见 plan § "Hot-reload v2"）。
    // skillId 参数（传入的 'deskskill-engine-mini'）保留兼容，但实际 skills 列表以
    // installed.skills 为准 —— 包含所有已装 plugin 内的 skill name 合集。
    // 用户级 plugin 按**项目 owner** 取，不是按"当前请求者"—— 同一个项目谁来跑
    // （owner 自己、后台自发回合、admin 代看）都该是同一套 skill，不然会话行为
    // 会随观看者变。owner 为空（历史项目没回填全）→ 只跳过用户级，别退回共享根。
    installed = await loadInstalledPlugins({
      projectId,
      userId: projectId ? getProject(projectId)?.ownerId : null,
    });
    console.log(
      `[session-loop] plugins=[${installed.plugins.map(p => p.path.split('/').pop()).join(', ')}] `
      + `skills=[${installed.skills.join(', ')}] `
      + `(builtin=${installed.diagnostics.builtin} user=${installed.diagnostics.user} project=${installed.diagnostics.project})`
    );
  } catch (err) {
    console.error(`[session-loop] init failed sid=${sessionId.slice(0, 8)}:`, err.message);
    if (initialRunId) {
      sharedCtx.runId = initialRunId;   // emit 带正确 runId，前端才不会 stale-guard 吞掉
      try { markRunFailed(initialRunId, `init: ${err.message || 'unknown'}`); } catch { /* */ }
    }
    sharedCtx.emit(Events.error(`会话初始化失败：${err.message}`, 'INIT_FAILED', err.stack));
    unregisterQuerySession(sessionId, sessionToken);
    try {
      eventBus.publish({ type: 'run.query.end', sessionId, reason: 'init_failed', ts: new Date().toISOString() });
    } catch { /* */ }
    throw err;
  }

  // MCP server 实例落变量：开局契约自检要从**传给 query 的同一个实例**上取预期
  // 工具名（server.toolNames，见 mcp/index.js）——不另立第二份清单。
  const nodesignServer = createNodesignMcpServer({ workspaceRoot: wsRoot, sharedRoot, projectId, sessionId, ctx: sharedCtx });

  // npm 缓存 + 沙盒可写 tmp（$TMPDIR / pip 缓存）：细节与教训见 isolation.js
  const agentDirs = await prepareAgentDirs({ dataRoot: PROJECTS_DATA_ROOT, projectId, sessionId });

  const sdkEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrlForBinary,
    // 订阅模式（gateway URL 未设）下不能注入 NODESIGN_GATEWAY_KEY —— binary 见到
    // ANTHROPIC_API_KEY 会弃用 ~/.claude 订阅 OAuth。此时 GATEWAY_KEY 仅供
    // generate_image 等业务工具直读。
    ANTHROPIC_API_KEY: realGatewayUrl
      ? (process.env.NODESIGN_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY)
      : process.env.ANTHROPIC_API_KEY,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
    CLAUDE_CONFIG_DIR: platform.claudeConfigDir,
    // auto-memory 强制开启分支（binary gate：DISABLE 置 falsy 值 = force on，
    // 绕过 CLAUDE_CODE_SIMPLE 等后置门；前置门 U$/zl 若拦住则此招无效 → 走自建 B 计划）
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    // 工具搜索：非 alwaysLoad 的 MCP 工具延迟加载（省 ~25-30k 常驻 schema tokens），
    // agent 用 ToolSearch 按需取。白名单见 mcp/index.js ALWAYS_LOAD_TOOLS
    ENABLE_TOOL_SEARCH: 'true',
    // npm_config_cache / CLAUDE_CODE_TMPDIR / PIP_CACHE_DIR（见 isolation.js）
    ...agentDirs.envPatch,
    // auto 模式分类器用哪个模型。判"这个动作越不越界"是需要判断力的活，
    // 默认 opus —— 这一步省钱等于把闸门交给一个更笨的看门人。
    ...(platform.autoModeEnabled ? { CLAUDE_CODE_AUTO_MODE_MODEL: platform.autoModeModel } : {}),
    // bwrap 垫片：绕开 apply-seccomp 的 unshare 竞态（见 isolation.js / ops/sandbox-shim）
    ...sandboxShimEnv({ dataRoot: PROJECTS_DATA_ROOT }),
    // 快速 helper model：默认 claude-haiku-4-5-20251001-cc，env 可覆盖。
    // 用于 SDK 内部 helper（如 task title 总结、auto-compaction 等小调）。
    ...(fastModel ? { ANTHROPIC_SMALL_FAST_MODEL: fastModel } : {}),
  };

  const sdkOptions = {
    cwd: cwdRoot,
    abortController: sessionAbortController,
    // 新建 → sessionId 让 SDK 用我们的 sid；已存在 → resume 续 jsonl 历史
    ...(isResume ? { resume: sessionId } : { sessionId }),
    // title 仅在新建时有效（resume 用持久化的 title）
    ...(sessionTitle && !isResume ? { title: sessionTitle.slice(0, 80) } : {}),
    // additionalDirectories：cwd 外但允许 Read 的目录。
    //   - sharedRoot：project 共享资源（assets / agent-memory / .claude/）
    //   - 每个已装 plugin 根：让 agent 能 Read patterns / references 等 SKILL.md 附件
    //     （SDK Skill 工具只加载 SKILL.md body 自身，附件靠 agent 主动 Read，
    //      要求路径在 sandbox 范围内 — 详见 memory nodesign_sdk_plugin_routes.md）
    additionalDirectories: [
      ...(sharedRoot ? [sharedRoot] : []),
      ...installed.plugins.map(p => p.path),
    ],

    env: sdkEnv,

    // sdkModel = appModel spoofing alias（kimi-k2.6 → claude-opus-4-7[1m]）。
    // 让 SDK 内部 rawMaxTokens=1M，autoCompactWindow=230400 不再被卡 200k；
    // proxy 出口把 alias 还原成真 appModel 给 gateway。详见 model-context.js。
    model: sdkModel,
    tools: toolAllowlist,
    // systemPrompt.append 只放 NODESIGN_PRELUDE（平台协议 / 路径地图 / 工作流硬规则） ——
    // 语义层"平台强制、用户不可覆盖"。SKILL.md（设计方法论） 走 SDK 原生 plugins+skills：
    //   - plugins：加载 server/engine/plugins/nodesign（含 .claude-plugin/plugin.json + skills/）
    //   - skills：把 deskskill-engine-mini 加进 main session 的 skill catalog
    //
    // SDK 行为（sdk.d.ts:1649-1671 / 2598）：SDK 在 system prompt 里给 agent 看到 skill listing
    // （含 frontmatter description，单条截到 1536 字符），agent 自主决定何时通过内置 `Skill`
    // 工具加载 body 进 context。**SDK 自己注入 listing，host 不该再在 prelude 里写硬规则强制
    // invoke** —— description 写好让 agent 主动判断即可。
    //
    // 历史：2026-05-18 之前是 `append: [PRELUDE, skill.systemPrompt].join('\n\n---\n\n')` ——
    // SKILL.md body 全文每 turn 恒驻在 system prompt 里。改造后 system prompt 静态前缀更稳
    // （省 cache），SKILL.md body 只在 agent 真需要决策时进入 context。详见
    // memory/nodesign_system_prompt_architecture.md。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      // 成人段随项目 owner 的外审档联动（agent-shared.renderPrelude）；
      // 找不到 owner 时落 loose 默认，绝不落 off
      append: (() => {
        const owner = projectId ? getUserById(getProject(projectId)?.ownerId) : null;
        return renderPrelude(owner ? levelFor(owner) : 'loose');
      })(),
    },
    plugins: installed.plugins,
    skills: installed.skills,

    // 2026-05-18 安全：关 inline shell execution。SDK 默认允许 skill / slash command 内
    // inline shell 命令（Anthropic 标准 skill 协议的一部分，如 setup script）—— 但 NoDesign
    // 允许用户上传 plugin，若不关 = 用户上传的 SKILL.md 含 shell 命令会被 SDK 真的执行 = RCE。
    // 内置 deskskill-engine-mini 不依赖 inline shell，关掉无功能损失。
    // 详见 memory nodesign_sdk_skills_options_internals.md「安全相关 SDK option」。
    disableSkillShellExecution: true,

    // resume 时不传 permissionMode：SDK 会从 JSONL 读原 session flags + 检查
    // bypassPermissions 必须有 --dangerously-skip-permissions 启动才允许。如果
    // 老 session 是在没这个 flag 的版本下创建的（老 SDK / 老代码），现在硬传
    // permissionMode: 'bypassPermissions' 会让 SDK 抛：
    //   "Cannot set permission mode to bypassPermissions because the session
    //    was not launched with --dangerously-skip-permissions"
    // 这个错没有 runId 会被前端 stale guard 吞掉 → 用户看到"完全没反应"。
    // 修：resume 不传 permissionMode 让 SDK 用 JSONL 保存的；运行时切 mode 通过
    // query.setPermissionMode + turn.js POST /turn 入口的 mode 校正路径完成。
    // 非 plan 的默认模式来自 platform（exp 是 'auto' = 模型分类器判每次调用，
    // 生产仍是 'bypassPermissions'）。plan 照旧优先。
    ...(isResume
      ? {}
      : { permissionMode: initialPermissionMode === 'plan' ? 'plan' : platform.permissionModeDefault }),
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
    // brainstorm + 探索 + 候选样张，但**不能动主产物 / 落决策档案**。
    // - 允许：Read/Grep/Glob/WebFetch/Task/AskUserQuestion，以及
    //   mcp__nodesign__web_search / mcp__nodesign__generate_image（探索性候选样张）
    // - 条件允许：Bash —— 只读探索类（ls/find/cat/grep/...）放开，写命令拒绝
    //   （SDK Glob 不跟 symlink 让 plan 探不到 assets/，必须给 ls 兜底）
    // - 拒绝：Write/Edit + screenshot_canvas / expose_tweaks /
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

      // Plan-mode Bash 条件放开：只读探索（ls / find / cat / grep / wc / diff / jq +
      // git 只读子命令）允许，写命令 / 重定向 / 后台拒绝。背景：SDK Glob 走 ripgrep
      // 默认不跟 symlink，对 assets/（symlink → shared/assets/）返回空让 plan 探
      // 不到工作区——给 agent 留 ls / find 兜底实地查。详见 isReadonlyBashCommand。
      if (currentMode === 'plan' && toolName === 'Bash') {
        const cmd = String(input?.command || '');
        const check = isReadonlyBashCommand(cmd);
        if (!check.ok) {
          return {
            behavior: 'deny',
            message:
              `plan mode Bash 仅放开只读探索类命令；本次拒绝原因：${check.reason}\n`
              + `允许：ls / find / cat / head / tail / grep / awk / wc / diff / jq + git 只读子命令 (status/log/diff/show/...)\n`
              + `不允许：rm / mv / cp / mkdir / touch / chmod、输出重定向 (> >>)、后台 (&)、sed -i、git checkout/commit/reset 等。\n`
              + `要做改动 → 先 ExitPlanMode 提交 plan 让用户批，切回 default 后再动。`,
            interrupt: false,
          };
        }
        return { behavior: 'allow', updatedInput: input };
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

      // auto 模式的升级口：分类器自己拿不准的调用会落到这里（它自己判定要拦的
      // 不会来，直接就拒了）。第一版**只记账不拦**——先看真实用量里都有谁会
      // 升上来，再决定拦不拦；这期间分类器的硬拒照样生效。
      // NODESIGN_AUTO_MODE_ESCALATION=deny 改成拦。
      if (platform.autoModeEnabled && currentMode === 'auto' && toolName !== 'ExitPlanMode') {
        const 因 = options?.decisionReason || options?.title || '(没给原因)';
        console.log(
          `[auto-mode] 升级 sid=${sessionId.slice(0, 8)} tool=${toolName} `
          + `理由=${String(因).replace(/\s+/g, ' ').slice(0, 200)}`,
        );
        if (platform.autoModeEscalation === 'deny' && toolName !== 'AskUserQuestion') {
          return {
            behavior: 'deny',
            message:
              `这个动作没通过平台的自动审批：${String(因).slice(0, 300)}\n`
              + '换个不需要越界的做法；确实必须这么做的话，先跟用户说清楚你要做什么、为什么，让他决定。',
            interrupt: false,
          };
        }
      }

      if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
      const toolUseId = options?.toolUseID;
      if (!toolUseId) {
        return { behavior: 'deny', message: 'AskUserQuestion missing toolUseID', interrupt: false };
      }
      let currentRunId = getCurrentTurnRunId(sessionId);
      if (!currentRunId) {
        // 后台自发 turn（task-notification 唤起）里 agent 问用户 —— 以前直接
        // deny "no active turn"，把带 preview 的候选卡逼退成纯文字。现在铸造
        // 一个真 turn 再放行（mintBackgroundTurn 会 emit run.start 让前端拿到
        // runId，answer 回路照常走）。
        currentRunId = mintBackgroundTurn('AskUserQuestion');
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
      // 项目 memory（2026-07-28 正式启用）：骑 SDK 原生 auto-memory ——
      // 二级索引（MEMORY.md 常驻 + 主题文件按需召回）、召回监督器
      // （run.memory_recall 前端已渲染）、auto-dream 后台固化全由 SDK 包办。
      // ⚠️ 目录必须显式指到项目共享区：默认按 cwd 派生，而 cwd 是会话级的，
      // 不指定则每个会话一座记忆孤岛；指定后全项目所有会话共享一套。
      ...(sharedRoot ? {
        autoMemoryEnabled: true,
        // 落在 .claude/agent-memory/auto —— 跟前端记忆卡读的是同一棵树
        // （2026-07-28 修：之前指到 shared/agent-memory/auto，SDK 记了前端也看不到）
        autoMemoryDirectory: path.join(sharedRoot, '.claude', 'agent-memory', 'auto'),
      } : {}),
    },

    includePartialMessages: STREAMING_ENABLED,
    // 子代理时间轴（2026-07-28）：转发子代理完整对话（text/thinking 也带
    // parent_tool_use_id），前端按它拆「对话」主线和每个子代理的独立时间轴。
    // 默认只透传 tool_use/tool_result（心跳级），不够渲染嵌套 transcript。
    forwardSubagentText: true,

    thinking: pickThinkingConfig(model),
    effort: 'medium',
    // streamInput 模式 query 横跨整个 session，maxTurns 是**全局累计**（每条
    // user message 起一轮 agent loop，turn 数不重置）。15 太低 —— 用户聊几
    // 轮就触顶导致 'error_max_turns' 误中断。改 50 给复杂 deck（多页 +
    // 多次自检 + 子代理）足够余量；env override 给极端情况用
    maxTurns: Number(process.env.NODESIGN_MAX_TURNS)
      || 50,

    // 不传 resume —— streamInput 模式 SDK 内存保 history，不依赖 jsonl
    enableFileCheckpointing: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    forwardSubagentText: true,

    // maxBudgetUsd（2026-07-30 默认撤销）：它只是给 agent 注"USD budget:
    // $X/$N; remaining"的软提醒，SDK 不硬截断；数字还是按 SDK 硬编码价目表
    // × spoofing 模型名算的虚价。订阅 OAuth 模式下实际不按 token 扣费，这个
    // 虚价 reminder 只会给 agent 制造错误紧迫感（少派子代理 / 仓促收尾）——
    // 不传，让 reminder 彻底消失。按量付费网关想要预算线时用
    // NODESIGN_MAX_BUDGET_USD 显式开。
    // （历史：Kimi 时代因 Opus 虚价 30× 把默认从 $10 拉到 $150，现连默认也不要了）
    ...(() => {
      const v = Number(process.env.NODESIGN_MAX_BUDGET_USD);
      return Number.isFinite(v) && v > 0 ? { maxBudgetUsd: v } : {};
    })(),

    // 隔离两道闸（sandbox 管 Bash，permissions.deny 管 Read/Write 这类进程内工具）
    // 全在 agent/isolation.js 里，改之前读那份文件头上的四条实测教训。
    ...buildIsolationOptions({ cwdRoot, sharedRoot, ...agentDirs, dataRoot: PROJECTS_DATA_ROOT, env: sdkEnv }),

    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },

    // projectId 要传：PostToolUseFailure 记问题库时用它标归属（漏传的话
    // issues 行的 project_id 全是 null，事后追不回是哪个项目踩的）
    hooks: createHooks({ ctx: sharedCtx, workspaceRoot: wsRoot, sharedRoot, sessionId, projectId }),

    mcpServers: {
      nodesign: nodesignServer,
    },

    // mainModel = appModel ('kimi-k2.6')，sdkModel = SDK 视角 alias ('claude-opus-4-7[1m]')。
    // vision-checker 用 sdkModel 让 SDK 信 1M context（绕开"喂真 kimi → SDK 不认 →
    // rawMaxTokens fallback 200k"）；其余子代理走 fastModel，跟以前一致。
    agents: createAgents({ mainModel: model, sdkModel, fastModel }),

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
      subagentInputTokens: 0, subagentOutputTokens: 0,
      modelUsage: null,   // absorbResult 差分后填 { model: 本turn增量 }
    };
    sharedCtx.startedAt = Date.now();
    sharedCtx._cancelled = false;        // context.js cancel 幂等 flag 重置
    // 当前 turn id 写到 process.env，让 binary-fixup-proxy 拦截 LLM 请求时拿到
    // 透传成 ND-Trace-Id（NoDesk 后台按 trace 串单轮 LLM 调用链路）。SDK 串行
    // 处理 turn，全局变量在同一时刻只对应一个活动 turn，无 race。
    process.env.NODESIGN_CURRENT_TURN_ID = runId;
    // appModel 重设：cross-session 同进程多 session 时另一 session 可能覆盖了，
    // 这里防御性还原。session-level 主设在下方 try 块入口；finally 配对清。
    process.env.NODESIGN_CURRENT_APP_MODEL = model;
    markRunStarted(runId);
    sharedCtx.emit(Events.start());
  };

  // ── 后台自发 turn 铸造（2026-07-29）──
  // SDK 自己发起的 turn（后台 Task 子代理完成 → task-notification 重新唤起 agent）
  // 没有经过 turn.js POST /turn，没人 createRun / 设 currentRunId。后果：
  //   1. AskUserQuestion 被 canUseTool 以 "no active turn" 拒掉 —— explorer 跑完
  //      准备好三张带 preview 的方向卡片，只能退化成纯文字描述（真实伤口）
  //   2. 整个回合的事件挂在上一个已结束 run 的 runId 上，前端归属混乱
  // 修法：检测到无主 turn 时铸造一个真 run record（createRun → setCurrentTurnRunId
  // → startTurn），让 run.start/run.done、AskUserQuestion answer 回路、runs 审计
  // 全部照常工作。前端 activeRun 由 run.start 设置，answer POST 天然有 runId 可用。
  const mintBackgroundTurn = (reason) => {
    // 归属：后台自发 turn 没有 req.user，用项目 owner（配额/审计口径一致）
    let ownerId = null;
    try { ownerId = getProject(projectId)?.ownerId ?? null; } catch { /* 归属查不到不挡后台回合 */ }
    const run = createRun({
      skillId,
      brief: `(后台回合：${reason})`,
      projectId,
      userId: ownerId,
      metadata: { background: true, mintReason: reason },
    });
    setCurrentTurnRunId(sessionId, run.id);
    startTurn(run.id);
    console.info(
      `[session-loop] sid=${sessionId.slice(0, 8)} minted background turn run=${run.id} (${reason})`,
    );
    return run.id;
  };


  const finishTurn = async (status, info) => {
    if (!activeTurnRunId) return;
    const runId = activeTurnRunId;
    if (status === 'success') {
      const artifactPath = await detectArtifact(sharedCtx);
      mergeRunMetadata(runId, { sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunSucceeded(runId, { artifactPath }); } catch { /* idempotent */ }
      sharedCtx.emit(Events.done(info?.finalText || '', artifactPath, sharedCtx.snapshot ? sharedCtx.snapshot() : { counters: sharedCtx.counters }));
      // recap（2026-08-14 日记本批）：闲时精灵写在画布上的"刚才干了什么/挂着
      // 什么"。fire-and-forget、失败无声 —— 绝不影响收场。发在 run.done 之后：
      // 前端 stale guard 只拦"另一个 run 正在跑"的旧事件，闲时照单全收。
      summarizeRecap({
        finalText: info?.finalText || '',
        toolCount: sharedCtx.counters.toolCalls,
        durationMs: sharedCtx.counters.durationMs || (Date.now() - sharedCtx.startedAt),
      })
        .then((line) => { if (line) sharedCtx.emit(Events.recap(line)); })
        .catch(() => { /* 装饰性小结 */ });
      // 首页大输入框建出来的项目名是垫的：第一轮跑完拿 SDK helper 写的会话摘要
      // 正名一次（只一次，用户改过名就不动）。失败不影响 turn。
      autoNameProjectFromSession(projectId, sessionId)
        .then((name) => {
          if (name) sharedCtx.emit({ type: 'project.renamed', projectId, name });
        })
        .catch((err) => console.warn('[auto-name]', err.message));
    } else if (status === 'cancelled') {
      // 取消掉的 turn 也烧了 token —— counters 一样落库（配额视角是漏收）
      mergeRunMetadata(runId, {
        aborted: true, abortReason: info?.reason || 'user_cancel',
        sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunFailed(runId, `cancelled: ${info?.reason || 'user_cancel'}`); } catch { /* */ }
      sharedCtx.emit({ type: 'run.cancelled', reason: info?.reason || 'user_cancel' });
    } else if (status === 'error') {
      mergeRunMetadata(runId, {
        sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters,
        errorCode: info?.code, errorMessage: info?.message,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunFailed(runId, info?.message || 'unknown'); } catch { /* */ }
      sharedCtx.emit(Events.error(info?.message || 'unknown', info?.code, info?.stack));
    }
    // 工作区一轮一条 commit（2026-08-08）。
    //
    // 在这之前**只有"用户在画布上直接编辑 HTML"那一条路会提交**（canvas.js 的
    // PUT），agent 写文件、mv 文件一次 commit 都不产生 —— 项目仓里基本只有一条
    // init。现在它承担一件具体的活：画布物件的 id 就是工作区相对路径，agent
    // 背着画布 `mv` 一个文件，那张卡的坐标 / 关系线 / 批注全断，而且因为
    // board.objects 是稀疏的，断掉的条目**清都清不掉**。git 的改名检测是唯一
    // 不用引入第二个真相源就能认出"这是同一个东西换了位置"的办法
    // （见 board-store.js 的 reconcileBoardRenames），而它需要有 commit 可比。
    //
    // 失败只 warn：一个 commit 落不下不该让已经跑完的 turn 变成失败。
    // **等它落完再往下走**：对账器（reconcileBoardRenames）靠这条 commit 才看得见
    // agent 这一轮 mv 了什么。不等的话，turn 完成事件触发的那次产物重扫可能跑在
    // commit 前面，改名这一轮就漏掉了。
    await commitWorkspace(projectId, sessionId, `turn ${status}: ${new Date().toISOString()}`, { author: 'agent' })
      .catch((err) => console.warn('[git] turn commit failed:', err.message));

    activeTurnRunId = null;
    markSessionActivity(sessionId);  // turn 结束 = 活跃信号；下次 idle 计时重置
    // 晋升排队的下一 turn（无排队时置 null）—— 追加消息在 turn 内不再抢占
    // currentRunId（见 active-runs pushUserMessage），排队的 runId 在这里接棒。
    // 老逻辑固定置 null 的副作用：mid-turn 追加后第二轮没有 run.start/run.done。
    promoteNextPendingRunId(sessionId);
    // 清掉 turn id 环境变量；下个 turn 的 startTurn 会重设
    delete process.env.NODESIGN_CURRENT_TURN_ID;
    // 注意：NODESIGN_CURRENT_APP_MODEL 不在这里删（session-level 而非 turn-level）。
    // 否则 SDK 的 promptSuggestions / 其他 helper 在 end_turn 之后立即发起的请求
    // 会拿不到 appModel → reverse 不触发 → 真打 DMX Opus 4.7 烧钱。
    // 在 runSession 的 finally 条件清（只清自己设的值）。
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

  // ── 开局契约自检（2026-08-14 空壳钩子灭门案第 3 层，真正治本）──
  //
  // 背景：一个 `{ matcher: 'Bash' }` 空壳钩子条目让 SDK initialize 的大 try 吞掉
  // TypeError → 全部程序化钩子 + 全部 in-process MCP server 无声蒸发，mcp_servers
  // 里连 failed 都不留，会话照常跑 —— 潜伏六天。能静默这么久的结构性原因是这里
  // 从来不消费 system:init：SDK 开局就把「会话里实际有哪些 server / 工具」告诉了
  // 我们，但没人看。
  //
  // 现在对账：nodesign 必须 connected，且 server 实例声明的每个工具（探针实测
  // deferred 工具也在 init.tools 里，27/27）都必须出现。不满足 → recordIssue 进
  // 自动层 + throw 杀会话（外层 catch 走真错路径：markRunFailed + run.error 前端
  // 显式可见）。已知代价：SDK 改 init 形状会误杀会话 —— 但误杀 5 分钟定位，
  // 静默降级是 6 天暗账；工具残废的会话产出是负价值还烧钱，杀掉比放行仁慈。
  const assertInitContract = (init) => {
    const problems = [];
    const nd = (init.mcp_servers || []).find((s) => s.name === 'nodesign');
    if (!nd) {
      problems.push('mcp_servers 里没有 nodesign（in-process MCP server 蒸发，连 failed 状态都不留）');
    } else if (nd.status !== 'connected') {
      problems.push(`nodesign server status=${nd.status}（预期 connected）`);
    }
    const registered = new Set(init.tools || []);
    const expected = (nodesignServer.toolNames || []).map((n) => `mcp__nodesign__${n}`);
    const missing = expected.filter((n) => !registered.has(n));
    if (missing.length) {
      problems.push(`nodesign 工具缺 ${missing.length}/${expected.length}：${missing.join(', ')}`);
    }
    // 权限模式对账（2026-08-15）：**要的和拿到的可能不一样，而且是静默的**。
    // 实测：会话模型是 haiku 时 `permissionMode:'auto'` 会被无声降级成 'default'，
    // init 里照报 default，没有任何报错 —— 分类器一次都不跑，我们却以为它在把关。
    // 只警告不杀：降级后的会话还能干活，杀掉代价大于收益；但必须在日志里喊出来。
    const wantMode = isResume ? null : (initialPermissionMode === 'plan' ? 'plan' : platform.permissionModeDefault);
    if (wantMode && init.permissionMode && init.permissionMode !== wantMode) {
      console.warn(
        `[session-loop] ⚠️ sid=${sessionId.slice(0, 8)} 权限模式被降级：要 ${wantMode}，`
        + `实际 ${init.permissionMode}（模型 ${sdkModel} 可能不支持该模式）`,
      );
    }
    if (!problems.length) {
      console.info(
        `[session-loop] sid=${sessionId.slice(0, 8)} init 契约自检 ✓ `
        + `(nodesign connected, ${expected.length}/${expected.length} tools, `
        + `mode=${init.permissionMode ?? '未报'})`,
      );
      return;
    }
    const detail = problems.join('；');
    // 自动层留案底（fail-soft：记录本身不能变成新故障源）。signature 只含缺失
    // 集合不含 sessionId —— 同一种蒸发聚成一行计数。
    try {
      recordIssue({
        source: 'auto',
        toolName: 'session_init_contract',
        summary: `开局契约自检失败：${detail.slice(0, 120)}`,
        detail,
        projectId,
        sessionId,
        signature: signatureOf(`session_init_contract|${missing.join(',')}|${nd ? nd.status : 'absent'}`),
      });
    } catch { /* ignore */ }
    throw new Error(`开局契约自检失败（杀会话）：${detail}`);
  };

  // ── main stream loop ──

  let stream;
  try {
    // appModel 给 binary-fixup-proxy 用（出口把 SDK spoofing alias 还原成真 model 给 gateway）。
    //
    // 2026-05-10 修：原版只在 startTurn 设、finishTurn 删 —— 但 SDK 的 promptSuggestions
    // helper 在每次 end_turn 之后立刻发请求（复用主 agent 的整套 model + tools + system
    // prompt），那时 env 已被 finishTurn 删 → proxy reverse 不触发 → 真打到 DMX 的
    // Claude Opus 4.7 = 烧钱 leak。
    //
    // 修法：env 改为 session-level —— session 起始（在 try 块内、紧贴 stream 起）设，
    // 整个 session 保持，finally 配对条件清。
    // 放 try 内的关键：万一 try 之前 init 抛错（workspace.ensure / loadSkill /
    // ensureSkillStarterFiles / proxy start / buildSdkOptions 等都可能），env 还没
    // 被设，无 leak 风险。配对的 finally 只清自己设的值（防 cross-session 互写误清）。
    //
    // startTurn 内仍重设（防 cross-session 同进程多 session 互写覆盖；真要严格隔离
    // 需 AsyncLocalStorage，但 NoDesign 默认配置全 session 同 model 无害）。
    process.env.NODESIGN_CURRENT_APP_MODEL = model;

    stream = query({ prompt: inputQueue, options: sdkOptions });
    attachSessionQuery(sessionId, stream);

    // 铅笔精灵的手写短句（2026-08-14 日记本批）：assistant 文本一到先写首句
    // 底稿（refined:false，零成本零延迟），haiku 精修到货再覆盖（refined:true，
    // "墨水显影"）。子代理的话不上精灵 —— 它们有自己的舞台便利贴。
    // 全程 fire-and-forget：精灵写不出俏皮话不能影响 run。
    let lastSummarySrc = '';
    const maybeSpriteSummary = (message) => {
      if (message.parent_tool_use_id) return;
      const text = (message.message?.content || [])
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text).join('\n').trim();
      if (!text || text === lastSummarySrc) return;
      lastSummarySrc = text;
      const round = sharedCtx.counters.turns;
      const draft = clampFirstClause(text);
      if (draft) sharedCtx.emit(Events.spriteSummary(round, draft, false));
      summarizeReply(text)
        .then((line) => {
          if (line && line !== draft) sharedCtx.emit(Events.spriteSummary(round, line, true));
        })
        .catch(() => { /* 装饰性小结，坏了无声 */ });
    };

    // emitContextUsage：fire-and-forget per assistant message
    let usageInFlight = false;
    const emitContextUsage = () => {
      if (usageInFlight) return;
      usageInFlight = true;
      stream.getContextUsage()
        .then((usage) => { if (usage) sharedCtx.emit(Events.contextUsage(usage, sharedCtx.appModel)); })
        .catch(() => { /* fail-soft */ })
        .finally(() => { usageInFlight = false; });
    };

    for await (const message of stream) {
      // 每条 SDK message 都是活跃信号 —— 老逻辑只有 push / turn 边界算活跃，
      // 单个 turn 跑超 30 分钟（多页 deck + 子代理）会被 idle timeout 掐死（P8）
      markSessionActivity(sessionId);

      // 检测 turn 边界：currentRunId 切换 → 新 turn
      const cid = getCurrentTurnRunId(sessionId);
      if (cid && cid !== activeTurnRunId) {
        // 新 turn 开始（前一 turn 应该已 finishTurn — 防御性兜底）
        if (activeTurnRunId) {
          await finishTurn('error', { message: 'turn boundary skipped without result', code: 'TURN_LEAK' });
        }
        startTurn(cid);
      } else if (!cid && !activeTurnRunId && isBackgroundTurnOpener(message)) {
        // SDK 自发 turn（后台 Task 完成通知唤起 agent）—— 没有用户消息、没有
        // runId。铸造一个让整回合事件有正确归属（否则全挂在上一个已结束 run 上）。
        mintBackgroundTurn(`sdk_${message.type}`);
      }

      // 开局契约自检：init 每次到达都对账（新建/resume 各来一次）
      if (message.type === 'system' && message.subtype === 'init') {
        assertInitContract(message);
      }

      handleSDKMessage(sharedCtx, message);

      if (message.type === 'assistant') {
        emitContextUsage();
        maybeSpriteSummary(message);
      }

      if (message.type === 'result') {
        // 计量断链修复（2026-07-30）：result message 的 usage/total_cost_usd 是
        // 本 turn 真增量，从前直接丢弃 → runs 表 token counters 常年全 0。
        // cancelled 也吸收 —— 取消掉的 turn 已经烧了 token，配额要计
        sharedCtx.absorbResult(message);
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
    // session-level appModel env 条件清：只清自己刚才设的值；若 cross-session
    // 互写时另一 session 已覆盖，留给那个 session 自己的 finally 清。防误清。
    if (process.env.NODESIGN_CURRENT_APP_MODEL === model) {
      delete process.env.NODESIGN_CURRENT_APP_MODEL;
    }
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
