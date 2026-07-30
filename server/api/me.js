/**
 * server/api/me.js — 当前用户自视图（2026-07-30 内测）
 *
 *   GET /api/me/usage → { usedToday, limit, username, role }
 *   limit=null 表示不限（admin）。前端顶栏用量徽标消费。
 */

import express from 'express';
import { checkQuota } from '../lib/quota.js';

const router = express.Router();

router.get('/usage', (req, res) => {
  const { usedToday, limit } = checkQuota(req.user);
  res.json({
    usedToday,
    limit,
    username: req.user.username,
    role: req.user.role,
  });
});

export default router;
