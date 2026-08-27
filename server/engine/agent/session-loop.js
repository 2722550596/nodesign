/**
 * server/engine/agent/session-loop.js — Long-running session loop（M1：pi-rp 引擎）
 *
 * M1 换源（doc §5）：执行引擎从 Claude Code SDK `query()` 换成 pi --mode rpc 子进程。
 * 一个 pi 子进程横跨整个 session（conversation state 在 pi 内存 + jsonl 里），每条
 * 用户消息经 RPC `prompt` 发进去恰好对应一个 turn —— **严格串行**，turn 进行中追加
 * 的消息在 inputQueue 里排队等前一个 settle（turn-relay.js）。
 *
 * 结构（init → 消息循环 → finally 清理）：
 *   - init：项目配置（M1 只用 tools.disable）→ 模型路由（只跑 API 行，订阅行抛错）→
 *     buildNodesignTools 拿工具名清单（真注册在 standalone 子进程）→ spawn pi →
 *     PiRpcClient.start()（get_state 探活）
 *   - 消息循环：inputQueue.next() 拉 {runId, text, images} → runTurn（一条消息一个
 *     完整 turn）→ takeNextRunId 提升下一条
 *   - runTurn：每 turn 新建 EventBridge（fresh runId）+ registerRun（sidecar /charge
 *     要按 runId 找 ctx）→ client.prompt → await settle（三来源）→ finishTurn 结账
 *   - finally：drainSession（pending run 标 failed）→ client.kill() → unregister →
 *     run.query.end
 *
 * settle 三来源（互斥，先到先算）：
 *   a) agent_settled 事件 → success（cancelRequested 时 cancelled）
 *   b) 终态 run.error（PROMPT_REJECTED / AUTO_RETRY_EXHAUSTED / STOP_REASON_ERROR）
 *   c) pi 进程退出（onExit）→ PI_EXITED
 * prompt 应答 success:false 走 (b) 的 PROMPT_REJECTED（response 行不进桥，直接判返回值）。
 *
 * 共享 ctx 策略（同 SDK 时代）：一个 sharedCtx 横跨多 turn，每个 turn 开头覆盖 runId
 * + 重置 counters（freshTurnCounters）。sidecar /charge 经 active-runs 按 runId 拿到
 * 它记 addToolCharge，finishTurn 里 _foldToolCharges 折进账。
 *
 * M1 已知缺口（M2/M3 复评，别在这里补）：
 *   AskUserQuestion / elicitation（canUseTool/onElicitation 随 SDK options 一起没了）、
 *   rewind、运行中热切模型、截断续写（maybeContinueTruncated）、后台自发 turn
 *   （mintBackgroundTurn）、context usage 事件、permissionMode 同步、maxTurns、
 *   ingress usage/billing、hooks / isolation / plugins / skills / systemPrompt 组装、
 *   thinking 档位配置。
 */

import path from 'node:path';

import { AgentContext, freshTurnCounters } from './context.js';
import { Events } from './events.js';
import {
  markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata, setRunMetrics, setRunModelUsage,
} from '../runs/store.js';
import {
  registerQuerySession,
  attachSessionQuery,
  unregisterQuerySession,
  setCurrentTurnRunId,
  getSessionLastActivity,
  closeQuerySession,
  markSessionActivity,
  registerRun,
  unregisterRun,
} from '../runs/active-runs.js';
import { takeNextRunId, publishQueueDepth, drainSession } from '../runs/turn-relay.js';
import { loadProjectConfig } from '../../projects/project-config.js';
import { resolveModelRoute } from './model-context.js';
import { resolveSessionModel } from './session-model.js';
import { AsyncQueue } from '../../lib/async-queue.js';
import { detectArtifact } from './agent-shared.js';
import { autoNameProjectFromSession } from '../../projects/auto-name.js';
import { commitWorkspace, PROJECTS_DATA_ROOT } from '../../projects/workspace.js';
import { commitStaging } from '../../projects/board-store.js';
import { PiRpcClient } from '../pi/rpc-client.js';
import { sessionLaunch, createSessionProcess } from '../pi/lifecycle.js';
import { createEventBridge } from '../pi/event-bridge.js';
import { hasPiSession, piSessionDir } from '../pi/pi-jsonl.js';
import { piProviderModelFor } from '../pi/model-map.js';
// mcp/index.js 此刻仍 transitively import SDK（wave 4 才拆），import 没问题。
// 进程内跑一遍 buildNodesignTools 只为拿名字（handler 不用）—— 真注册在
// standalone 子进程（同一函数 + 同一份 disabledTools 过滤 → 名字集严格一致）。
import { buildNodesignTools } from '../mcp/index.js';

