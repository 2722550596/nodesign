/**
 * rpc-client.test.js — PiRpcClient 单元回归（假 child，不真起进程）
 *
 * 覆盖（M1 验收点名项）：
 *  - 帧纪律：多帧粘包 / 半帧跨 chunk / 字符串内 U+2028 不误切 / 坏帧丢弃 / CRLF 容忍
 *  - response id 关联（含未匹配 response 丢弃）
 *  - 事件走 onEvent（response 不到 onEvent）
 *  - isTurnActive 状态机（agent_start → true，agent_settled → false）
 *  - kill 链时序（abort → 5s → SIGTERM → 2s → SIGKILL，vi.useFakeTimers）
 *  - 进程退出：pending 全 reject（含 req_init → start reject）、onExit 回调
 *
 * 假 child：EventEmitter + stdout/stderr EventEmitter + stdin 写入记录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PiRpcClient } from './rpc-client.js';

/** 造一个假 child：stdout/stderr 是 EventEmitter（push 字节），stdin 记录写入。 */
function mkFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    destroyed: false,
    write(data, enc, cb) {
      this.writes.push(data);
      if (cb) cb();
      return true;
    },
    destroy() { this.destroyed = true; },
  };
  child.kills = [];
  child.kill = (sig) => { child.kills.push(sig); return true; };
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

/** 建 client（注入假 child）+ 事件/日志捕获。 */
function mkClient(child, opts = {}) {
  const events = [];
  const logs = [];
  const stderrLines = [];
  const exits = [];
  const client = new PiRpcClient({
    child,
    onEvent: (l) => events.push(l),
    onExit: (code, signal, err) => exits.push({ code, signal, err }),
    stderr: (l) => stderrLines.push(l),
    log: (m) => logs.push(m),
    ...opts,
  });
  return { client, events, logs, stderrLines, exits };
}

/** 往假 stdout 推字节（Buffer，模拟真实 chunk 边界）。 */
const push = (child, ...chunks) => {
  for (const c of chunks) child.stdout.emit('data', Buffer.from(c, 'utf8'));
};

/** 推一帧 JSON（自动补 '\n'）。 */
const pushFrame = (child, obj) => push(child, JSON.stringify(obj) + '\n');

/** 从 stdin 写入里解析出命令对象列表。 */
const sentCmds = (child) =>
  child.stdin.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('帧纪律', () => {
  it('多帧粘包：一个 chunk 里多行全部解析', async () => {
    const child = mkFakeChild();
    const { client, events } = mkClient(child);
    const startP = client.start();
    push(child,
      JSON.stringify({ type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} }) + '\n'
      + JSON.stringify({ type: 'agent_start' }) + '\n'
      + JSON.stringify({ type: 'turn_start' }) + '\n');
    await startP;
    expect(events.map((e) => e.type)).toEqual(['agent_start', 'turn_start']);
  });

  it('半帧跨 chunk：字节边界切开多字节字符也不坏', async () => {
    const child = mkFakeChild();
    const { client, events } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    // '中' 是 3 字节 UTF-8，从中间切开
    const frame = JSON.stringify({ type: 'message_update', text: '中文内容' });
    const buf = Buffer.from(frame + '\n', 'utf8');
    push(child, buf.subarray(0, 5), buf.subarray(5, 12), buf.subarray(12));
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('中文内容');
  });

  it('字符串内 U+2028/U+2029 不误切（JSON 字符串里合法）', async () => {
    const child = mkFakeChild();
    const { client, events, logs } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    // 原始 U+2028/U+2029 字节直接出现在 JSON 字符串值里（合法 JSON）
    const tricky = { type: 'message_update', text: 'a\u2028b\u2029c' };
    push(child, JSON.stringify(tricky) + '\n');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('a\u2028b\u2029c');
    expect(logs).toHaveLength(0); // 没有坏帧
  });

  it('坏帧丢弃不炸，好帧照常处理', async () => {
    const child = mkFakeChild();
    const { client, events, logs } = mkClient(child);
    const startP = client.start();
    push(child, 'not-json-at-all\n');
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    push(child, '{"type": "agent_start"  ← 截断的坏帧\n');
    pushFrame(child, { type: 'agent_settled' });
    expect(events.map((e) => e.type)).toEqual(['agent_settled']);
    expect(logs).toHaveLength(2); // 两个坏帧各 log 一次
    expect(logs[0]).toContain('坏帧丢弃');
  });

  it('CRLF 容忍 + 空帧静默跳过', async () => {
    const child = mkFakeChild();
    const { client, events, logs } = mkClient(child);
    const startP = client.start();
    push(child, '\r\n'); // 空帧
    push(child, JSON.stringify({ type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} }) + '\r\n');
    await startP;
    pushFrame(child, { type: 'agent_start' });
    expect(events.map((e) => e.type)).toEqual(['agent_start']);
    expect(logs).toHaveLength(0);
  });
});

