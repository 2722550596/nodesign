/**
 * pi-jsonl.js 回归（M1 G1，doc §5.5 / 计划 C5）：
 *   - pi JSONL fixture（header + user string + user TextContent[] + assistant
 *     [thinking,text,toolCall] + toolResult(含 image) + state/preset_change 噪声
 *     + 坏 JSON 行）→ readPiSessionMessages 逐条断言 SDK SessionMessage 形状
 *   - findLatestSessionFile 多文件取最新 mtime / 空目录 null；hasPiSession
 *   - readPiSessionInfo 字段（header id/cwd、session_info title、mtime、messageCount）
 *   - readLastAssistantUsage（context-usage 近似口径的数据源）
 *   - 前端契约回归：输出喂 web/src/lib/session-to-messages.js 的
 *     sessionMessagesToDisplay，断言 display messages 形状（user/assistant/
 *     thinking/tool + tool_result 回填 status/output/images）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  piSessionDir,
  findLatestSessionFile,
  hasPiSession,
  readPiSessionMessages,
  readPiSessionInfo,
  readLastAssistantUsage,
  readLastUserEntryId,
} from './pi-jsonl.js';
import { sessionMessagesToDisplay } from '../../../web/src/lib/session-to-messages.js';

const PI_SESSION_ID = '7f3c1a2e-9b4d-4e8a-b6c1-2d3e4f5a6b7c';
const USAGE_M3 = {
  input: 10, output: 20, cacheRead: 100, cacheWrite: 5, totalTokens: 135,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const USAGE_M5 = {
  input: 30, output: 40, cacheRead: 200, cacheWrite: 8, totalTokens: 278,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 一条 message entry（pi session-manager SessionMessageEntry 形状）。
 *  M3c：pi JSONL 是 append-only 树，parentId 串成单链（根 parentId:null）。
 *  fixture 按真实形态链起来，活动分支 walk 才能走通（全 null 是退化假树）。 */
const msgEntry = (id, parentId, timestamp, message) => ({
  type: 'message', id, parentId, timestamp, message,
});

/** 主 fixture：header + 6 条 message + 2 条噪声 + 1 条坏行 */
function fixtureLines() {
  return [
    JSON.stringify({ type: 'session', version: 3, id: PI_SESSION_ID, timestamp: '2026-08-27T03:00:00.000Z', cwd: '/tmp/nd-ws' }),
    // user string content（根：parentId null）
    JSON.stringify(msgEntry('m1', null, '2026-08-27T03:00:01.000Z', {
      role: 'user', content: '画一个登录页', timestamp: Date.parse('2026-08-27T03:00:01.000Z'),
    })),
    // user TextContent[]（image 在 user 里前端不展示 → 映射时略）
    JSON.stringify(msgEntry('m2', 'm1', '2026-08-27T03:00:02.000Z', {
      role: 'user',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
      timestamp: Date.parse('2026-08-27T03:00:02.000Z'),
    })),
    // assistant [thinking, text, toolCall]
    JSON.stringify(msgEntry('m3', 'm2', '2026-08-27T03:00:03.000Z', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先想一下。' },
        { type: 'text', text: '好的，开始写。' },
        { type: 'toolCall', id: 'tc1', name: 'write_file', arguments: { path: 'a.html' } },
      ],
      api: 'anthropic-messages', provider: 'gmi', model: 'wire/x',
      usage: USAGE_M3, stopReason: 'toolUse',
      timestamp: Date.parse('2026-08-27T03:00:03.000Z'),
    })),
    // toolResult 成功（text + image）
    JSON.stringify(msgEntry('m4', 'm3', '2026-08-27T03:00:04.000Z', {
      role: 'toolResult', toolCallId: 'tc1', toolName: 'write_file',
      content: [
        { type: 'text', text: '已写入 a.html' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
      ],
      isError: false, timestamp: Date.parse('2026-08-27T03:00:04.000Z'),
    })),
    // assistant 第二条（带新 usage，readLastAssistantUsage 应取这条）
    JSON.stringify(msgEntry('m5', 'm4', '2026-08-27T03:00:05.000Z', {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'ls' } }],
      api: 'anthropic-messages', provider: 'gmi', model: 'wire/x',
      usage: USAGE_M5, stopReason: 'toolUse',
      timestamp: Date.parse('2026-08-27T03:00:05.000Z'),
    })),
    // toolResult 失败
    JSON.stringify(msgEntry('m6', 'm5', '2026-08-27T03:00:06.000Z', {
      role: 'toolResult', toolCallId: 'tc2', toolName: 'bash',
      content: [{ type: 'text', text: 'boom: command not found' }],
      isError: true, timestamp: Date.parse('2026-08-27T03:00:06.000Z'),
    })),
    // 噪声 entry（非 message，跳过；仍挂在链上，walk 会经过但 mapMessageEntry 返 null）
    JSON.stringify({ type: 'state', id: 's1', parentId: 'm6', timestamp: '2026-08-27T03:00:07.000Z', state: {} }),
    JSON.stringify({ type: 'preset_change', id: 'p1', parentId: 's1', timestamp: '2026-08-27T03:00:08.000Z', presetId: 'nodesign-base' }),
    // 坏 JSON 行（跳过不炸）
    '{not valid json',
  ];
}

