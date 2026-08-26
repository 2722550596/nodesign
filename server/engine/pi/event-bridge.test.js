/**
 * event-bridge M1 硬化回归（附录 C 逐条）：
 *   - text/thinking 累积 → agent_settled run.done finalText 逐字节一致；usage 权威取 message_end
 *   - tool_use 双路径去重、tool_result 成败分支
 *   - compaction 成功/失败（失败折 errorMessage 进 meta，不发 run.error）
 *   - auto_retry 耗尽：429/rate_limit → run.rate_limit；5xx → run.error
 *   - extension_error / prompt 受理失败 / stopReason=error → run.error
 *   - abort 空闲门控（isTurnActive 缺省 vs ()=>false）
 *   - toolcall_start+delta → run.delta.tool_input；tool_execution_update → run.tool_progress
 *   - queue_update（steering/followUp 数组）→ run.queue.depth
 * 内联事件序列，字段名对照 /tmp/nd-m0-probe/events.jsonl 真实形状。
 */
import { describe, it, expect } from 'vitest';
import { createEventBridge } from './event-bridge.js';

const RUN = { runId: 'run_t1', sessionId: 'sess_t1', model: 'test/model' };

/** 建 bridge：emit 数组捕获全部输出（含 compaction_end 的辅助 run.status）。 */
function mkBridge(opts = {}) {
  const emitted = [];
  const bridge = createEventBridge({ emit: (e) => emitted.push(e), run: RUN, ...opts });
  const feed = (lines) => lines.map((l) => bridge.handleLine(l));
  const ofType = (type) => emitted.filter((e) => e.type === type);
  return { bridge, emitted, feed, ofType };
}

/** message_update 行包装（顶层 usage 每条都带，实测是初始快照值）。 */
const USAGE_SNAPSHOT = { input: 0, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 100 };
const mu = (assistantMessageEvent, usage = USAGE_SNAPSHOT) => ({
  type: 'message_update', usage, assistantMessageEvent,
});

describe('text/thinking 累积 → run.done', () => {
  const USAGE_FINAL = {
    input: 15, output: 43, cacheRead: 7810, cacheWrite: 0, totalTokens: 7868,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, reasoning: 26,
  };

  it('finalText 逐字节一致；usage 取 message_end 权威值（不是流式快照）', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'assistant', content: [], model: 'wire/MiniMax-M3' } },
      mu({ type: 'thinking_start', contentIndex: 0 }),
      mu({ type: 'thinking_delta', contentIndex: 0, delta: '先想一下。' }),
      mu({ type: 'thinking_delta', contentIndex: 0, delta: '再动手。' }),
      mu({ type: 'thinking_end', contentIndex: 0, content: '先想一下。再动手。' }),
      mu({ type: 'text_start', contentIndex: 1 }),
      mu({ type: 'text_delta', contentIndex: 1, delta: '第一句。\n' }),
      mu({ type: 'text_delta', contentIndex: 1, delta: '第二句。' }),
      mu({ type: 'text_end', contentIndex: 1, content: '第一句。\n第二句。' }),
      {
        type: 'message_end',
        message: { role: 'assistant', content: [], usage: USAGE_FINAL, stopReason: 'stop', model: 'wire/MiniMax-M3' },
      },
      { type: 'agent_settled' },
    ]);

    // delta 逐块下发（前端 append 累加）
    expect(ofType('run.delta.thinking').map((e) => e.text)).toEqual(['先想一下。', '再动手。']);
    expect(ofType('run.delta.text').map((e) => e.text)).toEqual(['第一句。\n', '第二句。']);

    const done = ofType('run.done');
    expect(done).toHaveLength(1);
    expect(done[0].finalText).toBe('第一句。\n第二句。'); // 逐字节
    expect(done[0].snapshot.stopReason).toBe('stop');
    // usage = message_end 权威终值（含 reasoning），不是流式初始快照
    expect(done[0].snapshot.usage).toEqual({
      input: 15, output: 43, cacheRead: 7810, cacheWrite: 0, totalTokens: 7868,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, reasoning: 26,
    });
    expect(done[0].snapshot.usage.output).not.toBe(USAGE_SNAPSHOT.output);
  });

  it('run.start 的 model 用 run.model（rpc-client 传入），不被晚到的 wire model 顶掉', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [], model: 'wire/MiniMax-M3' } },
    ]);
    const start = ofType('run.start');
    expect(start).toHaveLength(1);
    expect(start[0].model).toBe('test/model');
    // 富化对齐 AgentContext.emit
    expect(start[0].runId).toBe('run_t1');
    expect(start[0].sessionId).toBe('sess_t1');
    expect(typeof start[0].ts).toBe('string');
  });
});

