/**
 * server/engine/runs/live-turn.js — 进行中 turn 的物化快照（内存态）
 *
 * 解决的问题：EventBus 是 fire-and-forget + ring buffer（2000 条），token 级
 * streaming 一个 turn 就上万条事件 —— 刷新 / 断线重连后"进行中的 turn"在任何
 * 可恢复的地方都不存在（jsonl 只在 turn 边界 flush）。老架构靠 ?since= 游标 +
 * ring 回放，重连几秒就 gap，gap 补 hydrate 又把已渲染内容反向覆盖。
 *
 * 新范式（快照 + 尾随，2026-07-27 重构）：
 *   - 本模块订阅每个 project bus，把进行中 turn 的事件**同步折叠**成前端
 *     display-message 形态的物化状态（跟 ProjectWorkspace handleEvent 的累加
 *     逻辑同构）
 *   - WS 连接时：jsonl hydrate（已完成 turn）→ ws.live_turn 快照（进行中 turn）
 *     → 从快照 seq 起订阅实时流。ring buffer 大小从此只影响极小的同步窗口，
 *     不再影响正确性
 *   - turn 结束（done / error / cancelled）或 session 结束即清，内存占用 =
 *     活跃 turn 数 × 单 turn 消息体量（tool output 截断到 16k）
 *
 * 折叠规则跟前端 handleEvent 对齐（改前端渲染逻辑时两边同步改）：
 *   run.delta.text / thinking       → 同 role 连续累加一条消息
 *   run.tool_use.started            → push tool 消息 status='running'
 *   run.delta.tool_use              → 补 toolInput
 *   run.delta.tool_result           → 补 status / output / error（images 不进快照，太大）
 *   run.todo.updated                → todos 覆盖
 *   run.context_usage               → contextUsage 覆盖
 *   run.plan_for_approval           → planForApproval（等待用户审批的 plan 卡）
 *   run.done / error / cancelled    → 清（runId 匹配才清，防 stale 事件清掉新 turn）
 *   run.query.end                   → 清
 */

const MAX_TOOL_TEXT = 16_000;

/** @type {Map<string, object>} sessionId → live turn state */
const liveTurns = new Map();

function truncate(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= MAX_TOOL_TEXT) return s;
  return s.slice(0, MAX_TOOL_TEXT) + `\n…[截断，共 ${s.length} 字符]`;
}

/**
 * 给 project bus 挂折叠订阅（幂等 —— broker.getProjectBus 每次创建 bus 时调）。
 */
export function attachLiveTurnTracker(bus) {
  if (bus.__liveTurnTracked) return;
  bus.__liveTurnTracked = true;
  bus.subscribe('*', fold);
}

/**
 * 取 session 当前进行中 turn 的快照；无进行中 turn 返 null。
 * 返回值直接可作 ws.live_turn 帧 payload（messages 是前端 display 形态）。
 */
export function getLiveTurnSnapshot(sessionId) {
  const st = liveTurns.get(sessionId);
  if (!st) return null;
  return {
    runId: st.runId,
    seq: st.seq,
    startedAt: st.startedAt,
    messages: st.messages,
    todos: st.todos,
    contextUsage: st.contextUsage,
    planForApproval: st.planForApproval,
  };
}

export function clearLiveTurn(sessionId) {
  liveTurns.delete(sessionId);
}

function fold(evt) {
  const sid = evt.sessionId;
  if (!sid) return;

  if (evt.type === 'run.start') {
    liveTurns.set(sid, {
      runId: evt.runId || null,
      startedAt: evt.ts || new Date().toISOString(),
      seq: evt.seq || 0,
      messages: [],
      todos: [],
      contextUsage: null,
      planForApproval: null,
      _msgCounter: 0,
    });
    return;
  }

  const st = liveTurns.get(sid);
  if (!st) return;

  // stale 事件（老 turn 的尾巴）不折叠也不清新 turn 的状态
  const runMatches = !evt.runId || !st.runId || evt.runId === st.runId;

  switch (evt.type) {
    case 'run.delta.text':
      if (runMatches) appendText(st, 'assistant', evt.text, evt.parentToolUseId);
      break;
    case 'run.delta.thinking':
      if (runMatches) appendText(st, 'thinking', evt.text, evt.parentToolUseId);
      break;
    case 'run.tool_use.started':
      if (runMatches && evt.blockId && !st.messages.some(m => m.id === evt.blockId)) {
        st.messages.push({
          id: evt.blockId, role: 'tool', toolName: evt.name,
          toolInput: undefined, status: 'running', runId: st.runId,
          ...(evt.parentToolUseId ? { parentToolUseId: evt.parentToolUseId } : {}),
        });
      }
      break;
    case 'run.delta.tool_use': {
      if (!runMatches) break;
      const existing = st.messages.find(m => m.role === 'tool' && m.id === evt.blockId);
      if (existing) existing.toolInput = evt.input;
      else if (evt.blockId) {
        st.messages.push({
          id: evt.blockId, role: 'tool', toolName: evt.name,
          toolInput: evt.input, status: 'running', runId: st.runId,
          ...(evt.parentToolUseId ? { parentToolUseId: evt.parentToolUseId } : {}),
        });
      }
      break;
    }
    case 'run.delta.tool_result': {
      if (!runMatches) break;
      const tool = st.messages.find(m => m.role === 'tool' && m.id === evt.blockId);
      if (tool) {
        tool.status = evt.ok ? 'success' : 'error';
        if (evt.output !== undefined) tool.toolOutput = truncate(typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output));
        if (evt.error) tool.toolError = truncate(typeof evt.error === 'string' ? evt.error : JSON.stringify(evt.error));
        // images 不进快照：base64 体积大，turn 结束后 jsonl hydrate 会带回来
      }
      break;
    }
    case 'run.todo.updated':
      if (runMatches && Array.isArray(evt.todos)) st.todos = evt.todos;
      break;
    case 'run.context_usage':
      if (runMatches) st.contextUsage = evt;
      break;
    case 'run.plan_for_approval':
      if (runMatches) st.planForApproval = { toolUseId: evt.toolUseId, plan: evt.plan };
      break;
    case 'run.done':
    case 'run.error':
    case 'run.cancelled':
      if (runMatches) liveTurns.delete(sid);
      return;
    case 'run.query.end':
      liveTurns.delete(sid);
      return;
    default:
      break;
  }

  // 所有本 session 事件都推进快照游标（包括未折叠类型）——
  // 重连订阅从 seq 起，不折叠的事件类型（queue depth 等）丢了也无碍（幂等 UI 状态）
  if (typeof evt.seq === 'number' && evt.seq > st.seq) st.seq = evt.seq;
}

function appendText(st, role, text, parentToolUseId = null) {
  if (!text) return;
  const last = st.messages[st.messages.length - 1];
  // 子代理时间轴：不同 parent 的流不互吸（跟前端 lib/chat-stream.js 同构）
  if (last && last.role === role && (last.parentToolUseId || null) === (parentToolUseId || null)) {
    last.content = (last.content || '') + text;
    return;
  }
  st.messages.push({
    id: `${st.runId || 'live'}:m${st._msgCounter++}`,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    role,
    content: text,
    runId: st.runId,
  });
}