let tmpRoot;
let sessionDir;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-pi-jsonl-'));
  sessionDir = path.join(tmpRoot, 'sid-main');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `2026-08-27T03-00-00-000Z_${PI_SESSION_ID}.jsonl`),
    `${fixtureLines().join('\n')}\n`,
    'utf8',
  );
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('readPiSessionMessages（C5 映射）', () => {
  it('逐条输出 SDK SessionMessage 形状；噪声/坏行跳过', async () => {
    const msgs = await readPiSessionMessages(sessionDir);
    expect(msgs.map(m => m.uuid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

    // user string content 原样
    expect(msgs[0]).toEqual({
      type: 'user', uuid: 'm1', timestamp: '2026-08-27T03:00:01.000Z',
      message: { role: 'user', content: '画一个登录页' },
    });

    // user TextContent[]：text 保留；ImageContent 转 Anthropic image block
    // （C5 允许"略或转"，转了更保真；前端 user 分支只读 text/tool_result，image 静默跳过）
    expect(msgs[1].type).toBe('user');
    expect(msgs[1].message.content).toEqual([
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
    ]);

    // assistant：thinking / text / toolCall→tool_use
    expect(msgs[2]).toEqual({
      type: 'assistant', uuid: 'm3', timestamp: '2026-08-27T03:00:03.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先想一下。' },
          { type: 'text', text: '好的，开始写。' },
          { type: 'tool_use', id: 'tc1', name: 'write_file', input: { path: 'a.html' } },
        ],
      },
    });

    // toolResult → user 消息包 tool_result（SDK 约定）；image → base64 source 形状
    expect(msgs[3].type).toBe('user');
    expect(msgs[3].message.role).toBe('user');
    expect(msgs[3].message.content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'tc1',
      content: [
        { type: 'text', text: '已写入 a.html' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aW1nMg==' } },
      ],
      is_error: false,
    }]);

    // 失败 toolResult：is_error true
    expect(msgs[5].message.content[0].is_error).toBe(true);
    expect(msgs[5].message.content[0].tool_use_id).toBe('tc2');
  });

  it('目录不存在 / 空目录 → []', async () => {
    expect(await readPiSessionMessages(path.join(tmpRoot, 'nope'))).toEqual([]);
    const empty = path.join(tmpRoot, 'empty');
    await fs.mkdir(empty, { recursive: true });
    expect(await readPiSessionMessages(empty)).toEqual([]);
  });
});