describe('tool_use 双路径去重 + tool_result 分支', () => {
  it('toolcall_end 与 tool_execution_start 同 id → 只发一次 run.delta.tool_use', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'agent_start' },
      { type: 'turn_start' },
      mu({
        type: 'toolcall_end', contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call_1', name: 'read_board', arguments: { path: 'a.md' } },
      }),
      { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read_board', args: { path: 'a.md' } },
    ]);
    const uses = ofType('run.delta.tool_use');
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ round: 1, blockId: 'call_1', name: 'read_board', input: { path: 'a.md' } });
  });

  it('tool_execution_end ok → tool_result 带 output、无 error 字段', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'turn_start' },
      {
        type: 'tool_execution_end', toolCallId: 'call_2', toolName: 'bash', isError: false,
        result: { content: [{ type: 'text', text: '输出甲' }, { type: 'text', text: '输出乙' }], details: {} },
      },
    ]);
    const [r] = ofType('run.delta.tool_result');
    expect(r).toMatchObject({ blockId: 'call_2', name: 'bash', ok: true, output: '输出甲输出乙' });
    expect(r).not.toHaveProperty('error');
  });

  it('tool_execution_end isError → tool_result 带 error、无 output 字段', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'turn_start' },
      {
        type: 'tool_execution_end', toolCallId: 'call_3', toolName: 'bash', isError: true,
        result: { content: [{ type: 'text', text: 'boom' }] },
      },
      // 空 result 的失败 → 兜底文案
      { type: 'tool_execution_end', toolCallId: 'call_4', toolName: 'bash', isError: true, result: null },
    ]);
    const [err, fallback] = ofType('run.delta.tool_result');
    expect(err).toMatchObject({ blockId: 'call_3', ok: false, error: 'boom' });
    expect(err).not.toHaveProperty('output');
    expect(fallback).toMatchObject({ blockId: 'call_4', ok: false, error: 'tool execution failed' });
  });
});

describe('compaction', () => {
  it('成功：run.status compacting → 复位 → compact_boundary（辅助事件用 emit 数组断言）', () => {
    const { feed, emitted, ofType } = mkBridge();
    feed([
      { type: 'compaction_start' },
      {
        type: 'compaction_end', reason: 'auto', aborted: false, willRetry: false,
        result: { summary: '压缩摘要', tokensBefore: 100000, estimatedTokensAfter: 40000 },
      },
    ]);
    expect(ofType('run.status').map((e) => e.status)).toEqual(['compacting', null]);
    const [b] = ofType('run.compact_boundary');
    expect(b.compactMetadata).toEqual({
      reason: 'auto', summary: '压缩摘要', tokensBefore: 100000, estimatedTokensAfter: 40000,
      aborted: false, willRetry: false,
    });
    expect(emitted.some((e) => e.type === 'run.error')).toBe(false);
  });

  it('失败（result:null+errorMessage）：折进 compactMetadata，不发 run.error', () => {
    const { feed, emitted, ofType } = mkBridge();
    feed([
      { type: 'compaction_start' },
      {
        type: 'compaction_end', reason: 'auto', result: null, aborted: false,
        willRetry: true, errorMessage: 'quota exceeded',
      },
    ]);
    const [b] = ofType('run.compact_boundary');
    expect(b.compactMetadata).toMatchObject({
      summary: null, aborted: false, willRetry: true, errorMessage: 'quota exceeded',
    });
    expect(emitted.some((e) => e.type === 'run.error')).toBe(false);
  });
});