describe('response id 关联', () => {
  it('按 id resolve 对应 pending；success:false 不抛（调用方判）', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: { sessionId: 's1' } });
    await startP;

    const p1 = client.prompt('hi', { id: 'run_1' });
    const p2 = client.setPreset('nodesign-base');
    // 乱序回响应
    pushFrame(child, { type: 'response', id: 'req_1', command: 'set_preset', success: false, error: 'not found' });
    pushFrame(child, { type: 'response', id: 'run_1', command: 'prompt', success: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ id: 'run_1', command: 'prompt', success: true });
    expect(r2).toMatchObject({ success: false, error: 'not found' }); // 不抛，原样返回
  });

  it('未匹配的 response log 后丢弃，不进 onEvent', async () => {
    const child = mkFakeChild();
    const { client, events, logs } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    pushFrame(child, { type: 'response', id: 'ghost', command: 'prompt', success: true });
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.includes('未匹配的 response'))).toBe(true);
  });

  it('无 id 自动分配 req_N 且递增', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    const p1 = client.abort();
    const p2 = client.setThinkingLevel('high');
    const cmds = sentCmds(child);
    expect(cmds.map((c) => c.id)).toEqual(['req_init', 'req_1', 'req_2']);
    pushFrame(child, { type: 'response', id: 'req_1', command: 'abort', success: true });
    pushFrame(child, { type: 'response', id: 'req_2', command: 'set_thinking_level', success: true });
    await Promise.all([p1, p2]);
  });

  it('getState 返回 response.data；失败抛错', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    const p = client.getState();
    pushFrame(child, { type: 'response', id: 'req_1', command: 'get_state', success: true, data: { isStreaming: false } });
    expect(await p).toEqual({ isStreaming: false });

    const p2 = client.getState();
    pushFrame(child, { type: 'response', id: 'req_2', command: 'get_state', success: false, error: 'boom' });
    await expect(p2).rejects.toThrow('boom');
  });

  it('prompt 带 images 透传；进程已退出再 send → reject', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    const images = [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }];
    const p = client.prompt('看图', { id: 'run_9', images });
    const cmd = sentCmds(child).at(-1);
    expect(cmd).toMatchObject({ type: 'prompt', id: 'run_9', message: '看图', images });
    pushFrame(child, { type: 'response', id: 'run_9', command: 'prompt', success: true });
    await p;

    child.emit('exit', 0, null);
    await expect(client.prompt('x')).rejects.toThrow('未运行');
  });
});

describe('事件分流与 isTurnActive', () => {
  it('非 response 全走 onEvent；response 不到 onEvent', async () => {
    const child = mkFakeChild();
    const { client, events } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    pushFrame(child, { type: 'message_start', message: { role: 'assistant' } });
    pushFrame(child, { type: 'queue_update', steering: [], followUp: ['a'] });
    expect(events.map((e) => e.type)).toEqual(['message_start', 'queue_update']);
  });

  it('isTurnActive：agent_start → true，agent_settled → false（初始 false）', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    expect(client.isTurnActive()).toBe(false);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    pushFrame(child, { type: 'agent_start' });
    expect(client.isTurnActive()).toBe(true);
    pushFrame(child, { type: 'turn_start' });
    expect(client.isTurnActive()).toBe(true); // 中间事件不改状态
    pushFrame(child, { type: 'agent_settled' });
    expect(client.isTurnActive()).toBe(false);
    pushFrame(child, { type: 'agent_start' }); // 下一轮
    expect(client.isTurnActive()).toBe(true);
  });

  it('onEvent 回调抛错不炸流（log 后继续）', async () => {
    const child = mkFakeChild();
    const logs = [];
    const seen = [];
    const client = new PiRpcClient({
      child,
      log: (m) => logs.push(m),
      onEvent: (l) => { seen.push(l.type); if (l.type === 'agent_start') throw new Error('cb boom'); },
    });
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    pushFrame(child, { type: 'agent_start' });
    pushFrame(child, { type: 'agent_settled' });
    expect(seen).toEqual(['agent_start', 'agent_settled']);
    expect(logs.some((l) => l.includes('onEvent 回调抛错'))).toBe(true);
  });
});