describe('findLatestSessionFile / hasPiSession', () => {
  it('多文件取最新 mtime；非 .jsonl 忽略', async () => {
    const dir = path.join(tmpRoot, 'sid-multi');
    await fs.mkdir(dir, { recursive: true });
    const older = path.join(dir, '2026-08-01T00-00-00-000Z_aaaa.jsonl');
    const newer = path.join(dir, '2026-08-20T00-00-00-000Z_bbbb.jsonl');
    await fs.writeFile(older, '');
    await fs.writeFile(newer, '');
    await fs.writeFile(path.join(dir, 'notes.txt'), '');
    // 文件名日期与 mtime 故意不一致 —— 发现只认 mtime
    await fs.utimes(older, new Date('2026-08-25T00:00:00Z'), new Date('2026-08-25T00:00:00Z'));
    await fs.utimes(newer, new Date('2026-08-21T00:00:00Z'), new Date('2026-08-21T00:00:00Z'));
    expect(await findLatestSessionFile(dir)).toBe(older);
    expect(await hasPiSession(dir)).toBe(true);
  });

  it('空目录 / 不存在目录 → null / false', async () => {
    const empty = path.join(tmpRoot, 'sid-none');
    await fs.mkdir(empty, { recursive: true });
    expect(await findLatestSessionFile(empty)).toBeNull();
    expect(await hasPiSession(empty)).toBe(false);
    expect(await findLatestSessionFile(path.join(tmpRoot, 'missing'))).toBeNull();
    expect(await hasPiSession(path.join(tmpRoot, 'missing'))).toBe(false);
  });
});

describe('readPiSessionInfo', () => {
  it('header id/cwd、session_info title、mtime、messageCount', async () => {
    const dir = path.join(tmpRoot, 'sid-info');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `2026-08-27T04-00-00-000Z_${PI_SESSION_ID}.jsonl`);
    await fs.writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: PI_SESSION_ID, timestamp: '2026-08-27T04:00:00.000Z', cwd: '/tmp/nd-ws' }),
      JSON.stringify({ type: 'session_info', id: 'si1', parentId: null, timestamp: '2026-08-27T04:00:01.000Z', name: '登录页项目' }),
      JSON.stringify(msgEntry('u1', null, '2026-08-27T04:00:02.000Z', { role: 'user', content: '帮我做一个落地页，要好看。', timestamp: 0 })),
      JSON.stringify(msgEntry('a1', 'u1', '2026-08-27T04:00:03.000Z', {
        role: 'assistant', content: [{ type: 'text', text: '好。' }],
        usage: USAGE_M3, stopReason: 'stop', timestamp: 0,
      })),
      '{bad',
    ].join('\n'), 'utf8');

    const info = await readPiSessionInfo(dir);
    expect(info.sessionId).toBe('sid-info');          // 目录名 = Nodesign sid
    expect(info.piSessionId).toBe(PI_SESSION_ID);     // header.id
    expect(info.cwd).toBe('/tmp/nd-ws');
    expect(info.customTitle).toBe('登录页项目');       // session_info.name
    expect(info.firstPrompt).toBe('帮我做一个落地页，要好看。');
    expect(info.summary).toBe('帮我做一个落地页，要好看。');
    expect(info.messageCount).toBe(2);
    const st = await fs.stat(file);
    expect(info.lastModified).toBe(st.mtimeMs);
  });

  it('无 session_info → customTitle null；无 user 消息 → summary null', async () => {
    const dir = path.join(tmpRoot, 'sid-bare');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'x.jsonl'), [
      JSON.stringify({ type: 'session', id: PI_SESSION_ID, timestamp: '2026-08-27T05:00:00.000Z', cwd: '/w' }),
      JSON.stringify(msgEntry('a1', null, '2026-08-27T05:00:01.000Z', {
        role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: USAGE_M3, stopReason: 'stop', timestamp: 0,
      })),
    ].join('\n'), 'utf8');
    const info = await readPiSessionInfo(dir);
    expect(info.customTitle).toBeNull();
    expect(info.summary).toBeNull();
    expect(info.firstPrompt).toBeNull();
    expect(info.messageCount).toBe(1);
  });

  it('目录不存在 → null', async () => {
    expect(await readPiSessionInfo(path.join(tmpRoot, 'ghost'))).toBeNull();
  });
});

