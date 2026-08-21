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
import { getUserById } from '../auth/users-store.js';

/**
 * 模型资格按谁算：**项目 owner**（08-21 晚）。非 admin 只能进自己的项目（guardProject），
 * 所以对他们 owner 就是自己；差别只在 admin 代看别人的项目 —— 那时选模型/默认模型/锁行
 * 都得按 owner 的档位（auth/tier.js），否则 admin 选了订阅 Claude 行、session-loop 按 owner
 * 断言 OAuth 资格时再打回 INIT_FAILED。owner 查不到时退回请求者（不放大权限：admin 本就全开）。
 */
export function modelUserFor(req, project) {
  const ownerId = project?.ownerId;
  if (!ownerId || ownerId === req.user?.id) return req.user;
  return getUserById(ownerId) || req.user;
}

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
  if (!project || !user) return false;
  if (user.role === 'admin') return true;
  // ⚠️ `project.ownerId === user.id` 在**两边都 undefined** 时是 true。今天不可达
  // （每行都有 owner，bootstrapAuth 每次启动回填 NULL），但离"通配放行"只差一个
  // 缺列或一个改了形状的调用方。归属判断上宁可写死。
  return typeof user.id === 'string' && user.id !== ''
    && typeof project.ownerId === 'string' && project.ownerId === user.id;
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
