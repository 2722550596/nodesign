/**
 * turn-state.test.js — 每 turn 动态状态注入装配（M2 pi 化，原 hooks/user-prompt-submit 的搬家回归）
 *
 * 钉住的语义：
 *   ① assembleTurnContext 对临时工作区（notes/*.md + 假 assets/）返回含 notes 清单的 <system> 块
 *   ② 二次调用同 sessionId：未变化节走 diff（输出显著更短 + 含"与上轮相同"标记）
 *   ③ resetTurnStateMemory 后再调 → 回全量
 *   ④ 采集异常 fail-soft：指向不存在目录不 throw
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assembleTurnContext, resetTurnStateMemory, collectSections, renderTurnState,
  fingerprint, diffItems, _memory,
} from './turn-state.js';

/** 造一个最小工作区：notes/ 两张贴 + assets/ 一张图 */
async function makeWorkspace() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-turn-state-'));
  await fs.mkdir(path.join(ws, 'notes'));
  await fs.writeFile(path.join(ws, 'notes', 'a.md'), '# 第一张\n\n内容');
  await fs.writeFile(path.join(ws, 'notes', 'b.md'), '# 第二张');
  await fs.mkdir(path.join(ws, 'assets'));
  await fs.writeFile(path.join(ws, 'assets', 'ref.png'), 'fake-png');
  return ws;
}

const freshSid = () => `ts-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('assembleTurnContext', () => {
  let ws;
  let sid;
  beforeEach(async () => {
    ws = await makeWorkspace();
    sid = freshSid();
  });

  it('① 首轮全量：<system> 包裹 + notes 清单 + 素材清单', async () => {
    const out = await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    expect(out).toBeTruthy();
    expect(out.startsWith('<system>')).toBe(true);
    expect(out.endsWith('</system>')).toBe(true);
    expect(out).toMatch(/\[NoDesign 工作台自动注入的当前状态\]/);
    // notes 清单（文件名 + 首行标题）
    expect(out).toMatch(/notes\/a\.md（第一张）/);
    expect(out).toMatch(/notes\/b\.md（第二张）/);
    // 素材清单（assets/ 顶层那张假图）
    expect(out).toMatch(/assets\/ref\.png/);
    // 结尾那句
    expect(out).toMatch(/请基于这些信息处理用户的请求/);
    resetTurnStateMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('② 二次调用同 sessionId 未变化 → diff（显著更短 + 与上轮相同标记）', async () => {
    const r1 = await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    const r2 = await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    expect(r2).toMatch(/\[工作台状态：与上轮相同/);
    expect(r2.length).toBeLessThan(r1.length / 3);
    // 未变化的 notes 全文不再重复
    expect(r2).not.toMatch(/notes\/a\.md（第一张）/);
    resetTurnStateMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('②b 加一张便利贴后第三轮只报那一节的变化', async () => {
    await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    await fs.writeFile(path.join(ws, 'notes', 'c.md'), '# 第三张');
    const r3 = await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    expect(r3).toMatch(/\[工作台状态 · 只报变化\]/);
    expect(r3).toMatch(/便利贴（有变化）：新增 1：notes\/c\.md/);
    expect(r3).not.toMatch(/notes\/a\.md（第一张）/);   // 没变的贴不再重复
    resetTurnStateMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('③ resetTurnStateMemory 后再调 → 回全量', async () => {
    const r1 = await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });   // 进 diff 态
    resetTurnStateMemory(sid);
    const r3 = await assembleTurnContext({ sessionId: sid, workspaceRoot: ws });
    expect(r3).toMatch(/\[NoDesign 工作台自动注入的当前状态\]/);
    expect(r3).toMatch(/notes\/a\.md（第一张）/);
    expect(r3.length).toBeGreaterThan(r1.length / 2);   // 回到全量量级
    resetTurnStateMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('④ 采集异常 fail-soft：不存在的目录不 throw，仍返回 cwd 块', async () => {
    const ghost = path.join(os.tmpdir(), `nd-ghost-${Date.now()}`);   // 不 mkdir
    // 不 throw 本身就是断言：抛了这条测试直接红
    const out = await assembleTurnContext({ sessionId: freshSid(), workspaceRoot: ghost });
    // notes/assets 采不到就沉默，但 cwd 节还在（workspaceRoot 给了就有）
    expect(out).toMatch(/你的 cwd 是/);
    expect(out).not.toMatch(/notes\//);
  });

  it('没给 workspaceRoot → null（runTurn 侧据此跳过装配）', async () => {
    expect(await assembleTurnContext({ sessionId: freshSid() })).toBeNull();
  });
});

describe('collectSections / renderTurnState 纯函数回归', () => {
  const sec = (key, text, items) => ({ key, title: key, text, ...(items ? { items } : {}) });

  it('首轮全量 + 结尾那句；记忆里每节有指纹', () => {
    const r = renderTurnState([sec('cwd', 'cwd=/x'), sec('notes', '便利贴：a', ['a'])], null);
    expect(r.text).toMatch(/^\[NoDesign 工作台自动注入的当前状态\]/);
    expect(r.text).toMatch(/cwd=\/x/);
    expect(r.text).toMatch(/请基于这些信息处理用户的请求/);
    expect(r.next.get('notes').items).toEqual(['a']);
  });

  it('一节都没变 → 一句话', () => {
    const s = [sec('cwd', 'cwd=/x'), sec('notes', '便利贴：a', ['a'])];
    const first = renderTurnState(s, null);
    const second = renderTurnState(s, first.next);
    expect(second.text).toBe('[工作台状态：与上轮相同（cwd、notes）]');
  });

  it('清单类只报新增/移除，非清单类变了报全文，没变的只点名', () => {
    const first = renderTurnState([sec('cwd', 'cwd=/x'), sec('assets', '素材 2 件', ['a', 'b']), sec('artifacts', '产物：p1')], null);
    const second = renderTurnState([sec('cwd', 'cwd=/x'), sec('assets', '素材 3 件', ['a', 'c', 'd']), sec('artifacts', '产物：p1 p2')], first.next);
    expect(second.text).toMatch(/^\[工作台状态 · 只报变化\]/);
    expect(second.text).toMatch(/assets（有变化）：新增 2：c、d；移除 1：b（现共 3 件）/);
    expect(second.text).toMatch(/（有变化）产物：p1 p2/);
    expect(second.text).toMatch(/未变：cwd/);
    expect(second.text).not.toMatch(/素材 3 件/);   // 清单类不重复全文
  });

  it('新出现 / 已不存在 的节', () => {
    const first = renderTurnState([sec('cwd', 'cwd=/x'), sec('tweaks', '开')], null);
    const second = renderTurnState([sec('cwd', 'cwd=/x'), sec('notes', '便利贴：a', ['a'])], first.next);
    expect(second.text).toMatch(/（新出现）便利贴：a/);
    expect(second.text).toMatch(/已不存在：tweaks/);
  });

  it('diffItems / fingerprint', () => {
    expect(diffItems(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(fingerprint('x')).toBe(fingerprint('x'));
    expect(fingerprint('x')).not.toBe(fingerprint('y'));
  });

  it('collectSections：projectId 缺省 → 视点/关系线缺席，其余节照采', async () => {
    const ws = await makeWorkspace();
    const sections = await collectSections({ workspaceRoot: ws, sessionId: freshSid() });
    const keys = sections.map(s => s.key);
    expect(keys).toContain('cwd');
    expect(keys).toContain('notes');
    expect(keys).toContain('assets');
    expect(keys).not.toContain('viewpoint');
    expect(keys).not.toContain('relations');
    await fs.rm(ws, { recursive: true, force: true });
  });
});
