import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  emptyPresence, reducePresence, activePresences, followTarget,
  colorFor, PRESENCE_COLORS, MAIN_AGENT_ID,
} from './board-presence.js';

/** 把文件路径解析成物件的假 resolver（真的住在 stage.js） */
const resolve = (p) => (p ? { objectId: p, zoneId: `task/${String(p).split('/')[1] || 'x'}` } : null);
const run = (events, r = resolve) => events.reduce((t, e) => reducePresence(t, e, r), emptyPresence());

describe('上场与下场', () => {
  it('run.start 让主 agent 上场', () => {
    const t = run([{ type: 'run.start' }]);
    expect(activePresences(t)).toHaveLength(1);
    expect(t[MAIN_AGENT_ID].kind).toBe('main');
    expect(t[MAIN_AGENT_ID].color).toBe(PRESENCE_COLORS[0]);
  });

  it('重复的 run.start 不会造出第二个主 agent', () => {
    const t = run([{ type: 'run.start' }, { type: 'run.start' }]);
    expect(Object.keys(t)).toHaveLength(1);
  });

  it('每个子代理一条，名字取 subagent_type', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a', agentType: 'explorer' },
      { type: 'run.task.started', toolUseId: 'b', agentType: 'vision-checker' },
    ]);
    expect(activePresences(t)).toHaveLength(3);
    expect(t['agent:a'].name).toBe('explorer');
    expect(t['agent:b'].name).toBe('vision-checker');
  });

  it('颜色互不相同（三个同色就分不出谁是谁）', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.task.started', toolUseId: 'b' },
    ]);
    const colors = Object.values(t).map(p => p.color);
    expect(new Set(colors).size).toBe(3);
  });

  it('子代理结束 = 下场但不删（留一会儿让用户看清它刚做完什么）', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.subagent.stop', toolUseId: 'a' },
    ]);
    expect(t['agent:a']).toBeTruthy();
    expect(t['agent:a'].active).toBe(false);
    expect(activePresences(t).map(p => p.id)).toEqual([MAIN_AGENT_ID]);
  });

  /**
   * 整轮结束必须全体下场。子代理的 stop 事件不保证都到齐 —— 漏一个就会在
   * 画布上留一个永远"正在干活"的幽灵光标。
   */
  it('run.done 全体下场，即使子代理的 stop 没来', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.task.started', toolUseId: 'b' },
      { type: 'run.done' },
    ]);
    expect(activePresences(t)).toHaveLength(0);
  });

  it('run.error 同样全体下场', () => {
    const t = run([{ type: 'run.start' }, { type: 'run.error' }]);
    expect(activePresences(t)).toHaveLength(0);
  });
});

describe('位置与话', () => {
  it('file_changed 更新那个人的位置', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.file_changed', filePath: 'tasks/海报/a.html' },
    ]);
    expect(t[MAIN_AGENT_ID].targetId).toBe('tasks/海报/a.html');
    expect(t[MAIN_AGENT_ID].zoneId).toBe('task/海报');
  });

  /**
   * 带 parentToolUseId 的事件属于**子代理**，不能算到主 agent 头上 ——
   * 算错了就会看到主 agent 的光标在子代理动的文件之间瞬移。
   */
  it('子代理的 file_changed 只动它自己的位置', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' },
    ]);
    expect(t['agent:a'].targetId).toBe('tasks/甲/x.md');
    expect(t[MAIN_AGENT_ID].targetId).toBeNull();
  });

  it('解析不出物件就不动位置（不要指向一个不存在的东西）', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md' },
      { type: 'run.file_changed', filePath: null },
    ], (p) => (p === 'tasks/甲/x.md' ? { objectId: p, zoneId: 'task/甲' } : null));
    expect(t[MAIN_AGENT_ID].targetId).toBe('tasks/甲/x.md');
  });

  it('位置没变就返回同一个引用（不制造无谓重渲染）', () => {
    const a = run([{ type: 'run.start' }, { type: 'run.file_changed', filePath: 'tasks/甲/x.md' }]);
    const b = reducePresence(a, { type: 'run.file_changed', filePath: 'tasks/甲/x.md' }, resolve);
    expect(b).toBe(a);
  });

  it('tool_use 更新那句"正在做什么"', () => {
    const t = run([{ type: 'run.start' }, { type: 'run.tool_use_summary', summary: '正在写 canvas.html' }]);
    expect(t[MAIN_AGENT_ID].message).toBe('正在写 canvas.html');
  });

  it('没上场的人收到事件不会凭空出现', () => {
    const t = run([{ type: 'run.file_changed', filePath: 'tasks/甲/x.md' }]);
    expect(Object.keys(t)).toHaveLength(0);
  });

  it('不认识的事件原样返回同一引用', () => {
    const a = run([{ type: 'run.start' }]);
    expect(reducePresence(a, { type: 'run.delta.tool_input' }, resolve)).toBe(a);
    expect(reducePresence(a, {}, resolve)).toBe(a);
  });
});

