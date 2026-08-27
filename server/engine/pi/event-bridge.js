/**
 * server/engine/pi/event-bridge.js — pi RPC 事件流 → Nodesign EventBus 事件桥（M1 硬化版）
 *
 * 目标：把 pi rpc-mode 的 stdout JSON 行（AgentSessionEvent，事件表见
 * ~/projects/pi-rp/packages/coding-agent/docs/rpc.md:926-954）翻译成 Nodesign 前端
 * 消费的 run.* 事件（契约见 server/engine/agent/events.js 的 Events 构造器与
 * engine/README.md 事件表）。
 *
 * 生命周期（M1 约定）：rpc-client 每 turn 新建一个 bridge（fresh runId），
 * turn_start 重置 text/thinking 累积 —— 一个 bridge 实例只对应一个 run 的事件流。
 *
 * 用法：
 *   import { createEventBridge } from './event-bridge.js';
 *   const bridge = createEventBridge({
 *     emit: (evt) => bus.publish(evt),
 *     run: { runId, uid, sessionId, model, pid },   // M1 run 上下文（见下方约定）
 *     isTurnActive: () => boolean,                  // 可选：abort 空闲门控（见 handleResponse）
 *   });
 *   for (const line of jsonLines) bridge.handleLine(JSON.parse(line));
 *
 * 设计约定：
 *   - 每行独立判定；跨行状态只存"必须累积"的：text/thinking 块（按 contentIndex
 *     累积，run.done 的 finalText 用）、usage 快照、toolCallId 配对与去重、
 *     toolcall_start 的 id/name 捕获（tool_input 配对用）、round。
 *   - 事件富化对齐 AgentContext.emit（server/engine/agent/context.js:132-141）：
 *     { runId, sessionId, ts, ...event }，调用方显式字段不被覆盖。
 *   - 输出载荷字段逐项对照 Events 构造器：
 *       run.delta.text       { round, text }           ← text 是增量块（前端 appendTextDelta 累加）
 *       run.delta.thinking   { round, text }           ← 同上，role='thinking'
 *       run.delta.tool_use   { round, blockId, name, input }
 *       run.delta.tool_input { round, blockId, name, append }  ← toolcall_delta 参数流式增量
 *       run.delta.tool_result{ round, blockId, name, ok, output?, error? }
 *       run.tool_progress    { blockId, toolName }     ← tool_execution_update（elapsedSeconds 无来源，省略）
 *       run.queue.depth      { sessionId, depth }      ← queue_update（steering+followUp 数组长度和）
 *       run.compact_boundary { compactMetadata }
 *       run.status           { status: 'compacting' | null }
 *       run.rate_limit       { info }
 *       run.cancelled        { reason }
 *       run.done             { finalText, snapshot: { counters, model, stopReason, usage } }
 *       run.error            { message, code?, stack? }
 *   - handleLine(line) 返回 { event, payload } | null（不传 emit 时可纯函数式测试）。
 *   - 被忽略的事件返回 null，忽略原因写在同一 case 的注释里（M1 复核用）。
 *
 * 字段名以 /tmp/nd-m0-probe/events.jsonl 实测为准；与 rpc.md 的差异标 [doc-diff]。
 */

/** usage 快照里可能带 cost 明细；只挑前端/统计需要的标量字段，避免整对象透传。 */
function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
  // [doc-diff] rpc.md 的 usage 只有 input/output/cacheRead/cacheWrite/totalTokens/cost；
  // 实测 message_end.message.usage 多了 reasoning（thinking token 数，M3 流里 382）。
  if (typeof usage.reasoning === 'number') out.reasoning = usage.reasoning;
  if (usage.cost && typeof usage.cost === 'object') {
    out.cost = {
      input: usage.cost.input ?? 0,
      output: usage.cost.output ?? 0,
      cacheRead: usage.cost.cacheRead ?? 0,
      cacheWrite: usage.cost.cacheWrite ?? 0,
      total: usage.cost.total ?? 0,
    };
  }
  return out;
}

