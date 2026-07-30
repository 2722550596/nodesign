/**
 * server/api/_guard.js — 项目路由统一守卫（2026-07-30 多用户内测）
 *
 * 老范式是每个 handler 开头两行 `validateProjectId` + `getProject`（4 个文件
 * 各有局部 guard()、其余 ~40 处内联）。多用户后归属校验必须只有一个实现，
 * 全部收敛到这里。
 *
 * 语义：项目不存在、或存在但不属于当前用户（admin 例外）→ 一律 404，
 * 不区分两种情况 —— 别让外人靠状态码枚举 pid 空间。
 *
 * req.user 由 auth/middleware.js authGuard 挂（登录墙关闭时是匿名 admin，
 * 单机开发行为不变）。
 */

import { validateProjectId, getProject } from '../projects/store.js';
import { getRun } from '../engine/runs/store.js';

/**
 * @returns {object|null} project；null 时响应已发出，caller 直接 return
 */
export function guardProject(req, res) {
  try {
    validateProjectId(req.params.pid);
  } catch (err) {
    res.status(400).json({ error: err.message || 'invalid projectId' });
    return null;
  }
  const project = getProject(req.params.pid);
  const user = req.user;
  const allowed = project && (user?.role === 'admin' || (user && project.ownerId === user.id));
  if (!allowed) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

/** 归属判断（不发响应）—— WS upgrade 等非 express 场景用 */
export function userOwnsProject(user, project) {
  return !!(project && user && (user.role === 'admin' || project.ownerId === user.id));
}

/**
 * /:pid/runs/:runId/* 路由的第二道锁：runId 必须真属于这个 pid。
 * cancel/rewind/answer 走的是全局内存 Map（key 只有 runId），没有这道校验
 * 就是"拿自己的 pid + 别人的 runId"的跨租户控制通道。
 * guardProject 通过之后调；不通过时已响应 404。
 */
export function guardRunInProject(req, res) {
  const run = getRun(req.params.runId);
  if (!run || run.projectId !== req.params.pid) {
    res.status(404).json({ error: 'run not found' });
    return null;
  }
  return run;
}
