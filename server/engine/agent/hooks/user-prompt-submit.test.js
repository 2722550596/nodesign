/**
 * 每轮状态注入：首轮全量、之后只报变化（2026-08-21）。
 * renderTurnState 是纯函数；handler 那条用临时工作区真跑两轮。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderTurnState, makeUserPromptSubmitHandler } from './user-prompt-submit.js';
import { resetTurnMemory, diffItems, fingerprint } from './turn-state-memory.js';

const sec = (key, text, items) => ({ key, title: key, text, ...(items ? { items } : {}) });

describe('renderTurnState', () => {
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
});

describe('handler 真跑两轮（临时工作区）', () => {
  it('第二轮"与上轮相同"；加一张便利贴后第三轮只报那一节', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ups-'));
    await fs.mkdir(path.join(ws, 'notes'));
    await fs.writeFile(path.join(ws, 'notes', 'a.md'), '# 第一张\n\n内容');
    const sid = `test-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: ws, sessionId: sid, projectId: 'proj_ups_test0001' });
    const r1 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r1).toMatch(/^\[NoDesign 工作台自动注入的当前状态\]/);
    expect(r1).toMatch(/notes\/a\.md（第一张）/);
    const r2 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r2).toMatch(/^\[工作台状态：与上轮相同/);
    expect(r2.length).toBeLessThan(r1.length / 3);
    await fs.writeFile(path.join(ws, 'notes', 'b.md'), '# 第二张');
    const r3 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r3).toMatch(/便利贴（有变化）：新增 1：notes\/b\.md/);
    expect(r3).not.toMatch(/notes\/a\.md（第一张）/);   // 没变的贴不再重复
    resetTurnMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });
});
