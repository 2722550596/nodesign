/**
 * server/engine/pi/event-bridge.js — pi RPC 事件流 → Nodesign EventBus 事件桥（M0 原型）
 *
 * 目标：把 pi rpc-mode 的 stdout JSON 行（AgentSessionEvent，事件表见
 * ~/projects/pi-rp/packages/coding-agent/docs/rpc.md:926-954）翻译成 Nodesign 前端
 * 消费的 run.* 事件（契约见 server/engine/agent/events.js 的 Events 构造器与
 * engine/README.md 事件表）。M1 会硬化成 rpc-client 的常驻解析层；M0 只求基于
 * 真实事件流可重放、可读（Wave B2 验收：/tmp/nd-m0-probe/events.jsonl 重放还原）。
 *
 * 用法：
 *   import { createEventBridge } from './event-bridge.js';
 *   const bridge = createEventBridge({
 *     emit: (evt) => bus.publish(evt),
 *     run: { runId, uid, sessionId, model, pid },   // M1 run 上下文（见下方约定）
 *   });
 *   for (const line of jsonLines) bridge.handleLine(JSON.parse(line));
 *
 * 设计约定：
 *   - 每行独立判定；跨行状态只存"必须累积"的：text/thinking 块（按 contentIndex
 *     累积，run.done 的 finalText 用）、usage 快照、toolCallId 配对与去重、round。
 *   - 事件富化对齐 AgentContext.emit（server/engine/agent/context.js:132-141）：
 *     { runId, sessionId, ts, ...event }，调用方显式字段不被覆盖。
 *   - 输出载荷字段逐项对照 Events 构造器：
 *       run.delta.text       { round, text }           ← text 是增量块（前端 appendTextDelta 累加）
 *       run.delta.thinking   { round, text }           ← 同上，role='thinking'
 *       run.delta.tool_use   { round, blockId, name, input }
 *       run.delta.tool_result{ round, blockId, name, ok, output?, error? }
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
 */
export function createEventBridge({ emit, run = {} } = {}) {
  const state = {
    round: 0,                  // 1-based turn 序数，turn_start 自增
    runStarted: false,         // 首个 agent_start 发过 run.start 后才算
    runDoneEmitted: false,
    cancelled: false,          // abort 响应 → run.cancelled；settled 时不再发 run.done
    textByIndex: new Map(),    // contentIndex → 累积文本（run.done finalText 用）
    thinkingByIndex: new Map(),// contentIndex → 累积 thinking（重放完整性校验用）
    toolNames: new Map(),      // toolCallId → toolName（tool_result 兜底）
    emittedToolUses: new Set(),// toolCallId 去重：toolcall_end 与 tool_execution_start 双路径只发一次
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
    // M1 TODO：核实空闲时 abort 的响应语义（pi 可能幂等 success:true，届时需查
    // pi 是否有"当前 turn 活跃"的 gate，否则空闲 abort 会误发 cancelled）。
    if (line.command === 'abort' && line.success === true) {
      state.cancelled = true;
      return out('run.cancelled', { reason: 'abort_requested' });
    }
    // 其余 response（prompt 成功受理 / get_last_assistant_text / get_state / …）不产生 run 事件
    return null;
  }

  function handleAgentStart() {
    // run.start：§4.5「首个 agent_start」。auto-retry 会再发 agent_start，
    // 同一 run 只发一次；M1 每 turn 新建 bridge，天然隔离。
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
    // usage 每条 message_update 都带（实测全程为初始快照值，流式期不更新）——
    // 无条件吸收，最后一条即流式终值；权威值仍以 message_end.message.usage 为准
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
      case 'toolcall_start':
      case 'toolcall_delta':
        return null; // 工具参数流式增量；M1 可映射 run.delta.tool_input（同 blockId 补丁）
      case 'toolcall_end':
        return handleToolcallEnd(ame);
      default:
        return null; // 未知子类型：不阻断流，M1 收到再补映射
    }
  }

  function handleToolcallEnd(ame) {
    // assistant 消息流里的完整 tool call（rpc.md message_update 表：toolcall_end 含
    // 完整 toolCall）。与 tool_execution_start 同 id 只发一次 run.delta.tool_use。
    const tc = ame.toolCall && typeof ame.toolCall === 'object' ? ame.toolCall : {};
    const id = tc.id ?? tc.toolCallId ?? null;
    const name = tc.name ?? null;
    if (!id || !name || state.emittedToolUses.has(id)) return null;
    state.emittedToolUses.add(id);
    state.counters.toolCalls += 1;
    state.toolNames.set(id, name);
    return out('run.delta.tool_use', {
      round: state.round, blockId: id, name,
      input: tc.input && typeof tc.input === 'object' ? tc.input : {},
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

  function handleToolExecutionUpdate() {
    // 执行中 partialResult 是"累计快照"（rpc.md:1105-1112），前端没有逐块覆盖
    // 的需求（run.delta.tool_result 一次给终值）；M1 若要进度可视再映射。
    return null;
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
    // §4.5：compaction 事件 → run.compact_boundary。失败（result:null）时 rpc.md
    // 用 errorMessage 说明（如 quota 超限），并入 compactMetadata 供前端展示；
    // M1 决定是否对"失败"单独发 run.error。
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
      case 'tool_execution_update': return handleToolExecutionUpdate();
      case 'tool_execution_end': return handleToolExecutionEnd(line);
      case 'compaction_start': return handleCompactionStart();
      case 'compaction_end': return handleCompactionEnd(line);
      case 'auto_retry_start': return handleAutoRetryStart();
      case 'auto_retry_end': return handleAutoRetryEnd(line);
      case 'extension_error': return handleExtensionError(line);
      // 直接 RPC bash 命令的输出流；Nodesign 工具链走 tool_execution_*，M0 不直跑
      case 'bash_execution_update': return null;
      // 排队 steering/followUp；Nodesign 有 run.queue.depth 但语义不同，M1 再定
      case 'queue_update': return null;
      // watch_state 订阅协议内部事件，无前端消费方
      case 'state_changed': return null;
      // 会话树内部（preset 激活 / reroll 分支切换 / edit_message），不是 run 流事件
      case 'preset_activated':
      case 'leaf_changed':
      case 'entry_edited': return null;
      default: return null; // 未知类型不阻断流
    }
  }

  return { handleLine, state };
}