describe('stderr 逐行', () => {
  it('按行回调，尾块无换行在退出时冲出', async () => {
    const child = mkFakeChild();
    const { client, stderrLines, exits } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    child.stderr.emit('data', Buffer.from('line one\nline two\npartial', 'utf8'));
    expect(stderrLines).toEqual(['line one', 'line two']);
    child.emit('exit', 1, null);
    expect(stderrLines).toEqual(['line one', 'line two', 'partial']);
    expect(exits).toEqual([{ code: 1, signal: null, err: undefined }]);
  });
});

describe('进程退出', () => {
  it('exit 先 reject 所有 pending（含 req_init → start reject），再 onExit', async () => {
    const child = mkFakeChild();
    const { client, exits } = mkClient(child);
    const startP = client.start();
    // 未 ready 就退出
    child.emit('exit', null, 'SIGKILL');
    await expect(startP).rejects.toThrow('退出');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ code: null, signal: 'SIGKILL' });
  });

  it('运行中退出：未决命令 reject，后续 send reject', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    const p = client.prompt('hi', { id: 'run_x' });
    child.emit('exit', 2, null);
    await expect(p).rejects.toThrow('退出');
    await expect(client.abort()).rejects.toThrow('未运行');
  });

  it("spawn 'error'（无 exit）也收尾：start reject + onExit 带 err", async () => {
    const child = mkFakeChild();
    const { client, exits } = mkClient(child);
    const startP = client.start();
    child.emit('error', Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' }));
    await expect(startP).rejects.toThrow('ENOENT');
    expect(exits).toHaveLength(1);
    expect(exits[0].err?.message).toContain('ENOENT');
  });
});

describe('kill 链时序', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('优雅路径：5s 内自行退出 → 不发任何信号', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;

    const killP = client.kill();
    // abort 已发出
    expect(sentCmds(child).at(-1)).toMatchObject({ type: 'abort' });
    expect(child.kills).toEqual([]);
    // 3s 后进程自行退出
    await vi.advanceTimersByTimeAsync(3000);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2001); // 越过 5s 边界确认没补信号
    await killP;
    expect(child.kills).toEqual([]);
  });

  it('完整链：abort → 5s SIGTERM → 2s SIGKILL；幂等', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;

    const killP = client.kill();
    const killP2 = client.kill(); // 幂等：同一 Promise
    expect(killP2).toBe(killP);

    await vi.advanceTimersByTimeAsync(4999);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(1999);
    expect(child.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);

    child.emit('exit', null, 'SIGKILL');
    await killP;
  });

  it('SIGTERM 阶段退出 → 不补 SIGKILL', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;

    const killP = client.kill();
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kills).toEqual(['SIGTERM']);
    child.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(2001);
    await killP;
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('已退出进程 kill 立即返回，不发命令不发信号', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    child.emit('exit', 0, null);
    await client.kill();
    expect(child.kills).toEqual([]);
    expect(sentCmds(child)).toHaveLength(1); // 只有 req_init
  });
});

describe('dispose', () => {
  it('清 pending（reject）并摘 listener；之后 send reject', async () => {
    const child = mkFakeChild();
    const { client } = mkClient(child);
    const startP = client.start();
    pushFrame(child, { type: 'response', id: 'req_init', command: 'get_state', success: true, data: {} });
    await startP;
    const p = client.prompt('hi');
    client.dispose();
    await expect(p).rejects.toThrow('disposed');
    await expect(client.abort()).rejects.toThrow('未运行');
    // listener 已摘：再推帧无反应
    pushFrame(child, { type: 'agent_start' });
    expect(client.isTurnActive()).toBe(false);
  });
});