describe('readLastAssistantUsage（context-usage 数据源）', () => {
  it('取最后一条 assistant 的 usage（倒扫）', async () => {
    expect(await readLastAssistantUsage(sessionDir)).toEqual(USAGE_M5);
  });

  it('无 assistant / 无目录 → null', async () => {
    const dir = path.join(tmpRoot, 'sid-nousage');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'x.jsonl'), JSON.stringify(
      msgEntry('u1', null, '2026-08-27T06:00:00.000Z', { role: 'user', content: 'hi', timestamp: 0 }),
    ), 'utf8');
    expect(await readLastAssistantUsage(dir)).toBeNull();
    expect(await readLastAssistantUsage(path.join(tmpRoot, 'ghost'))).toBeNull();
  });
});

describe('piSessionDir', () => {
  it('join(dataRoot, pi-sessions, sid)', () => {
    expect(piSessionDir('/data', 'abc')).toBe(path.join('/data', 'pi-sessions', 'abc'));
  });
});

describe('前端契约回归（sessionMessagesToDisplay 零改动消费）', () => {
  it('display messages 形状：user/assistant/thinking/tool + tool_result 回填', async () => {
    const msgs = await readPiSessionMessages(sessionDir);
    const display = sessionMessagesToDisplay(msgs);

    // m1 user string
    expect(display[0]).toEqual({ id: 'm1', role: 'user', content: '画一个登录页' });
    // m2 user text blocks join
    expect(display[1]).toEqual({ id: 'm2', role: 'user', content: '第一段\n\n第二段' });
    // m3 assistant per-block：thinking / text / tool
    expect(display[2]).toMatchObject({ id: 'm3:thinking:0', role: 'thinking', content: '先想一下。', hydrated: true });
    expect(display[3]).toMatchObject({ id: 'm3:text:1', role: 'assistant', content: '好的，开始写。', hydrated: true });
    const tool1 = display[4];
    expect(tool1).toMatchObject({ id: 'tc1', role: 'tool', toolName: 'write_file', toolInput: { path: 'a.html' } });
    // m4 tool_result 回填：status / output / images（image source 形状被前端读到）
    expect(tool1.status).toBe('success');
    expect(tool1.toolOutput).toBe('已写入 a.html');
    expect(tool1.toolImages).toEqual([{ data: 'aW1nMg==', mediaType: 'image/jpeg' }]);
    // m5 assistant tool_use（tc2）
    const tool2 = display[5];
    expect(tool2).toMatchObject({ id: 'tc2', role: 'tool', toolName: 'bash' });
    // m6 失败 tool_result 回填：status error + toolError
    expect(tool2.status).toBe('error');
    expect(tool2.toolError).toBe('boom: command not found');
    // 无多余条目（噪声/坏行不进 display）
    expect(display).toHaveLength(6);
  });
});

// ── M3c：活动分支（rewind 后旧分支不进 hydrate / 索引不误记旧分支）──

/** 分叉 fixture：m1 → m2 → m3（旧分支），rewind 到 m1 后新分支 m4 → m5。
 *  pi navigate_tree 语义（agent-session.ts L4123-4126）：目标是 user message 时
 *  leaf 移到它的 **parentId**（回滚位 = 该消息发出前），文本回编辑器；随后
 *  appendLabelChange(targetId) 落一条 label entry，parentId = 导航后的 leaf
 *  （session-manager.ts L1346）。所以 m1 是根时 label 的 parentId 是 null，
 *  活动分支 = label → 新消息，旧分支 m1/m2/m3 全部不在路径上。 */
function forkedFixtureLines() {
  const E = (id, parentId, timestamp, message) => JSON.stringify({
    type: 'message', id, parentId, timestamp, message,
  });
  return [
    JSON.stringify({ type: 'session', version: 3, id: PI_SESSION_ID, timestamp: '2026-08-28T00:00:00.000Z', cwd: '/tmp/nd-ws' }),
    E('m1', null, '2026-08-28T00:00:01.000Z', { role: 'user', content: '第一条', timestamp: 0 }),
    E('m2', 'm1', '2026-08-28T00:00:02.000Z', {
      role: 'assistant', content: [{ type: 'text', text: '旧回复' }], stopReason: 'stop', timestamp: 0,
    }),
    E('m3', 'm2', '2026-08-28T00:00:03.000Z', { role: 'user', content: '旧分支第二条', timestamp: 0 }),
    // rewind 到 m1（user message，根）：leaf → m1.parentId = null；label 落盘挂在导航后的 leaf 下
    JSON.stringify({ type: 'label', id: 'lb1', parentId: null, timestamp: '2026-08-28T00:00:04.000Z', targetId: 'm1', label: 'rewind' }),
    // 新分支：用户重发（parent = label），assistant 新回复
    E('m4', 'lb1', '2026-08-28T00:00:05.000Z', { role: 'user', content: '新分支用户消息', timestamp: 0 }),
    E('m5', 'm4', '2026-08-28T00:00:06.000Z', {
      role: 'assistant', content: [{ type: 'text', text: '新回复' }], stopReason: 'stop', timestamp: 0,
    }),
  ];
}