/** tool_execution_end.result → 展示文本：content 是 content block 数组，取 text 拼接。 */
function toolResultText(result) {
  if (!result || typeof result !== 'object') return '';
  if (Array.isArray(result.content)) {
    return result.content
      .filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return typeof result.text === 'string' ? result.text : '';
}

/**
 * rate-limit 判别（§4.5 草案：run.rate_limit ← error 事件）。pi RPC 的瞬时错误走
 * auto_retry_* 事件，错误文本形如 "529 {"type":"error",...,"type":"overloaded_error"}"
 * （rpc.md:1176-1203）。判据：429 / rate_limit 才算限流；529 overloaded 是 5xx 瞬时
 * 过载（rpc.md 自动重试默认就覆盖它），不算 rate_limit。M1 需对真实 provider 错误复核
 * （TODO）：上游可能只回 "rate limit" 无 429 / 无 "rate_limit" 字样。
 */
function isRateLimitMessage(s) {
  return typeof s === 'string' && /rate[_ -]?limit|\b429\b/i.test(s);
}

/**
 * @param {object} opts
 * @param {(evt: object) => void} [opts.emit]  缺省则纯模式：handleLine 只返回不发射
 * @param {object} [opts.run]  M1 run 上下文契约：{ runId, uid, sessionId, model, pid }。
 *        bridge 只消费 runId/sessionId（富化到每条事件）+ model/pid（run.start 载荷、
 *        run.done snapshot）。M1 由 rpc-client 每 turn 建一个 bridge 实例。
 * @param {() => boolean} [opts.isTurnActive]  abort 空闲门控：返回当前 turn 是否活跃。
 *        提供且返回 false 时，abort success:true 视为空闲 abort（pi 幂等、仍回 success）
 *        而被忽略，防止误发 run.cancelled；不提供则保持 M0 行为（abort success → cancelled）。
 */
export function createEventBridge({ emit, run = {}, isTurnActive } = {}) {
  const state = {
    round: 0,                  // 1-based turn 序数，turn_start 自增
    runStarted: false,         // 首个 agent_start 发过 run.start 后才算
    runDoneEmitted: false,
    cancelled: false,          // abort 响应 → run.cancelled；settled 时不再发 run.done
    textByIndex: new Map(),    // contentIndex → 累积文本（run.done finalText 用）
    thinkingByIndex: new Map(),// contentIndex → 累积 thinking（重放完整性校验用）
    toolNames: new Map(),      // toolCallId → toolName（tool_result 兜底）
    emittedToolUses: new Set(),// toolCallId 去重：toolcall_end 与 tool_execution_start 双路径只发一次
    toolcallStarts: new Map(), // contentIndex → {id,name}：toolcall_start 捕获（toolcall_delta → tool_input 配对；实测流无 id，拿不到则 delta 忽略）
    lastUpdateUsage: null,     // message_update 顶层 usage（流式快照；实测全程是初始快照值）
    finalUsage: null,          // message_end.message.usage（权威最终值，含 reasoning）
    stopReason: null,
    model: run.model || null,
    counters: {
      turns: 0,
      toolCalls: 0,
      toolFailures: 0,
      compactBoundaries: 0,
      textDeltas: 0,
      thinkingDeltas: 0,
      apiRetries: 0,
    },
  };

  function out(type, payload) {
    const event = {
      runId: run.runId ?? null,
      sessionId: run.sessionId ?? null,
      ts: new Date().toISOString(),
      type,
      ...payload,
    };
    if (emit) emit(event);
    return { event, payload };
  }

  // ── 各事件类型 → 0..N 个 run 事件 ──

  function handleResponse(line) {
    // prompt 受理失败（success:false = 接受前被拒，rpc.md:76）→ run.error
    if (line.command === 'prompt' && line.success === false) {
      return out('run.error', { message: line.error || 'prompt rejected', code: 'PROMPT_REJECTED' });
    }
    // abort 响应 → run.cancelled；settled 时据此不发 run.done（收场三信号互斥，
    // 对齐 session-loop.js:775-793 的 cancelled/error/done 分支）。
    // M1 决策（空闲 abort 门控）：pi 对无活跃 turn 的 abort 是幂等的，仍回 success:true；
    // 若照单全收，用户在空闲期点停止会给一个早已结束的 run 误发 cancelled。
    // 故：调用方提供 isTurnActive 且返回 false 时按"没取消任何东西"忽略；
    // 未提供门控则保持 M0 行为（rpc-client 波次2 应提供）。
    if (line.command === 'abort' && line.success === true) {
      if (typeof isTurnActive === 'function' && isTurnActive() !== true) return null;
      state.cancelled = true;
      return out('run.cancelled', { reason: 'abort_requested' });
    }
    // 其余 response（prompt 成功受理 / get_last_assistant_text / get_state / …）不产生 run 事件
    return null;
  }

  function handleAgentStart() {
    // run.start：§4.5「首个 agent_start」。auto-retry 会再发 agent_start，
    // 同一 run 只发一次；M1 每 turn 新建 bridge，天然隔离。
    // model 由 rpc-client 从 run.model 传入（spawn 配置/get_state）——message_start 的
    // wire model 晚到，只作 state.model 的兜底更新，run.start 用的是 run 初始值。
    if (state.runStarted) return null;
    state.runStarted = true;
    return out('run.start', {
      ...(state.model ? { model: state.model } : {}),
      ...(run.pid != null ? { pid: run.pid } : {}),
    });
  }

  function handleTurnStart() {
    state.round += 1;
    state.counters.turns += 1;
    // 新一轮：文本块从头累积，run.done finalText = 最后一轮的正文
    state.textByIndex.clear();
    state.thinkingByIndex.clear();
    return null; // 生命周期边界；前端从 run.start/run.done 推 turn，无需单独事件
  }

  function handleMessageStart(line) {
    const msg = line.message;
    if (msg && msg.role === 'assistant') {
      // [doc-diff] message_start 的 usage/stopReason/responseId 在 message 内部
      //（实测顶层没有）；model 是 wire id（如 MiniMaxAI/MiniMax-M3）。
      if (typeof msg.model === 'string') state.model = msg.model;
      // role 边界标记：不需要。chat-stream.js appendTextDelta 在首个 delta 时按
      // role（'assistant'/'thinking'）自动建消息，thinking→text 的切换由 role 区分，
      // 无需额外事件（对照 Nodesign 现有流：SDK 时代也没有 role 边界事件）。
    }
    return null;
  }

  function handleMessageUpdate(line) {
    const ame = line.assistantMessageEvent;
    if (!ame || typeof ame !== 'object' || typeof ame.type !== 'string') return null;
    // usage 每条 message_update 都带，但实测全程是**初始快照**值（流式期不更新；
    // rpc.md:1054 亦言"may remain zero until completion"）——吸收仅作 message_end 缺失兜底。
    // ⭐ 权威终值是 message_end.message.usage（含 reasoning），见 handleMessageEnd。
    if (line.usage && typeof line.usage === 'object') state.lastUpdateUsage = line.usage;

    const idx = typeof ame.contentIndex === 'number' ? ame.contentIndex : 0;
    switch (ame.type) {
      case 'thinking_start':
        state.thinkingByIndex.set(idx, '');
        return null;
      case 'thinking_delta': {
        state.counters.thinkingDeltas += 1;
        const acc = state.thinkingByIndex.get(idx) ?? '';
        state.thinkingByIndex.set(idx, acc + (ame.delta ?? ''));
        return out('run.delta.thinking', { round: state.round, text: ame.delta ?? '' });
      }
      case 'thinking_end':
        return null; // content 全量已由 delta 发完；这里仅闭合块
      case 'text_start':
        state.textByIndex.set(idx, '');
        return null;
      case 'text_delta': {
        state.counters.textDeltas += 1;
        const acc = state.textByIndex.get(idx) ?? '';
        state.textByIndex.set(idx, acc + (ame.delta ?? ''));
        return out('run.delta.text', { round: state.round, text: ame.delta ?? '' });
      }
      case 'text_end':
        return null;
      case 'toolcall_start': {
        // [doc-diff] 实测 RPC 流里 toolcall_start 只有 {type,contentIndex}（ai 层事件无 id，
        // json-event.ts 又剥掉 partial）；仅 proxy/pi-messages 变体带 id/toolName。
        // 有则捕获，供后续 toolcall_delta 发 run.delta.tool_input；拿不到则 delta 忽略（M1 决策）。
        const id = ame.id ?? ame.toolCall?.id ?? null;
        const name = ame.toolName ?? ame.toolCall?.name ?? null;
        if (id && name) state.toolcallStarts.set(idx, { id, name });
        return null;
      }
      case 'toolcall_delta': {
        // 工具参数流式增量 → run.delta.tool_input（Events.deltaToolInput 形状：append = 原始增量文本）。
        // toolcall_start 没给 id/name 时无法绑 blockId，忽略该行。
        const start = state.toolcallStarts.get(idx);
        if (!start || typeof ame.delta !== 'string' || ame.delta === '') return null;
        return out('run.delta.tool_input', {
          round: state.round, blockId: start.id, name: start.name, append: ame.delta,
        });
      }
      case 'toolcall_end':
        return handleToolcallEnd(ame);
      default:
        return null; // 未知子类型：不阻断流，M1 收到再补映射
    }
  }

  function handleToolcallEnd(ame) {
    // assistant 消息流里的完整 tool call（rpc.md message_update 表：toolcall_end 含
    // 完整 toolCall）。与 tool_execution_start 同 id 只发一次 run.delta.tool_use。
    if (typeof ame.contentIndex === 'number') state.toolcallStarts.delete(ame.contentIndex); // 闭合 tool_input 配对
    const tc = ame.toolCall && typeof ame.toolCall === 'object' ? ame.toolCall : {};
    const id = tc.id ?? tc.toolCallId ?? null;
    const name = tc.name ?? null;
    if (!id || !name || state.emittedToolUses.has(id)) return null;
    state.emittedToolUses.add(id);
    state.counters.toolCalls += 1;
    state.toolNames.set(id, name);
    // [doc-diff] 实测 toolCall 形状 {type:'toolCall',id,name,arguments}（events.jsonl:17）；
    // M0 误读 tc.input，非空参数会被静默丢成 {}——以 arguments 为准（input 兜底）。
    const args = tc.arguments ?? tc.input;
    return out('run.delta.tool_use', {
      round: state.round, blockId: id, name,
      input: args && typeof args === 'object' ? args : {},
    });
  }

  function handleToolExecutionStart(line) {
    // §4.5：tool_execution_start{args} → run.delta.tool_use
    const id = line.toolCallId ?? null;
    const name = line.toolName ?? null;
    if (!id || !name || state.emittedToolUses.has(id)) return null;
    state.emittedToolUses.add(id);
    state.counters.toolCalls += 1;
    state.toolNames.set(id, name);
    return out('run.delta.tool_use', {
      round: state.round, blockId: id, name,
      input: line.args && typeof line.args === 'object' ? line.args : {},
    });
  }

  function handleToolExecutionUpdate(line) {
    // M1：→ run.tool_progress（Events.toolProgress 形状 { blockId, toolName }）。
    // partialResult 是"累计快照"（rpc.md:1105-1112），前端无逐块覆盖需求
    //（run.delta.tool_result 一次给终值），不透传；elapsedSeconds 无来源（pi 不报），
    // 省略字段（前端可忽略未知字段）。
    const id = line.toolCallId ?? null;
    if (!id) return null;
    const name = line.toolName ?? state.toolNames.get(id) ?? null;
    return out('run.tool_progress', { blockId: id, toolName: name ?? 'tool' });
  }

  function handleToolExecutionEnd(line) {
    // §4.5：tool_execution_end{result,isError} → run.delta.tool_result
    const id = line.toolCallId ?? null;
    if (!id) return null;
    const name = line.toolName ?? state.toolNames.get(id) ?? null;
    const ok = !line.isError;
    if (!ok) state.counters.toolFailures += 1;
    const payload = { round: state.round, blockId: id, name: name ?? 'tool', ok };
    const text = toolResultText(line.result);
    if (ok) {
      if (text) payload.output = text;
      // output 缺省省略 —— Events.deltaToolResult 同样只在 output!==undefined 时挂字段
    } else {
      payload.error = text || 'tool execution failed';
    }
    return out('run.delta.tool_result', payload);
  }

  function handleQueueUpdate(line) {
    // M1：排队 steering/followUp → run.queue.depth（排队提示，Events.queueDepth 形状）。
    // [doc-diff] rpc.md:1126-1132 / agent-session.ts:717-721：载荷没有 length/count/depth
    // 标量，是 steering/followUp 两个字符串数组；depth = 两数组长度和。两者都缺则忽略该行。
    const s = Array.isArray(line.steering) ? line.steering.length : null;
    const f = Array.isArray(line.followUp) ? line.followUp.length : null;
    if (s === null && f === null) return null;
    return out('run.queue.depth', { sessionId: run.sessionId ?? null, depth: (s ?? 0) + (f ?? 0) });
  }

  function handleMessageEnd(line) {
    const msg = line.message;
    if (!msg || msg.role !== 'assistant') return null; // user 消息结束不产生事件
    // 权威 usage（含 reasoning）+ stopReason；message 内部字段，rpc.md 未显式列出
    state.finalUsage = pickUsage(msg.usage);
    if (typeof msg.stopReason === 'string') state.stopReason = msg.stopReason;
    if (typeof msg.model === 'string') state.model = msg.model;
    // stopReason='error'（rpc.md:1534 允许值）→ run.error；其余（stop/length/toolUse/
    // aborted）由后续 agent_settled / run.cancelled 收场。
    if (msg.stopReason === 'error') {
      return out('run.error', { message: 'assistant message ended with stopReason=error', code: 'STOP_REASON_ERROR' });
    }
    return null;
  }

  function handleCompactionStart() {
    // §4.5 run.status ← agent state；pi 无 isCompacting 事件，compaction_start/end
    // 是最接近的代理（前端 run.status 'compacting' 会幂等插压缩卡）。
    return out('run.status', { status: 'compacting' });
  }

  function handleCompactionEnd(line) {
    // §4.5：compaction 事件 → run.compact_boundary。M1 定案：失败（result:null，
    // rpc.md:1170-1172 用 errorMessage 说明，如 quota 超限）折 errorMessage 进
    // compactMetadata，**不**单独发 run.error —— compaction 失败可恢复（willRetry）
    // 或会话照常继续，run 不该因此判死；前端用 compact_boundary 卡片展示。
    state.counters.compactBoundaries += 1;
    const meta = {
      reason: line.reason ?? null,
      summary: line.result?.summary ?? null,
      tokensBefore: line.result?.tokensBefore ?? null,
      estimatedTokensAfter: line.result?.estimatedTokensAfter ?? null,
      aborted: line.aborted ?? false,
      willRetry: line.willRetry ?? false,
      ...(typeof line.errorMessage === 'string' ? { errorMessage: line.errorMessage } : {}),
    };
    out('run.status', { status: null }); // 压缩结束复位（前端 no-op，保状态机闭合）
    return out('run.compact_boundary', { compactMetadata: meta });
  }

  function handleAutoRetryStart() {
    state.counters.apiRetries += 1;
    return null; // 重试中不算失败；结束事件才判成败
  }

  function handleAutoRetryEnd(line) {
    if (line.success !== false) return null;
    const msg = line.finalError || `auto_retry exhausted after ${line.attempt ?? '?'} attempts`;
    // rate-limit 判别（§4.5 草案，启发式）——M1 TODO：对真实 provider 错误复核
    if (isRateLimitMessage(msg)) {
      return out('run.rate_limit', { info: { message: msg } });
    }
    return out('run.error', { message: msg, code: 'AUTO_RETRY_EXHAUSTED' });
  }

  function handleExtensionError(line) {
    // §4.5：extension_error → run.error。payload { extensionPath, event, error }
    return out('run.error', {
      message: line.error || `extension_error: ${line.extensionPath ?? 'unknown'}`,
      code: 'EXTENSION_ERROR',
      ...(line.extensionPath ? { extensionPath: line.extensionPath } : {}),
    });
  }

  function handleAgentSettled() {
    // §4.5：agent_settled → run.done（附 stats：usage 取最后一次 message_end /
    // message_update）。收场三信号互斥：已取消（run.cancelled）就不再发 run.done。
    if (state.runDoneEmitted || state.cancelled) return null;
    state.runDoneEmitted = true;
    const finalText = [...state.textByIndex.values()].join('');
    const snapshot = {
      counters: { ...state.counters },
      model: state.model ?? run.model ?? null,
      stopReason: state.stopReason ?? null,
      usage: state.finalUsage ?? state.lastUpdateUsage ?? null,
    };
    return out('run.done', { finalText, snapshot });
  }

  /**
   * 处理一行 pi RPC stdout JSON（AgentSessionEvent）。
   * @returns {{ event: object, payload: object } | null} 映射出的**主**事件；null = 忽略。
   *   注意：个别行除主事件外还会经 emit 发辅助事件（compaction_end 在
   *   compact_boundary 前先发 run.status{status:null}）。要观察全部输出请用 emit 回调，
   *   返回值只保证"这行的主事件"。
   */
  function handleLine(line) {
    if (!line || typeof line !== 'object' || typeof line.type !== 'string') return null;
    switch (line.type) {
      case 'response': return handleResponse(line);
      case 'agent_start': return handleAgentStart(line);
      case 'turn_start': return handleTurnStart();
      case 'message_start': return handleMessageStart(line);
      case 'message_update': return handleMessageUpdate(line);
      case 'message_end': return handleMessageEnd(line);
      case 'turn_end': return null; // 生命周期边界；toolResults 与 delta 重复，前端不需要
      case 'agent_end': return null; // 单次底层 run 结束（可能跟 retry/compaction）；
                                     // run.done 的权威锚点是 agent_settled（rpc.md:929）
      case 'agent_settled': return handleAgentSettled();
      case 'tool_execution_start': return handleToolExecutionStart(line);
      case 'tool_execution_update': return handleToolExecutionUpdate(line);
      case 'tool_execution_end': return handleToolExecutionEnd(line);
      case 'compaction_start': return handleCompactionStart();
      case 'compaction_end': return handleCompactionEnd(line);
      case 'auto_retry_start': return handleAutoRetryStart();
      case 'auto_retry_end': return handleAutoRetryEnd(line);
      case 'extension_error': return handleExtensionError(line);
      // 直接 RPC bash 命令的输出流；Nodesign 工具链走 tool_execution_*，M0 不直跑
      case 'bash_execution_update': return null;
      // 排队 steering/followUp → run.queue.depth（排队提示）；载荷是俩数组，depth=长度和，见 handleQueueUpdate
      case 'queue_update': return handleQueueUpdate(line);
      // watch_state 订阅协议内部事件，无前端消费方
      case 'state_changed': return null;
      // 会话级事件（preset 激活 / reroll 分支切换 / edit_message），不是 run 流事件。
      // preset_activated 由 session-loop onEvent 直接发 eventBus（会话级，bridge 是 per-turn 会漏）。
      case 'preset_activated':
      case 'leaf_changed':
      case 'entry_edited': return null;
      default: return null; // 未知类型不阻断流
    }
  }

  return { handleLine, state };
}
