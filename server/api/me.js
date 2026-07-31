/**
 * server/api/me.js — 当前用户自视图（2026-07-30 内测）
 *
 *   GET    /api/me/usage              → { usedToday, limit, username, role }
 *   GET    /api/me/showcase           → 个人作品橱窗（作品 + 它沉淀出来的 skill）
 *   GET    /api/me/showcase/:id/cover → 该作品封面 webp（复用首页那套截图缓存）
 *   DELETE /api/me/showcase/:id       → 移出橱窗（只删卡片，不动作品本体）
 *
 * 橱窗条目目前由 agent 的 crystallize_skill 工具产生；跨用户的"市场"还没开
 * （别人的 SKILL.md 会整段进你的 agent 上下文，得先有审核范围）。
 */

import express from 'express';
import { checkQuota, usedTodayByFamily, usedTokensToday, familyLabel } from '../lib/quota.js';
import { getActiveNotice } from '../lib/notice-store.js';
import { listEntries, getEntry, removeEntry } from '../lib/showcase-store.js';
import { getArtifactCover } from '../lib/cover.js';
import { getSharedDir } from '../projects/workspace.js';
import { getProject } from '../projects/store.js';

const router = express.Router();

/**
 * 今日用量。**单位是美元**（口径见 lib/quota.js 文件头）。
 *
 * 金额对所有人可见（07-31 定案）。先前藏过一版，顾虑是"$1.36 / $15.00"会被读成
 * 账单；但换模型的冷启动提醒必须带一个数才有意义，而同一个东西在一个地方说
 * 美元、另一个地方说百分比，用户没法把两句话对上。统一成钱，顺带让人知道
 * 这些对话背后有真实成本 —— 这本身就是内测该传达的信息。
 */
router.get('/usage', (req, res) => {
  const { usedToday, limit } = checkQuota(req.user);
  const byFamily = usedTodayByFamily(req.user.id);
  // 分模型只报明细不报限额 —— 07-31 起限额是一个总数，模型之间不再分账
  const models = Object.entries(byFamily)
    .filter(([, v]) => v.costUsd > 0 || v.tokens > 0)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([family, v]) => ({
      family,
      label: familyLabel(family),
      costUsd: v.costUsd,
      tokens: v.tokens,
    }));
  res.json({
    unit: 'usd',
    usedToday,
    limit,                                   // admin 是 null（不限额）
    pct: limit ? Math.min(100, (usedToday / limit) * 100) : 0,
    capped: limit !== null,
    tokensToday: usedTokensToday(req.user.id),
    models,
    // 站内公告搭这趟车（2026-07-31）：横幅组件本来就在 60s 轮询这个端点，
    // 单开一个 /notice 就是第二个轮询循环，为一条一天用不到一次的消息不值得。
    notice: getActiveNotice(),
    username: req.user.username,
    role: req.user.role,
  });
});

router.get('/showcase', (req, res) => {
  const entries = listEntries(req.user.id).map((e) => ({
    ...e,
    // 项目可能已经被删：卡片还在，但别给一个点进去 404 的链接
    projectAlive: e.projectId ? !!getProject(e.projectId) : false,
  }));
  res.json({ entries });
});

router.get('/showcase/:id/cover', async (req, res, next) => {
  try {
    const entry = getEntry(req.params.id);
    if (!entry || entry.userId !== req.user.id) return res.status(404).end();
    if (!entry.projectId || !entry.artifactRel) return res.status(204).end();
    if (!getProject(entry.projectId)) return res.status(204).end();
    let result;
    try {
      result = await getArtifactCover(entry.projectId, getSharedDir(entry.projectId), entry.artifactRel);
    } catch (err) {
      console.warn('[showcase cover] render failed:', err.message);
      return res.status(204).end();
    }
    if (!result) return res.status(204).end();
    if (req.headers['if-none-match'] === `"${result.etag}"`) return res.status(304).end();
    res.set('ETag', `"${result.etag}"`);
    res.set('Cache-Control', 'private, max-age=60');
    res.type('image/webp').send(result.buffer);
  } catch (err) { next(err); }
});

router.delete('/showcase/:id', (req, res) => {
  const removed = removeEntry(req.params.id, req.user.id);
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

export default router;