describe('M3c 活动分支（rewind 后 hydrate 只显示新分支）', () => {
  let forkDir;
  beforeAll(async () => {
    forkDir = path.join(tmpRoot, 'sid-forked');
    await fs.mkdir(forkDir, { recursive: true });
    await fs.writeFile(
      path.join(forkDir, `2026-08-28T00-00-00-000Z_${PI_SESSION_ID}.jsonl`),
      `${forkedFixtureLines().join('\n')}\n`,
      'utf8',
    );
  });

  it('readPiSessionMessages 只走活动分支（旧分支 m1/m2/m3 不出现）', async () => {
    const msgs = await readPiSessionMessages(forkDir);
    // 活动分支：label（非 message 跳过）→ m4 → m5；rewind 目标 m1 本身也在旧侧
    // （user message 回滚位 = 它的 parent，消息文本回编辑器，不进对话）
    expect(msgs.map(m => m.uuid)).toEqual(['m4', 'm5']);
    expect(msgs[1].message.content).toEqual([{ type: 'text', text: '新回复' }]);
  });
  it('readLastUserEntryId 走活动分支（不误读旧分支的 m3/m1）', async () => {
    expect(await readLastUserEntryId(forkDir)).toBe('m4');
  });
  it('单链文件行为不变（活动分支 = 全文件）', async () => {
    const msgs = await readPiSessionMessages(sessionDir);
    expect(msgs.map(m => m.uuid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('无树结构的老 JSONL（entry 无 parentId 键）→ 退回平铺', async () => {
    const dir = path.join(tmpRoot, 'sid-flat');
    await fs.mkdir(dir, { recursive: true });
    // 退化形态：entry 完全没有 parentId 键（v1 迁移前）—— 兜底平铺全部
    const flat = (id, ts, message) => JSON.stringify({ type: 'message', id, timestamp: ts, message });
    await fs.writeFile(path.join(dir, 'x.jsonl'), [
      flat('f1', '2026-08-28T01:00:01.000Z', { role: 'user', content: '老格式一', timestamp: 0 }),
      flat('f2', '2026-08-28T01:00:02.000Z', {
        role: 'assistant', content: [{ type: 'text', text: '老回复' }], stopReason: 'stop', timestamp: 0,
      }),
    ].join('\n'), 'utf8');
    const msgs = await readPiSessionMessages(dir);
    expect(msgs.map(m => m.uuid)).toEqual(['f1', 'f2']);
    // readLastUserEntryId 兜底倒扫
    expect(await readLastUserEntryId(dir)).toBe('f1');
  });
});

describe('readLastUserEntryId（M3c rewind 索引数据源）', () => {
  it('主 fixture：活动分支最后一条 user = m2', async () => {
    // 链：m1(u) → m2(u) → m3(a) → m4(tr) → m5(a) → m6(tr) → s1 → p1
    expect(await readLastUserEntryId(sessionDir)).toBe('m2');
  });

  it('目录不存在 / 无 user entry → null', async () => {
    expect(await readLastUserEntryId(path.join(tmpRoot, 'ghost'))).toBeNull();
    const dir = path.join(tmpRoot, 'sid-nouser');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'x.jsonl'), JSON.stringify({
      type: 'message', id: 'a1', parentId: null, timestamp: '2026-08-28T02:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    }), 'utf8');
    expect(await readLastUserEntryId(dir)).toBeNull();
  });
});