/**
 * 终态 run.error 码：命中即本 turn 判死（settle → error），不再等 agent_settled。
 * 其余 run.error（如 EXTENSION_ERROR）是非终态警告 —— 只转发前端，turn 可能仍成功。
 * 码源：event-bridge.js（PROMPT_REJECTED / AUTO_RETRY_EXHAUSTED / STOP_REASON_ERROR）。
 */
const TERMINAL_ERROR_CODES = new Set(['PROMPT_REJECTED', 'AUTO_RETRY_EXHAUSTED', 'STOP_REASON_ERROR']);

/**
 * 起一个 session-level pi-rp 会话。runs 是 per-turn 概念（每条用户消息一个 turn）。
 *
 * **必须**外部维护 inputQueue —— 调用方（turn.js）提前 push 第一条 message
 * （{runId, text, images}）后再调 runSession，session-loop 立即拉到处理。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.projectId
 * @param {string} [opts.ownerId]  - 项目 owner（NODESIGN_UID，pi 子进程身份）
 * @param {string} opts.sessionWorkspaceRoot
 * @param {import('./events.js').EventBus} opts.eventBus
 * @param {import('../../lib/async-queue.js').AsyncQueue} opts.inputQueue
 * @param {string} [opts.skillId='deskskill-engine-mini']
 * @param {string} [opts.initialRunId] - 首条 turn 的 run record id；若给则 register
 *                                       完立即设 currentRunId，避免 turn.js race
 *                                       condition（push 早于 register 没法关联 runId）
 * @returns {Promise<void>}  - inputQueue 关闭 / session abort / pi 退出时 resolve
 */
