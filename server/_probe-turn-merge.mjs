/**
 * server/_probe-turn-merge.mjs — streamInput 下「turn 进行中追加消息」的真实行为探针。
 *
 * 背景（2026-08-19 定案的 run 记账错位案，见 memory nodesign-chat-composer-fixes）：
 * session-loop 的记账靠「一条用户消息 = 一个 result」接力；CLI 若把追加消息并进
 * 正在跑的这一轮，链就永久错一格。修法要先回答三个只有真跑才知道的问题：
 *
 *   1. `--replay-user-messages`（SDK extraArgs 透传）回显的 user 消息带不带我们
 *      push 时盖的 uuid？回显在 push 后多久到 —— 是「读到 stdin」就回，还是
 *      「真正开始处理那条」才回？（决定它能不能当 turn 边界的锚）
 *   2. 追加的消息到底并不并轮：这轮出几个 result？第一个 result 的正文里回没回第二条？
 *   3. 出站消息的 `priority: 'later'` 是不是「排到下一轮、别并轮」的旋钮？
 *
 * 用法：node server/_probe-turn-merge.mjs [--priority later|next|now] [--delay 2500] [--model sonnet]
 * 走订阅路（~/.claude OAuth），不注入任何 ANTHROPIC_*。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PRIORITY = opt('priority', null);
const DELAY = Number(opt('delay', 2500));
const MODEL = opt('model', 'sonnet');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-probe-merge-'));
const t0 = Date.now();
const ts = () => String(Date.now() - t0).padStart(6, ' ') + 'ms';
const log = (...a) => console.log(ts(), ...a);

// 我们自己的 AsyncIterable，与 server/lib/async-queue.js 同形（push/pull 解耦）
const items = []; const waiters = []; let closed = false;
const q = {
  push(m) { if (waiters.length) waiters.shift()({ value: m, done: false }); else items.push(m); },
  close() { closed = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }); },
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (items.length) return Promise.resolve({ value: items.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => waiters.push(r));
      },
      return: () => { q.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  },
};

const mk = (text, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  uuid: randomUUID(),
  ...extra,
});

const m1 = mk('Use the Bash tool to run exactly this command: `sleep 8 && echo A-DONE`. When it finishes, reply with exactly one line: FIRST-DONE');
const m2text = 'Second request: use the Bash tool to run `echo B-DONE`, then reply with exactly one line: SECOND-DONE';
const m2 = mk(m2text, PRIORITY ? { priority: PRIORITY } : {});

log('cwd', cwd, 'model', MODEL, 'priority', PRIORITY ?? '(unset)', 'delay', DELAY);
log('m1.uuid', m1.uuid);
log('m2.uuid', m2.uuid);

const stream = query({
  prompt: q,
  options: {
    cwd,
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    tools: ['Bash'],
    systemPrompt: 'You are a terse test harness. Follow instructions literally.',
    extraArgs: { 'replay-user-messages': null },
    maxTurns: 20,
  },
});

let pushedM2At = null;
let results = 0;
const timeline = [];

q.push(m1);
log('PUSH m1');
setTimeout(() => { q.push(m2); pushedM2At = Date.now(); log('PUSH m2'); }, DELAY);

// 安全阀：60s 后关
const killer = setTimeout(() => { log('TIMEOUT, closing'); q.close(); }, 60_000);

for await (const msg of stream) {
  const rec = { t: Date.now() - t0, type: msg.type, subtype: msg.subtype };
  if (msg.type === 'user') {
    const content = msg.message?.content;
    const blocks = Array.isArray(content) ? content : [{ type: typeof content, text: String(content) }];
    const kinds = blocks.map((b) => b.type).join(',');
    const isToolResult = blocks.some((b) => b.type === 'tool_result');
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 60);
    rec.uuid = msg.uuid; rec.kinds = kinds; rec.isToolResult = isToolResult; rec.text = text;
    rec.isSynthetic = msg.isSynthetic; rec.priority = msg.priority;
    const which = msg.uuid === m1.uuid ? 'm1' : msg.uuid === m2.uuid ? 'm2' : '?';
    log(`USER  uuid=${msg.uuid ?? '-'} match=${which} kinds=${kinds} synth=${msg.isSynthetic ?? '-'} prio=${msg.priority ?? '-'}`
      + (isToolResult ? '' : ` text="${text}"`)
      + (which === 'm2' && pushedM2At ? `  (+${Date.now() - pushedM2At}ms after push)` : ''));
  } else if (msg.type === 'assistant') {
    const blocks = msg.message?.content || [];
    const summary = blocks.map((b) => b.type === 'text' ? `text:"${b.text.slice(0, 50).replace(/\n/g, ' ')}"` : b.type === 'tool_use' ? `tool_use:${b.name}(${JSON.stringify(b.input).slice(0, 40)})` : b.type).join(' | ');
    log('ASSIST', summary);
  } else if (msg.type === 'result') {
    results += 1;
    rec.result = String(msg.result ?? '').slice(0, 80);
    log(`RESULT #${results} subtype=${msg.subtype} num_turns=${msg.num_turns} text="${rec.result}"`);
    if (results >= 2) { q.close(); }
    // 单 result 情形：给 3s 看还有没有第二个 result 来
    else setTimeout(() => { if (results < 2) { log('no 2nd result within 6s of first → closing'); q.close(); } }, 6000);
  } else if (msg.type === 'system') {
    log('SYSTEM', msg.subtype, msg.subtype === 'init' ? `model=${msg.model} mode=${msg.permissionMode}` : '');
  } else {
    log(msg.type, msg.subtype ?? '');
  }
  timeline.push(rec);
}
clearTimeout(killer);

log('=== SUMMARY ===');
log('results:', results);
const replayM2 = timeline.find((r) => r.type === 'user' && r.uuid === m2.uuid);
log('m2 replayed:', !!replayM2, replayM2 ? `at +${replayM2.t - (pushedM2At - t0)}ms after push` : '');
const firstResult = timeline.find((r) => r.type === 'result');
if (firstResult) log('first result mentions SECOND-DONE:', /SECOND-DONE/.test(firstResult.result));
fs.rmSync(cwd, { recursive: true, force: true });
