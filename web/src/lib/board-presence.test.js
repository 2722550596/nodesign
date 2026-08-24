import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  emptyPresence, reducePresence, resolvePending, activePresences, followTarget,
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

  /**
   * 子代理退场（2026-08-18）：run.task.* 不再立条目，带 parentToolUseId 的
   * 事件一律忽略 —— 在场表里只有主 agent 一个人。
   */
  it('run.task.started 不再立子代理条目', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.task.started', toolUseId: 'a', agentType: 'explorer' },
    ]);
    expect(activePresences(t)).toHaveLength(1);
    expect(t['agent:a']).toBeUndefined();
  });

  it('run.done 下场', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.done' },
    ]);
    expect(activePresences(t)).toHaveLength(0);
  });

  it('run.error 同样下场', () => {
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
   * 带 parentToolUseId 的事件属于**子代理**，整条忽略且不能算到主 agent
   * 头上 —— 算错了就会看到主精灵在子代理动的文件之间瞬移。
   */
  it('子代理的 file_changed 整条忽略，不动主 agent 的位置', () => {
    const before = run([{ type: 'run.start' }]);
    const after = reducePresence(before,
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' }, resolve);
    expect(after).toBe(before);
    expect(after[MAIN_AGENT_ID].targetId).toBeNull();
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

  /**
   * 接管显形（2026-08-14）：主 agent 的活动事件=在跑的铁证 —— 切进一个正在
   * 跑的会话时 run.start 早发过了，这个标签页看不见；不就地立主 agent 的话，
   * 整轮事件被当无主拒收，精灵装闲（"换会话精灵丢状态"的病根之一）。
   */
  it('主 agent 没上过场也能被活动事件立起来（切进正在跑的会话）', () => {
    const t = run([{ type: 'run.file_changed', filePath: 'tasks/甲/x.md' }]);
    expect(t[MAIN_AGENT_ID].active).toBe(true);
    expect(t[MAIN_AGENT_ID].targetId).toBe('tasks/甲/x.md');
    const t2 = run([{ type: 'run.tool_use_summary', summary: '正在写' }]);
    expect(t2[MAIN_AGENT_ID].message).toBe('正在写');
  });

  it('子代理的事件不会凭空立出任何条目', () => {
    const t = run([{ type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' }]);
    expect(Object.keys(t)).toHaveLength(0);
  });

  it('run.cancelled 同样全体下场（取消过的轮不能留下转圈的精灵）', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md' },
      { type: 'run.cancelled' },
    ]);
    expect(activePresences(t)).toHaveLength(0);
    expect(t[MAIN_AGENT_ID].targetId).toBe('tasks/甲/x.md');   // 位置留着，下轮接着用
  });

  it('不认识的事件原样返回同一引用', () => {
    const a = run([{ type: 'run.start' }]);
    expect(reducePresence(a, { type: 'run.deck_preview' }, resolve)).toBe(a);
    expect(reducePresence(a, {}, resolve)).toBe(a);
  });

  /**
   * 开写就位（2026-08-14）：Edit/Write 入参流出 filePath 的那一拍精灵就该
   * 挪过去，不等 file_changed —— 大文件一写十几秒，只听写完信号的话精灵
   * 全程站在上一个目标上，用户看到的就是「追踪不及时」。
   */
  it('delta.tool_input 的 filePath 一到就更新位置（不等写完）', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.delta.tool_input', blockId: 'b1', name: 'Write', filePath: 'tasks/甲/x.md' },
    ]);
    expect(t[MAIN_AGENT_ID].targetId).toBe('tasks/甲/x.md');
  });

  it('delta.tool_input 没带 filePath（纯文本增量拍）不动位置', () => {
    const a = run([
      { type: 'run.start' },
      { type: 'run.delta.tool_input', blockId: 'b1', name: 'Write', filePath: 'tasks/甲/x.md' },
    ]);
    const b = reducePresence(a, { type: 'run.delta.tool_input', blockId: 'b1', name: 'Write', append: 'x' }, resolve);
    expect(b).toBe(a);
  });
});

describe('常驻（2026-08-14）', () => {
  it('run.done 下场但位置留着；下一轮 run.start 从老位置起跑', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md' },
      { type: 'run.done' },
      { type: 'run.start' },
    ]);
    expect(t[MAIN_AGENT_ID].active).toBe(true);
    expect(t[MAIN_AGENT_ID].targetId).toBe('tasks/甲/x.md');
  });
});