describe('镜头跟谁', () => {
  /**
   * 「跟最近动的那个」正是以前镜头在几个子代理之间横跳的原因。
   * 定死主 agent 优先。
   */
  it('主 agent 有目标时跟主 agent', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' },
      { type: 'run.file_changed', filePath: 'tasks/乙/y.md' },
    ]);
    expect(followTarget(t).id).toBe(MAIN_AGENT_ID);
    expect(followTarget(t).targetId).toBe('tasks/乙/y.md');
  });

  it('主 agent 没目标就跟第一个有目标的子代理', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' },
    ]);
    expect(followTarget(t).id).toBe('agent:a');
  });

  it('没人有目标就不跟（镜头不该被无端拽走）', () => {
    expect(followTarget(run([{ type: 'run.start' }]))).toBeNull();
    expect(followTarget(emptyPresence())).toBeNull();
  });

  it('下场的人不参与跟随', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' },
      { type: 'run.subagent.stop', toolUseId: 'a' },
    ]);
    expect(followTarget(t)).toBeNull();
  });
});

describe('颜色表', () => {
  it('循环取色，不会越界', () => {
    expect(colorFor(0)).toBe(PRESENCE_COLORS[0]);
    expect(colorFor(PRESENCE_COLORS.length)).toBe(PRESENCE_COLORS[0]);
    expect(colorFor(999)).toBeTruthy();
  });
});

describe('事件形状 parity（2026-08-13 事故的钉子）', () => {
  // reducer 曾监听不存在的 `run.tool_use`、读不存在的 `evt.path`，而这份测试
  // 自己 mock 了同一套假形状 —— 19 条全绿、功能全死（位置和消息从未被设置）。
  // 从今往后**服务端源码是真相**：reducer 消费的每个事件类型、每个字段名，
  // 必须在 events.js 的构造器里逐字存在。mock 改形状前先看这里为什么会红。
  const eventsSrc = fs.readFileSync(
    new URL('../../../server/engine/agent/events.js', import.meta.url), 'utf8',
  );
  it.each([
    ['run.file_changed', 'filePath'],
    ['run.tool_use.started', 'name'],
    ['run.tool_use_summary', 'summary'],
  ])('事件 %s 与其字段 %s 在服务端真实存在', (type, field) => {
    expect(eventsSrc).toContain(`'${type}'`);
    const ctor = eventsSrc.split(`'${type}'`)[1]?.split('}')[0] || '';
    expect(ctor).toContain(field);
  });

  it('reducer 里消费的事件类型没有一个是编出来的', () => {
    const reducerSrc = fs.readFileSync(new URL('./board-presence.js', import.meta.url), 'utf8');
    const consumed = [...reducerSrc.matchAll(/case '(run\.[\w.]+)'/g)].map(m => m[1]);
    expect(consumed.length).toBeGreaterThan(0);
    for (const t of consumed) expect(eventsSrc).toContain(`'${t}'`);
  });
});