export async function runSession({
  sessionId,
  projectId,
  ownerId = null,
  sessionWorkspaceRoot,
  eventBus,
  inputQueue,
  skillId = 'deskskill-engine-mini',
  initialRunId = null,
}) {
  if (!sessionId) throw new Error('runSession: sessionId required');
  if (!sessionWorkspaceRoot) throw new Error('runSession: sessionWorkspaceRoot required');
  if (!inputQueue || !(inputQueue instanceof AsyncQueue)) {
    throw new Error('runSession: inputQueue (AsyncQueue) required');
  }
  if (!eventBus) throw new Error('runSession: eventBus required');

  // 2026-08-07 扁平化：cwd 就是项目工作区，`sharedRoot` 和它是同一个目录。
  const cwdRoot = sessionWorkspaceRoot;
  const sharedRoot = cwdRoot;
  const sessionMetaRoot = path.join(cwdRoot, '.nd', sessionId);

  // ── 项目级配置（nodesign.config.json）──
  // M1 只消费 tools.disable（透传给 standalone 整件不注册 + directTools 清单过滤）。
  // prompt.append / prompt.prelude / skills / sdkPreset 休眠到 M2 —— pi 的 system
  // prompt 组装（prelude / skill 协议 / 成人档联动）是 M2 的事，现在读了也没人消费。
  // 文件缺失 = 默认；坏 JSON = 整份落默认（project-config.js 文件头写清楚了）。
  const { config: projectConfig } = await loadProjectConfig(sharedRoot);

  const sessionAbortController = new AbortController();
  // sessionToken：身份证。closeQuerySession 已同步让出 sid 后用户立即重发起新
  // runSession → 新 register 拿到新 token；旧 runSession finally 调 unregister 带
  // 旧 token 比对不匹配 → noop 不误删新 entry。
  const sessionToken = registerQuerySession(sessionId, {
    abortController: sessionAbortController,
    inputQueue,
  });
  // 关键 race guard：registerQuerySession 拒绝重复注册（同 sid 已活跃）→ 这次
  // runSession 是冗余调用（前端 race / 后端 fallback），直接 early return 不 spawn
  // 第二个 pi 子进程。否则两个 pi 并行写同一工作区就是双写 race。
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
  // initialRunId：register 后立刻设 currentRunId（首条消息经 turn.js 直接 push 进
  // queue，没走 pushUserMessage 的认领路径 —— 不提前设，cancelRun / sidecar 按
  // currentRunId 反查会 miss 第一轮）。
  if (initialRunId) setCurrentTurnRunId(sessionId, initialRunId);

  // session-level start event（前端识别 query alive）
  eventBus.publish({ type: 'run.query.start', sessionId, ts: new Date().toISOString() });

  // 模型优先级：session-config.json（用户在 picker 选的）> env 全局默认。
  // 这条链只写在 session-model.js 一处。
  const { model: resolvedModel } = await resolveSessionModel(sessionMetaRoot);
  const model = resolvedModel;

  // sharedCtx：跨 turn 复用。每个 turn 边界覆盖 runId + 重置 counters。
  // sessionId 传入让 ctx.emit 自动 enrich event.sessionId，WS handler 按 sid 过滤
  // 防多 session / 多 tab 跨 session 串扰（project bus 共享）。
  const sharedCtx = new AgentContext({
    runId: '__session_pending__',
    skillId,
    eventBus,
    abortController: sessionAbortController,
    workspaceRoot: cwdRoot,
    sessionId,
    appModel: model,
  });

  // ── 引擎状态（per-session）──
  let currentBridge = null;   // 每个 turn 一个新 EventBridge；turn 之间为 null
  let turnState = null;       // 活跃 turn 的状态（runTurn 里建；settle/usage 都挂它）
  let piExited = null;        // onExit 落下：{ code, signal, err }；非 null = 引擎死了
  let client = null;
  let child = null;

  // ── settle 机制 ──
  // settleTurn 只记录结果 + resolve promise；结账（落库 / emit / commit）统一在
  // finishTurn，保证恰好一次。三个来源都经它（互斥，先到先算）。
  function settleTurn(outcome) {
    const st = turnState;
    if (!st || st.settled) return;
    st.settled = true;
    st.outcome = outcome;
    st.settleResolve();
  }

  // agent_settled → success；interrupt 过（cancelRequested）→ cancelled
  function onSettled() {
    if (!turnState || turnState.settled) return;
    settleTurn(turnState.cancelRequested
      ? { outcome: 'cancelled', reason: 'user_cancel' }
      : { outcome: 'success' });
  }

  // pi 进程死掉：活跃 turn 以 PI_EXITED 收尾；inputQueue 关掉让消息循环退出
  // （pending 的 run 归 finally 的 drainSession 标 failed）。
  function onPiExit(code, signal, err) {
    piExited = { code, signal, err };
    console.warn(
      `[session-loop] sid=${sessionId.slice(0, 8)} pi 进程退出`
      + `（code=${code} signal=${signal}${err ? ` ${err.message}` : ''}）`
    );
    if (turnState && !turnState.settled) {
      settleTurn({
        outcome: 'error',
        code: 'PI_EXITED',
        message: `pi 进程退出（code=${code} signal=${signal}${err ? `：${err.message}` : ''}）`,
      });
    }
    try { inputQueue.close(); } catch { /* 已 close 是常态 */ }
  }

  // session 关闭（closeQuerySession → abort）→ 当前 turn 走 cancelled。
  // 与 interrupt 路径共用 settleTurn 的幂等（先到先算）。
  const onSessionAbort = () => {
    if (turnState && !turnState.settled) {
      turnState.cancelRequested = true;
      settleTurn({ outcome: 'cancelled', reason: sessionAbortController.signal.reason || 'session_closed' });
    }
  };
  sessionAbortController.signal.addEventListener('abort', onSessionAbort, { once: true });

  // usage 累计：pi 每轮 assistant message_end 带**该轮** usage（不是会话累计），
  // 逐轮累进 turn 级累计器。⚠️ 必须在 bridge.handleLine 之前自己留一份 ——
  // bridge 只保留最后一轮的 finalUsage。
  function accumulateUsage(acc, usage) {
    acc.inputTokens += usage.input ?? 0;
    acc.outputTokens += usage.output ?? 0;
    acc.cacheReadTokens += usage.cacheRead ?? 0;
    acc.cacheCreateTokens += usage.cacheWrite ?? 0;
    acc.totalCostUsd += usage.cost?.total ?? 0;
  }

  // ── init 段 —— 失败时补 run.error + markRunFailed，不让 run 行永远 pending ──
  let wsRoot;
  try {
    wsRoot = await sharedCtx.workspace.ensure();

    // 模型路由：M1 只跑 API 行。订阅行（claude-sonnet-5[1m] 等）在 M1 整体禁用 ——
    // 这是三层防御的第二层（turn.js 403 是第一层，selectableModelsFor 锁行是第三层）。
    const route = resolveModelRoute(model);
    if (route.mode !== 'api') {
      throw new Error(`M1 订阅通道整体禁用，模型=${model} 不可路由（换 API 模型）`);
    }
    // appModel → pi 扩展 (provider, wireModel)。查不到 = providers-models.json 没
    // 覆盖这行 → init 失败（别静默让 pi 用它自己的默认模型跑）。
    const piRoute = piProviderModelFor(model);
    if (!piRoute) {
      throw new Error(`模型 ${model} 没有 pi-rp 扩展映射（providers-models.json _appModels 未命中）`);
    }

    // 工具清单：与 standalone 注册集严格一致（同一个 buildNodesignTools + 同一份
    // disabledTools）。handler 不在进程内用 —— 工具真跑在 standalone MCP 子进程。
    const disabledTools = projectConfig?.tools?.disable ?? [];
    const toolDefs = buildNodesignTools({
      workspaceRoot: wsRoot, sharedRoot, projectId, sessionId, ctx: sharedCtx, disabledTools,
    });
    const directTools = toolDefs.map((t) => t.name);

    // resume 检测：pi 转录已存在 → --continue（续写同一 session 文件）。
    // SDK 时代的 jsonlExistsForSession（~/.claude/projects/）换成 pi-sessions/。
    const resume = await hasPiSession(piSessionDir(PROJECTS_DATA_ROOT, sessionId));

    // sidecar 端口 = 主进程 HTTP 端口（lifecycle 拼 NODESIGN_MAIN_URL 给子进程回连）。
    // 与 server/index.js 的 PORT 解析同口径。
    const port = Number(process.env.PORT || 4001);

    const launch = sessionLaunch({
      sid: sessionId,
      projectId,
      ownerId,
      workspaceDir: wsRoot,
      dataRoot: PROJECTS_DATA_ROOT,
      resume,
      provider: piRoute.provider,
      model: piRoute.model,
      port,
      directTools,
      disabledTools,
    });
    child = createSessionProcess(launch);

    client = new PiRpcClient({
      child,
      onEvent: (obj) => {
        markSessionActivity(sessionId);   // 每条事件都是活跃信号（长 turn 不被 idle 掐）
        // usage 累计必须在 bridge 之前（bridge 只留最后一轮）
        if (obj?.type === 'message_end' && obj.message?.role === 'assistant'
          && obj.message?.usage && turnState) {
          accumulateUsage(turnState.usageAcc, obj.message.usage);
        }
        // preset 激活是**会话级**事件（set_preset 可在 turn 之间发），bridge 是 per-turn
        // 的会漏 —— 直接发 eventBus，runId 置 null。前端据此刷新 preset 显示。
        if (obj?.type === 'preset_activated') {
          try {
            eventBus.publish({ type: 'run.preset_activated', sessionId, presetId: obj.presetId ?? null, ts: new Date().toISOString() });
          } catch { /* bus 异常不弄死会话 */ }
        }
        currentBridge?.handleLine(obj);
        if (obj?.type === 'agent_settled') onSettled();
      },
      onExit: (code, signal, err) => onPiExit(code, signal, err),
      stderr: (line) => console.error(`[session ${sessionId.slice(0, 8)}/pi.stderr]`, line),
    });

    // cancelRun 的 streamInput 路径调 qRec.query.interrupt() —— attach 的"query"
    // 就是这个 shim：记 cancelRequested（agent_settled 到达时判 cancelled）+ 发 abort。
    // 5s 兜底：pi 收了 abort 却不 settle（卡死）时强制结账，前端不挂 streaming。
    attachSessionQuery(sessionId, {
      interrupt: () => {
        if (turnState) turnState.cancelRequested = true;
        const p = client.abort().catch(() => { /* 进程可能已死 */ });
        setTimeout(() => {
          if (turnState && !turnState.settled && turnState.cancelRequested) {
            console.warn(`[session-loop] sid=${sessionId.slice(0, 8)} interrupt 后 5s 未 settle，强制按 cancelled 结账`);
            settleTurn({ outcome: 'cancelled', reason: 'user_cancel:interrupt_timeout' });
          }
        }, 5000).unref?.();
        return p;
      },
      // M1.5 RPC 直通：热换模型 / thinking 档位 / 会话统计。
      // 调用方（turn-model-switch.js 等）经 getQuerySession(sid).query 拿到。
      setModel: (provider, modelId) => client.setModel(provider, modelId),
      setThinkingLevel: (level) => client.setThinkingLevel(level),
      getSessionStats: () => client.getSessionStats(),
      // M2 前置：preset 运行中切换（set_preset RPC）+ 状态现问（activePresetId 可观测）。
      setPreset: (presetId) => client.setPreset(presetId),
      getState: () => client.getState(),
    });

    await client.start();   // get_state 探活；失败抛错（带 stderr 尾巴）
  } catch (err) {
    console.error(`[session-loop] init failed sid=${sessionId.slice(0, 8)}:`, err.message);
    // 子进程可能已 spawn —— 收掉，别留孤儿（lifecycle 的进程级钩子只兜主进程退出）
    try {
      if (client) { await client.kill(); client.dispose(); }
      else if (child) { child.kill('SIGKILL'); }
    } catch { /* */ }
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

  // ── per-turn lifecycle ──

  /**
   * 建本 turn 的 EventBridge。emit 包装的分工：
   *   - 收场三事件（run.done / run.cancelled / 终态 run.error）一律**吞掉**——
   *     finishTurn 是它们唯一的权威出口（带 artifactPath / token / 正确 reason）。
   *     桥的 run.done 缺 artifactPath/token；桥的 run.cancelled（abort 应答路径）
   *     与 finishTurn 的 Events.cancelled 重复；终态 run.error 与 finishTurn 的
   *     Events.error 重复。转发会造成前端双弹。
   *   - 终态 run.error 虽吞转发，但要 settle 本 turn 为 error（settle 三来源之一）。
   *   - 非终态 run.error（EXTENSION_ERROR 等）→ 只转发，不 settle（turn 可能仍成功）。
   *   - 其余事件（delta / tool / compact / rate_limit / queue_update…）→ 直接转发。
   * 桥的 out() 已把 {runId, sessionId, ts} 富化进事件，直接 publish 即可。
   */
  function makeBridge(runId) {
    return createEventBridge({
      emit: (evt) => {
        if (evt.type === 'run.done' || evt.type === 'run.cancelled') return;
        if (evt.type === 'run.error') {
          if (TERMINAL_ERROR_CODES.has(evt.code)) {
            settleTurn({ outcome: 'error', code: evt.code, message: evt.message || evt.code });
            return;   // 吞转发：finishTurn 发权威 Events.error
          }
          // 非终态（EXTENSION_ERROR 等）：只转发，不 settle
        }
        try { eventBus.publish(evt); } catch { /* bus 异常不弄死 turn */ }
      },
      run: { runId, uid: ownerId, sessionId, model, pid: child?.pid },
      isTurnActive: () => client.isTurnActive(),
    });
  }

  /**
   * 一条用户消息 = 一个完整 turn。
   * 流程：重置 sharedCtx → 建桥 → registerRun → markRunStarted → prompt →
   * await settle → finishTurn。settle 之前绝不返回（串行纪律的锚）。
   */
  async function runTurn({ runId, text, images }) {
    // per-turn 重置（context-counters.test.js 钉着 counters 这行的形状）
    sharedCtx.runId = runId;
    sharedCtx.counters = freshTurnCounters();
    sharedCtx.startedAt = Date.now();
    sharedCtx._cancelled = false;        // context.js cancel 幂等 flag 重置

    const st = {
      runId,
      cancelRequested: false,
      settled: false,
      outcome: null,
      usageAcc: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalCostUsd: 0 },
    };
    st.settlePromise = new Promise((resolve) => { st.settleResolve = resolve; });
    turnState = st;
    currentBridge = makeBridge(runId);

    // sidecar /charge 按 runId → ctx 记 addToolCharge（active-runs 要求 abortController 非空）
    registerRun(runId, { abortController: sessionAbortController, ctx: sharedCtx });

    markSessionActivity(sessionId);      // turn 边界 = 活跃信号
    process.env.NODESIGN_CURRENT_TURN_ID = runId;
    try { markRunStarted(runId); } catch (err) {
      console.warn(`[session-loop] sid=${sessionId.slice(0, 8)} markRunStarted(${runId}) failed: ${err.message}`);
    }
    // run.start 由桥在首个 agent_start 时发（带 model/pid）—— 这里不另发 Events.start()

    try {
      // response 行不进桥（rpc-client 内部消化）—— success:false 直接判返回值
      const resp = await client.prompt(text, { id: runId, images: images?.length ? images : undefined });
      if (resp && resp.success === false) {
        settleTurn({ outcome: 'error', code: 'PROMPT_REJECTED', message: resp.error || 'prompt rejected' });
      }
    } catch (err) {
      // stdin 写失败 / 进程已死（onPiExit 通常已先 settle PI_EXITED；这里是兜底）
      settleTurn({ outcome: 'error', code: 'PI_EXITED', message: err.message || 'prompt failed' });
    }

    await st.settlePromise;
    await finishTurn(st, currentBridge);
  }

  /**
   * 结账：恰好一次。落库（metrics / modelUsage / metadata / 状态）+ emit 收场事件
   * （done / cancelled / error）+ 工作区 commit + 清理 per-turn 引用。
   */
  async function finishTurn(st, bridge) {
    const runId = st.runId;
    const outcome = st.outcome || { outcome: 'error', code: 'UNKNOWN', message: 'turn 无结算结果' };
    turnState = null;
    currentBridge = null;   // 此后的事件（迟到的 settled 等）无桥可进，丢弃

    // ── 计量 ──
    // pi usage 累计 → counters 主字段 + 分模型明细（M1 无热切换，单模型 = appModel）。
    const acc = st.usageAcc;
    sharedCtx.counters.inputTokens = acc.inputTokens;
    sharedCtx.counters.outputTokens = acc.outputTokens;
    sharedCtx.counters.cacheReadTokens = acc.cacheReadTokens;
    sharedCtx.counters.cacheCreateTokens = acc.cacheCreateTokens;
    sharedCtx.counters.totalCostUsd = acc.totalCostUsd;
    sharedCtx.counters.modelUsage = {
      [model]: {
        inputTokens: acc.inputTokens, outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadTokens, cacheCreateTokens: acc.cacheCreateTokens,
        costUsd: acc.totalCostUsd,
      },
    };
    // 桥的可观测计数（turns / toolCalls / toolFailures / compactBoundaries / apiRetries）
    const finalText = bridge ? [...bridge.state.textByIndex.values()].join('') : '';
    if (bridge) {
      const bc = bridge.state.counters;
      sharedCtx.counters.turns = bc.turns;
      sharedCtx.counters.toolCalls = bc.toolCalls;
      sharedCtx.counters.toolFailures = bc.toolFailures;
      sharedCtx.counters.compactBoundaries = bc.compactBoundaries;
      sharedCtx.counters.apiRetries = bc.apiRetries;
    }
    // 按件计价的工具花费（sidecar /charge 记的 generate_image 等）折进 modelUsage ——
    // SDK 时代是 absorbResult 调的，现在必须显式调（它会重算 totalCostUsd，所以
    // 必须在 usage 落 counters 之后）。
    sharedCtx._foldToolCharges();

    if (outcome.outcome === 'success') {
      const artifactPath = await detectArtifact(sharedCtx);
      mergeRunMetadata(runId, {
        ...sharedCtx.counters,
        stopReason: bridge?.state.stopReason ?? null,
        wireModel: bridge?.state.model ?? null,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunSucceeded(runId, { artifactPath }); } catch { /* idempotent */ }
      sharedCtx.emit(Events.done(finalText, artifactPath, sharedCtx.snapshot()));
      // 首页大输入框建的项目名是垫的：第一轮跑完拿 pi 会话摘要正名一次（只一次，
      // 用户改过名就不动）。失败不影响 turn。
      autoNameProjectFromSession(projectId, sessionId)
        .then((name) => {
          if (name) sharedCtx.emit({ type: 'project.renamed', projectId, name });
        })
        .catch((err) => console.warn('[auto-name]', err.message));
    } else if (outcome.outcome === 'cancelled') {
      // 取消掉的 turn 也烧了 token —— counters 一样落库（配额视角不能漏收）
      mergeRunMetadata(runId, {
        aborted: true, abortReason: outcome.reason || 'user_cancel',
        ...sharedCtx.counters,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      // 沿用 SDK 时代口径：cancelled 落 failed（'cancelled: reason'），配额 sum 不断
      try { markRunFailed(runId, `cancelled: ${outcome.reason || 'user_cancel'}`); } catch { /* */ }
      sharedCtx.emit(Events.cancelled(outcome.reason || 'user_cancel'));
    } else {
      mergeRunMetadata(runId, {
        ...sharedCtx.counters,
        errorCode: outcome.code, errorMessage: outcome.message,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunFailed(runId, outcome.message || outcome.code || 'unknown'); } catch { /* */ }
      sharedCtx.emit(Events.error(outcome.message || 'unknown', outcome.code));
    }

    // 工作区一轮一条 commit（画布物件 id = 相对路径，git 改名检测是 reconcile 的
    // 唯一真相源，见 board-store.js reconcileBoardRenames）。失败只 warn。
    await commitWorkspace(projectId, sessionId, `turn ${outcome.outcome}: ${new Date().toISOString()}`, { author: 'agent' })
      .catch((err) => console.warn('[git] turn commit failed:', err.message));

    // 黑板草稿兜底落定：agent 这轮 sketch_on_board 留下的 staging 物件，没调
    // finish_sketch 也在回合结束时变实。取消/出错同样落定：画了就是画了。
    if (projectId) {
      try {
        const { committed } = await commitStaging(projectId);
        if (committed > 0) sharedCtx.emit({ type: 'board.updated', sessionId: null, summary: `黑板草稿落定 ${committed} 件` });
      } catch (err) { console.warn('[board] commitStaging failed:', err.message); }
    }

    unregisterRun(runId);
    markSessionActivity(sessionId);  // turn 结束 = 活跃信号；下次 idle 计时重置
    delete process.env.NODESIGN_CURRENT_TURN_ID;
    // currentRunId 的让出 + 下一条晋升归主循环的 takeNextRunId（原子，无窗口）
  }

  // ── idle timeout 兜底 ──
  // 用户关 tab 后 WS-disconnect grace 是常规清理路径；这里再加一道：
  // session 超过 IDLE_TIMEOUT 无任何活动（push message / turn 边界）→ 自动关。
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

  // ── main message loop（严格串行）──
  try {
    while (!sessionAbortController.signal.aborted && !piExited) {
      const item = await inputQueue.next();   // close → done
      if (item.done) break;
      const { runId, text, images } = item.value;
      await runTurn({ runId, text, images });   // 一条消息 = 一个完整 turn
      // turn 结束后原子释放 + FIFO 提升下一条（串行化后安全：turn 边界就是我们
      // 自己的 settle 点，不再需要 SDK 时代的 uuid 回显锚）
      takeNextRunId(sessionId);
      publishQueueDepth(eventBus, sessionId);   // 让前端"已排队 N 条"递减
    }
    // 循环结束三种情形：inputQueue close（session close / pi 退出） / session abort /
    // piExited。活跃 turn 已在 runTurn 内经 onSessionAbort / onPiExit settle
    // （cancelled / PI_EXITED），这里不存在 in-flight turn。
  } catch (err) {
    // 真错路径（消息循环本身炸了 —— runTurn 内部已自结账，这里只剩意外）
    if (sessionAbortController.signal.aborted) {
      // close session 路径：静默退出，finally 发 run.query.end
    } else {
      console.error(`[session-loop] sid=${sessionId.slice(0, 8)} message loop error:`, err.message);
      sharedCtx.emit(Events.error(err.message, err.code, err.stack));
    }
  } finally {
    clearInterval(idleScanTimer);
    sessionAbortController.signal.removeEventListener('abort', onSessionAbort);
    // 排队中没跑到的 run 标 failed（run 行不能永远停 pending）；inputQueue 的 close
    // 归 unregisterQuerySession（它持有 queue 生命周期）
    drainSession(sessionId);
    // pi 子进程收尾：abort → 5s → SIGTERM → 2s → SIGKILL（幂等；已死立即返回）
    try {
      if (client) {
        await client.kill();
        client.dispose();
      }
    } catch { /* */ }
    // 带 token 比对：sid 若已被新 register 占用，unregister 看到 _token 不匹配 → noop
    unregisterQuerySession(sessionId, sessionToken);
    // session-level end event
    try {
      eventBus.publish({
        type: 'run.query.end',
        sessionId,
        reason: piExited
          ? 'pi_exited'
          : sessionAbortController.signal.aborted
            ? (sessionAbortController.signal.reason || 'aborted')
            : 'closed',
        ts: new Date().toISOString(),
      });
    } catch { /* */ }
  }
}