describe('镜头跟谁', () => {
  it('主 agent 有目标时跟主 agent，子代理的事件不干扰', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.file_changed', filePath: 'tasks/甲/x.md', parentToolUseId: 'a' },
      { type: 'run.file_changed', filePath: 'tasks/乙/y.md' },
    ]);
    expect(followTarget(t).id).toBe(MAIN_AGENT_ID);
    expect(followTarget(t).targetId).toBe('tasks/乙/y.md');
  });

  it('没人有目标就不跟（镜头不该被无端拽走）', () => {
    expect(followTarget(run([{ type: 'run.start' }]))).toBeNull();
    expect(followTarget(emptyPresence())).toBeNull();
  });

  it('下场了就不参与跟随', () => {
    const t = run([
      { type: 'run.start' },
      { type: 'run.file_changed', filePath: 'tasks/乙/y.md' },
      { type: 'run.done' },
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
    const consumed = [...reducerSrc.matchAll(/case '((?:run|board)\.[\w.]+)'/g)].map(m => m[1]);
    expect(consumed.length).toBeGreaterThan(0);
    for (const t of consumed) expect(eventsSrc).toContain(`'${t}'`);
  });

  it('reducer 里消费的事件类型每个都真的会被转发进来（STAGE_EVENTS）', async () => {
    // 2026-08-14 事故的另一半：事件在服务端真实存在，reducer 的案也写对了，
    // 但转发名单里没有它 —— run.start 就这么当了两天死代码，精灵整个思考
    // 阶段装闲。事件要活，得两头都在。名单 2026-08-14 抽进 event-router.js，
    // 这里直接吃真名单（比 grep 源码强：改名/挪家都跟得上）。
    const { STAGE_EVENTS } = await import('./event-router.js');
    const reducerSrc = fs.readFileSync(new URL('./board-presence.js', import.meta.url), 'utf8');
    const consumed = [...reducerSrc.matchAll(/case '((?:run|board)\.[\w.]+)'/g)].map(m => m[1]);
    expect(consumed.length).toBeGreaterThan(0);
    for (const t of consumed) {
      expect(STAGE_EVENTS.has(t), `${t} 不在转发名单`).toBe(true);
    }
  });
});

describe('新文件挂账（2026-08-14 "从 0 产物到有产物追踪不靠谱"的钉子）', () => {
  // 病根：开写就位（delta.tool_input）和落盘（file_changed）都赶在产物清单
  // 收编新文件之前，解析失败直接丢就再没有事件来救。修法 = 挂账 + 清单刷新补射。
  const startEvt = { type: 'run.start' };
  const writeEvt = { type: 'run.delta.tool_input', filePath: '新稿.html' };

  it('解析不到 ≠ 丢弃：路径挂在 pendingFile 上，位置不动', () => {
    let t = reducePresence(emptyPresence(), startEvt, null);
    t = reducePresence(t, writeEvt, () => null);
    expect(t[MAIN_AGENT_ID].pendingFile).toBe('新稿.html');
    expect(t[MAIN_AGENT_ID].targetId).toBe(null);
  });

  it('清单收编后 resolvePending 补射：落位 + 销账', () => {
    let t = reducePresence(emptyPresence(), startEvt, null);
    t = reducePresence(t, writeEvt, () => null);
    t = resolvePending(t, () => ({ objectId: 'deck:新稿.html', zoneId: '' }));
    expect(t[MAIN_AGENT_ID].targetId).toBe('deck:新稿.html');
    expect(t[MAIN_AGENT_ID].pendingFile).toBe(null);
  });

  it('解析仍失败时返回原引用（setState 按引用 bail，effect 频繁跑也无害）', () => {
    let t = reducePresence(emptyPresence(), startEvt, null);
    t = reducePresence(t, writeEvt, () => null);
    expect(resolvePending(t, () => null)).toBe(t);
    expect(resolvePending(t, null)).toBe(t);
  });

  it('后续事件解析成功自己销账；run 收场也把挂账清掉', () => {
    let t = reducePresence(emptyPresence(), startEvt, null);
    t = reducePresence(t, writeEvt, () => null);
    t = reducePresence(t, { type: 'run.file_changed', filePath: '新稿.html' },
      () => ({ objectId: 'deck:新稿.html', zoneId: '' }));
    expect(t[MAIN_AGENT_ID].pendingFile).toBe(null);

    let t2 = reducePresence(emptyPresence(), startEvt, null);
    t2 = reducePresence(t2, writeEvt, () => null);
    t2 = reducePresence(t2, { type: 'run.done' }, null);
    expect(t2[MAIN_AGENT_ID].pendingFile).toBe(null);
    expect(resolvePending(t2, () => ({ objectId: 'x', zoneId: '' }))).toBe(t2);
  });
});

describe('板书追踪（08-24 体检 1a：板上工具不走 Write/Edit，file_changed 对它沉默）', () => {
  it('活跃中 board.focus 带 chalk → 收编为目标；闲时不收', () => {
    let t = reducePresence(emptyPresence(), { type: 'run.start' }, null);
    t = reducePresence(t, { type: 'board.focus', chalk: 'notes/板书/2026-08-24-想法.md', layer: '', rect: { x: 0, y: 0, w: 100, h: 40 } }, null);
    expect(t[MAIN_AGENT_ID].targetId).toBe('notes/板书/2026-08-24-想法.md');

    // 闲时（没有活跃 run）广播来的 board.focus 不动在场表
    const idle = emptyPresence();
    expect(reducePresence(idle, { type: 'board.focus', chalk: 'notes/板书/x.md' }, null)).toBe(idle);
  });

  it('草图的 board.focus 没有 chalk 字段 → 不收编（它有黑板模式的镜头跟随）', () => {
    let t = reducePresence(emptyPresence(), { type: 'run.start' }, null);
    const before = t[MAIN_AGENT_ID].targetId;
    t = reducePresence(t, { type: 'board.focus', tag: 'sketch-1', rect: { x: 0, y: 0, w: 500, h: 300 } }, null);
    expect(t[MAIN_AGENT_ID].targetId).toBe(before);
  });
});
