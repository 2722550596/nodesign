/**
 * server/api/admin.js — 内测管理接口（2026-07-30）
 *
 * 全部挂 adminGuard（authGuard 已在外层挂好 req.user）。用户/邀请码还是走
 * curl / server/scripts/invite.mjs；问题库有页面（/admin/issues）。
 *
 *   POST   /api/admin/invites          {maxUses?, expiresInDays?} → 生成邀请码
 *   GET    /api/admin/invites          邀请码列表（含用量）
 *   GET    /api/admin/users            用户列表 + 今日用量
 *   PATCH  /api/admin/users/:id        {disabled?, dailyTokenLimit?} 封禁/调限额
 *   GET    /api/admin/issues           harness 问题库（按次数降序）+ 按工具聚合
 *   PATCH  /api/admin/issues/:id       {status} open|ack|ignored|closed
 *   DELETE /api/admin/issues/:id       删掉一条
 */

import express from 'express';
import { adminGuard } from '../auth/middleware.js';
import { createInvite, listInvites, listUsers, getUserById, updateUser } from '../auth/users-store.js';
import { usedCostToday, usedTokensToday, limitFor } from '../lib/quota.js';
import { listIssues, setIssueStatus, removeIssue, issueStats } from '../lib/issues-store.js';
import { createNotice, listNotices, getActiveNotice, retireNotice, retireAllNotices } from '../lib/notice-store.js';

const router = express.Router();
router.use(adminGuard);

router.post('/invites', (req, res) => {
  const maxUses = Number(req.body?.maxUses) || 1;
  const days = Number(req.body?.expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0
    ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  const invite = createInvite({
    createdBy: req.user.id,
    maxUses: Math.max(1, Math.min(100, maxUses)),
    expiresAt,
  });
  res.status(201).json({ invite });
});

router.get('/invites', (_req, res) => {
  res.json({ invites: listInvites() });
});

router.get('/users', (_req, res) => {
  const users = listUsers().map(u => ({
    ...u,
    costToday: usedCostToday(u.id),           // 美元，闸门真口径
    tokensToday: usedTokensToday(u.id),       // 参考
    effectiveDailyLimitUsd: limitFor(u),
  }));
  res.json({ users });
});

router.patch('/users/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const patch = {};
  if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
  // 07-31 起限额单位是美元。老字段 dailyTokenLimit 仍收（存量数据能改回去），
  // 但它已经不参与闸门判断了 —— 真正生效的是 dailyCostLimitUsd。
  for (const [key, label] of [['dailyCostLimitUsd', '美元'], ['dailyTokenLimit', 'token']]) {
    if (!(key in (req.body || {}))) continue;
    const v = req.body[key];
    if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
      return res.status(400).json({ error: `${key} 需为非负数（${label}）或 null` });
    }
    patch[key] = v === null ? null : Number(v);
  }
  res.json({ user: updateUser(user.id, patch) });
});

// ── 站内公告（2026-07-31）──
// 一次只有一条生效（取最新）。发新的等于覆盖旧的，不用先下架。

router.get('/notices', (_req, res) => {
  res.json({ notices: listNotices(), active: getActiveNotice() });
});

router.post('/notices', (req, res) => {
  try {
    const notice = createNotice({
      body: req.body?.body,
      level: req.body?.level || 'info',
      expiresInHours: req.body?.expiresInHours,
    });
    res.status(201).json({ notice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/notices/:id', (req, res) => {
  if (req.params.id === 'all') return res.json({ retired: retireAllNotices() });
  if (!retireNotice(req.params.id)) return res.status(404).json({ error: 'notice not found' });
  res.status(204).end();
});

// ── harness 问题库（2026-07-30）──
// 两个来源写同一张表：auto = PostToolUseFailure 自动记的工具失败；
// agent = report_friction 主动报的摩擦。默认按次数降序 —— 一眼看到最该修的。

router.get('/issues', (req, res) => {
  const { status, source } = req.query;
  const limit = Math.min(500, Number(req.query.limit) || 200);
  res.json({
    issues: listIssues({
      status: typeof status === 'string' && status !== 'all' ? status : undefined,
      source: typeof source === 'string' && source !== 'all' ? source : undefined,
      limit,
    }),
    stats: issueStats(),
  });
});

router.patch('/issues/:id', (req, res) => {
  try {
    const issue = setIssueStatus(req.params.id, String(req.body?.status || ''));
    if (!issue) return res.status(404).json({ error: 'issue not found' });
    res.json({ issue });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/issues/:id', (req, res) => {
  if (!removeIssue(req.params.id)) return res.status(404).json({ error: 'issue not found' });
  res.status(204).end();
});

export default router;