describe('auto_retry_end success:false 分流', () => {
  it('429/rate_limit → run.rate_limit', () => {
    const { feed, ofType } = mkBridge();
    feed([{ type: 'auto_retry_end', success: false, attempt: 3, finalError: '429 rate_limit: too many requests' }]);
    const [rl] = ofType('run.rate_limit');
    expect(rl.info.message).toBe('429 rate_limit: too many requests');
    expect(ofType('run.error')).toHaveLength(0);
  });

  it('5xx（529 overloaded）→ run.error，不算限流', () => {
    const { feed, ofType } = mkBridge();
    feed([{ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded_error: Overloaded' }]);
    const [err] = ofType('run.error');
    expect(err).toMatchObject({ message: '529 overloaded_error: Overloaded', code: 'AUTO_RETRY_EXHAUSTED' });
    expect(ofType('run.rate_limit')).toHaveLength(0);
  });

  it('success:true → 忽略', () => {
    const { feed, emitted } = mkBridge();
    expect(feed([{ type: 'auto_retry_end', success: true, attempt: 2 }])).toEqual([null]);
    expect(emitted).toHaveLength(0);
  });
});

describe('run.error 三来源', () => {
  it('extension_error → run.error（EXTENSION_ERROR）', () => {
    const { feed, ofType } = mkBridge();
    feed([{ type: 'extension_error', extensionPath: '/x/ext.js', event: 'message_start', error: 'ext boom' }]);
    expect(ofType('run.error')[0]).toMatchObject({ message: 'ext boom', code: 'EXTENSION_ERROR', extensionPath: '/x/ext.js' });
  });

  it('prompt 受理失败 → run.error（PROMPT_REJECTED）', () => {
    const { feed, ofType } = mkBridge();
    feed([{ id: 'req-1', type: 'response', command: 'prompt', success: false, error: 'session busy' }]);
    expect(ofType('run.error')[0]).toMatchObject({ message: 'session busy', code: 'PROMPT_REJECTED' });
  });

  it('stopReason=error → run.error（STOP_REASON_ERROR）', () => {
    const { feed, ofType } = mkBridge();
    feed([{ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } }]);
    expect(ofType('run.error')[0]).toMatchObject({ code: 'STOP_REASON_ERROR' });
  });
});

describe('abort 空闲门控（M1）', () => {
  const ABORT_OK = { id: 'req-9', type: 'response', command: 'abort', success: true };

  it('isTurnActive 缺省 → 保持 M0 行为：run.cancelled，且 settled 不再发 run.done', () => {
    const { feed, ofType } = mkBridge();
    feed([ABORT_OK, { type: 'agent_settled' }]);
    expect(ofType('run.cancelled')[0]).toMatchObject({ reason: 'abort_requested' });
    expect(ofType('run.done')).toHaveLength(0); // 收场三信号互斥
  });

  it('isTurnActive()=>false → 空闲 abort 被忽略：不发 run.cancelled，settled 照常 run.done', () => {
    const { feed, ofType } = mkBridge({ isTurnActive: () => false });
    expect(feed([ABORT_OK])).toEqual([null]);
    expect(ofType('run.cancelled')).toHaveLength(0);
    feed([{ type: 'agent_settled' }]);
    expect(ofType('run.done')).toHaveLength(1);
  });

  it('isTurnActive()=>true → 照常 run.cancelled', () => {
    const { feed, ofType } = mkBridge({ isTurnActive: () => true });
    feed([ABORT_OK]);
    expect(ofType('run.cancelled')).toHaveLength(1);
  });
});

describe('toolcall_start + toolcall_delta → run.delta.tool_input', () => {
  it('start 带 id/toolName 时，delta 逐块发 append 增量', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'turn_start' },
      mu({ type: 'toolcall_start', contentIndex: 1, id: 'call_9', toolName: 'write_file' }),
      mu({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":' }),
      mu({ type: 'toolcall_delta', contentIndex: 1, delta: '"a.txt"}' }),
    ]);
    expect(ofType('run.delta.tool_input').map((e) => ({
      round: e.round, blockId: e.blockId, name: e.name, append: e.append,
    }))).toEqual([
      { round: 1, blockId: 'call_9', name: 'write_file', append: '{"path":' },
      { round: 1, blockId: 'call_9', name: 'write_file', append: '"a.txt"}' },
    ]);
  });

  it('start 无 id/name（实测 RPC 流形状）→ delta 忽略', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'turn_start' },
      mu({ type: 'toolcall_start', contentIndex: 1 }),
      mu({ type: 'toolcall_delta', contentIndex: 1, delta: '{}' }),
    ]);
    expect(ofType('run.delta.tool_input')).toHaveLength(0);
  });

  it('toolcall_end 闭合配对后，同 index 的 delta 不再发', () => {
    const { feed, ofType } = mkBridge();
    feed([
      { type: 'turn_start' },
      mu({ type: 'toolcall_start', contentIndex: 1, id: 'call_a', toolName: 't' }),
      mu({ type: 'toolcall_delta', contentIndex: 1, delta: 'x' }),
      mu({ type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call_a', name: 't', arguments: {} } }),
      mu({ type: 'toolcall_delta', contentIndex: 1, delta: 'y' }),
    ]);
    expect(ofType('run.delta.tool_input').map((e) => e.append)).toEqual(['x']);
    expect(ofType('run.delta.tool_use')).toHaveLength(1);
  });
});

describe('tool_execution_update → run.tool_progress', () => {
  it('发 {blockId, toolName}，elapsedSeconds 无来源则省略', () => {
    const { feed, ofType } = mkBridge();
    feed([{
      type: 'tool_execution_update', toolCallId: 'call_5', toolName: 'bash', args: {},
      partialResult: { content: [{ type: 'text', text: 'partial output so far...' }] },
    }]);
    const [p] = ofType('run.tool_progress');
    expect(p).toMatchObject({ blockId: 'call_5', toolName: 'bash' });
    expect(p).not.toHaveProperty('elapsedSeconds');
    // partialResult 是累计快照，不透传
    expect(p).not.toHaveProperty('partialResult');
  });

  it('无 toolCallId → 忽略', () => {
    const { feed } = mkBridge();
    expect(feed([{ type: 'tool_execution_update', toolName: 'bash' }])).toEqual([null]);
  });
});

describe('queue_update → run.queue.depth', () => {
  it('depth = steering + followUp 数组长度和；sessionId 取 run.sessionId', () => {
    const { feed, ofType } = mkBridge();
    feed([{ type: 'queue_update', steering: ['先处理错误', '再看日志'], followUp: ['最后总结'] }]);
    expect(ofType('run.queue.depth')[0]).toMatchObject({ sessionId: 'sess_t1', depth: 3 });
  });

  it('空队列 → depth 0', () => {
    const { feed, ofType } = mkBridge();
    feed([{ type: 'queue_update', steering: [], followUp: [] }]);
    expect(ofType('run.queue.depth')[0]).toMatchObject({ depth: 0 });
  });

  it('两个数组都缺 → 忽略该行', () => {
    const { feed } = mkBridge();
    expect(feed([{ type: 'queue_update' }])).toEqual([null]);
  });
});
