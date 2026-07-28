import { describe, it, expect } from 'vitest';
import { workspaceRelOf, versionOfFile, versionOfTask, bumpFileVersion } from './file-versions.js';

/**
 * 刷新粒度（2026-07-28）。固化的是用户真碰上的那三条：
 * 多 deck 任务改一份不能让别的跟着重载；改 style.css 整站要重渲；
 * 认不出的路径不记账（免得白刷）。
 */
describe('workspaceRelOf', () => {
  it('绝对路径剥到 workspace 相对', () => {
    expect(workspaceRelOf('/w/sessions/s1/tasks/我的站/index.html')).toBe('tasks/我的站/index.html');
    expect(workspaceRelOf('/w/sessions/s1/assets/generated/a.png')).toBe('assets/generated/a.png');
  });

  it('相对路径原样', () => {
    expect(workspaceRelOf('tasks/x/canvas.html')).toBe('tasks/x/canvas.html');
  });

  it('旧式 cwd 根产物', () => {
    expect(workspaceRelOf('/w/sessions/s1/canvas.html')).toBe('canvas.html');
  });

  it('认不出就是 null', () => {
    expect(workspaceRelOf('')).toBe(null);
    expect(workspaceRelOf(null)).toBe(null);
  });
});

describe('版本粒度', () => {
  it('多 deck 任务：改一份不动另一份', () => {
    let v = {};
    v = bumpFileVersion(v, 'tasks/T/canvas.html');
    v = bumpFileVersion(v, 'tasks/T/canvas.html');
    expect(versionOfFile(v, 'tasks/T/canvas.html')).toBe(2);
    expect(versionOfFile(v, 'tasks/T/proto-A.html')).toBe(0);   // 没被改，?v= 不变，不重载
  });

  it('站点：改样式表整站版本跟着涨', () => {
    let v = {};
    v = bumpFileVersion(v, 'tasks/S/index.html');
    v = bumpFileVersion(v, 'tasks/S/style.css');
    v = bumpFileVersion(v, 'tasks/S/posts/a.html');
    expect(versionOfTask(v, 'S')).toBe(3);
    expect(versionOfTask(v, '别的任务')).toBe(0);
  });

  it('任务之间互不影响', () => {
    let v = {};
    v = bumpFileVersion(v, 'tasks/A/canvas.html');
    expect(versionOfTask(v, 'A')).toBe(1);
    expect(versionOfTask(v, 'B')).toBe(0);
  });

  it('认不出的路径不记账（引用不变，不触发重渲）', () => {
    const v = { 'tasks/A/canvas.html': 1 };
    expect(bumpFileVersion(v, '')).toBe(v);
    expect(bumpFileVersion(v, null)).toBe(v);
  });

  it('缺省参数不炸', () => {
    expect(versionOfFile(undefined, 'x')).toBe(0);
    expect(versionOfTask(undefined, 'x')).toBe(0);
    expect(versionOfFile({}, undefined)).toBe(0);
  });
});
