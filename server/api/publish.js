/**
 * server/api/publish.js — 站点一键上线的 HTTP 面（2026-08-02）
 *
 *   GET    /:pid/publish/:task   → { published, site? }
 *   POST   /:pid/publish/:task   → 发布/重发布（同步等 deploy 完，前端转圈）
 *   DELETE /:pid/publish/:task   → 下线
 *
 * 核心逻辑（闸门/staging/wrangler/custom domain）在 lib/site-publish.js ——
 * agent 的 MCP 工具 publish_site 和这里共用同一套。权限：HTTP 面按请求者算
 * （guardProject 已保证是 owner 或 admin）。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { getPublished } from '../lib/publish-store.js';
import { publishSite, unpublishSite, validTaskName } from '../lib/site-publish.js';

const router = express.Router();

router.get('/:pid/publish/:task', (req, res) => {
  if (!guardProject(req, res)) return;
  if (!validTaskName(req.params.task)) return res.status(400).json({ error: 'invalid task' });
  const site = getPublished(req.params.pid, req.params.task);
  res.json({ published: !!site, site });
});

router.post('/:pid/publish/:task', async (req, res) => {
  if (!guardProject(req, res)) return;
  try {
    const { site, warning } = await publishSite({
      projectId: req.params.pid, task: req.params.task, user: req.user,
    });
    res.json({ site, warning });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[publish] deploy failed:', err.stderr || err.message);
    res.status(502).json({ error: '发布失败：Cloudflare 部署没成功，稍后再试' });
  }
});

router.delete('/:pid/publish/:task', async (req, res) => {
  if (!guardProject(req, res)) return;
  try {
    const removed = await unpublishSite({ projectId: req.params.pid, task: req.params.task });
    if (!removed) return res.status(404).json({ error: 'not published' });
    res.json({ removed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[publish] delete failed:', err.stderr || err.message);
    res.status(502).json({ error: '下线失败，稍后再试' });
  }
});

export default router;
