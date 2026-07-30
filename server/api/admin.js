/**
 * server/api/admin.js — 内测管理接口（2026-07-30）
 *
 * 全部挂 adminGuard（authGuard 已在外层挂好 req.user）。没有管理页 UI，
 * 你用 curl / server/scripts/invite.mjs 操作。
 *
 *   POST  /api/admin/invites          {maxUses?, expiresInDays?} → 生成邀请码
 *   GET   /api/admin/invites          邀请码列表（含用量）
 *   GET   /api/admin/users            用户列表 + 今日用量
 *   PATCH /api/admin/users/:id        {disabled?, dailyTokenLimit?} 封禁/调限额
 */

import express from 'express';
import { adminGuard } from '../auth/middleware.js';
import { createInvite, listInvites, listUsers, getUserById, updateUser } from '../auth/users-store.js';
import { usedTokensToday, limitFor } from '../lib/quota.js';

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
    usedToday: usedTokensToday(u.id),
    effectiveDailyLimit: limitFor(u),
  }));
  res.json({ users });
});

router.patch('/users/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const patch = {};
  if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
  if ('dailyTokenLimit' in (req.body || {})) {
    const v = req.body.dailyTokenLimit;
    if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
      return res.status(400).json({ error: 'dailyTokenLimit 需为非负数或 null' });
    }
    patch.dailyTokenLimit = v === null ? null : Number(v);
  }
  res.json({ user: updateUser(user.id, patch) });
});

export default router;
