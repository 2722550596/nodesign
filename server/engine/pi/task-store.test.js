/**
 * task-store 测试 —— 钉的是「SDK 时代 todo 镜像的存储语义」：id 递增、reset 归零、
 * update 只改传入字段、deleted 走删除、mirror 不带 id（对齐 run.todo.updated payload，
 * board-tasklist.js 按 content/status/activeForm 消费）。这些形状一改，板书和
 * TaskList 工具结果会悄悄错位，所以断言直接打在行对象的键集合上。
 */

import { describe, it, expect } from 'vitest';
import { TASK_STATUSES, createTaskStore } from './task-store.js';

describe('create —— 追加 + id 递增', () => {
  it('顺序追加，id 形如 t1/t2/t3，status 固定 pending', () => {
    const store = createTaskStore();
    expect(store.create('写大纲')).toBe('t1');
    expect(store.create('起稿', '正在起稿')).toBe('t2');
    expect(store.create('润色')).toBe('t3');
    expect(store.size).toBe(3);
    expect(store.list()).toEqual([
      { id: 't1', content: '写大纲', status: 'pending' },
      { id: 't2', content: '起稿', status: 'pending', activeForm: '正在起稿' },
      { id: 't3', content: '润色', status: 'pending' },
    ]);
  });

  it('activeForm 未传时行上不带该键（SDK 形状：可选字段可省略）', () => {
    const store = createTaskStore();
    store.create('写大纲');
    expect(store.list()[0]).not.toHaveProperty('activeForm');
    expect(store.mirror()[0]).not.toHaveProperty('activeForm');
  });

  it('空/非字符串 subject 落「(未命名任务)」', () => {
    const store = createTaskStore();
    expect(store.create('')).toBe('t1');
    expect(store.create(undefined)).toBe('t2');
    expect(store.create(null)).toBe('t3');
    expect(store.create(123)).toBe('t4');
    expect(store.mirror().every((r) => r.content === '(未命名任务)')).toBe(true);
  });
});

describe('mirror —— run.todo.updated payload 形状（不带 id）', () => {
  it('每行只有 content/status(/activeForm)，没有 id 键', () => {
    const store = createTaskStore();
    store.create('写大纲');
    store.create('起稿', '正在起稿');
    const mirror = store.mirror();
    expect(mirror).toEqual([
      { content: '写大纲', status: 'pending' },
      { content: '起稿', status: 'pending', activeForm: '正在起稿' },
    ]);
    for (const row of mirror) expect(row).not.toHaveProperty('id');
  });

  it('mirror 是快照：改返回值不影响 store', () => {
    const store = createTaskStore();
    store.create('写大纲');
    store.mirror()[0].content = '被篡改';
    expect(store.mirror()[0].content).toBe('写大纲');
  });
});

describe('update —— 命中改字段，未命中 false，deleted 删行', () => {
  it('命中：改 status / activeForm / subject（content 跟着变）', () => {
    const store = createTaskStore();
    const id = store.create('写大纲');
    expect(store.update(id, { status: 'in_progress', activeForm: '正在写大纲' })).toBe(true);
    expect(store.list()[0]).toEqual({ id: 't1', content: '写大纲', status: 'in_progress', activeForm: '正在写大纲' });
    expect(store.update(id, { status: 'completed', subject: '大纲定稿' })).toBe(true);
    expect(store.list()[0]).toEqual({ id: 't1', content: '大纲定稿', status: 'completed', activeForm: '正在写大纲' });
  });

  it('未命中返回 false，store 不变', () => {
    const store = createTaskStore();
    store.create('写大纲');
    expect(store.update('t99', { status: 'completed' })).toBe(false);
    expect(store.size).toBe(1);
    expect(store.list()[0].status).toBe('pending');
  });

  it('status === "deleted" 删除该行并返回 true', () => {
    const store = createTaskStore();
    store.create('写大纲');
    const id = store.create('起稿');
    expect(store.update(id, { status: 'deleted' })).toBe(true);
    expect(store.size).toBe(1);
    expect(store.list()).toEqual([{ id: 't1', content: '写大纲', status: 'pending' }]);
    // 删完再 update 就是未命中
    expect(store.update(id, { status: 'completed' })).toBe(false);
  });

  it('undefined 字段不覆盖已有值', () => {
    const store = createTaskStore();
    const id = store.create('写大纲', '正在写大纲');
    store.update(id, { status: 'in_progress' });
    expect(store.update(id, { status: undefined, activeForm: undefined, subject: undefined })).toBe(true);
    expect(store.list()[0]).toEqual({ id: 't1', content: '写大纲', status: 'in_progress', activeForm: '正在写大纲' });
  });

  it('非法 status（不在 TASK_STATUSES 且不是 deleted）忽略该字段，其余字段照改', () => {
    const store = createTaskStore();
    const id = store.create('写大纲');
    expect(store.update(id, { status: 'cancelled', subject: '大纲定稿' })).toBe(true);
    expect(store.list()[0]).toEqual({ id: 't1', content: '大纲定稿', status: 'pending' });
  });
});

describe('id 归一 —— 模型回传 taskId 的三种形态都命中（live probe 实测栽过）', () => {
  it('update 用 "1" / "#1" / "t1" 都能命中 t1', () => {
    const store = createTaskStore();
    store.create('读文件');
    expect(store.update('1', { status: 'completed' })).toBe(true);
    expect(store.list()[0].status).toBe('completed');
    expect(store.update('#1', { status: 'in_progress' })).toBe(true);
    expect(store.list()[0].status).toBe('in_progress');
    expect(store.update('t1', { status: 'completed' })).toBe(true);
    expect(store.list()[0].status).toBe('completed');
  });

  it('remove 同样归一："#2" 删掉 t2', () => {
    const store = createTaskStore();
    store.create('甲');
    store.create('乙');
    expect(store.remove('#2')).toBe(true);
    expect(store.list()).toEqual([{ id: 't1', content: '甲', status: 'pending' }]);
  });

  it('deleted 状态走归一删除："#1" 删行返回 true', () => {
    const store = createTaskStore();
    store.create('甲');
    expect(store.update('#1', { status: 'deleted' })).toBe(true);
    expect(store.size).toBe(0);
  });

  it('归一只认纯数字形态：乱串原样查（miss 就 false）', () => {
    const store = createTaskStore();
    store.create('甲');
    expect(store.update('t99', { status: 'completed' })).toBe(false);
    expect(store.update('abc', { status: 'completed' })).toBe(false);
  });
});

describe('remove / reset', () => {
  it('remove 命中删行返回 true，未命中 false', () => {
    const store = createTaskStore();
    const id = store.create('写大纲');
    expect(store.remove(id)).toBe(true);
    expect(store.remove(id)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('reset 清空 + id 计数归零（per-turn 语义：agent_start 后从 t1 重来）', () => {
    const store = createTaskStore();
    store.create('写大纲');
    store.create('起稿');
    store.reset();
    expect(store.size).toBe(0);
    expect(store.list()).toEqual([]);
    expect(store.mirror()).toEqual([]);
    expect(store.create('新一轮第一步')).toBe('t1');
  });
});

describe('TASK_STATUSES —— 跨切片常量', () => {
  it('恰好 pending / in_progress / completed（board-tasklist 按这三个渲染）', () => {
    expect(TASK_STATUSES).toEqual(['pending', 'in_progress', 'completed']);
  });
});
