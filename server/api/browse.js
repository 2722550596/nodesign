/**
 * server/api/browse.js — 「这个项目现在有没有在跑的浏览器」（2026-08-18）
 *
 * 只有一个 GET。为什么需要它：浏览器窗是**会话级瞬态**，开窗完全由一次性的
 * `run.browser_opened` / `run.browser_help` 事件驱动。于是刷新一下页面：
 *   - 窗没了，而且没有任何入口能再把它开出来（`setBrowseWin` 只有那两个事件调）；
 *   - 如果 agent 正举着手等人过验证码，**用户从头到尾看不见它举手**，
 *     两分钟后 agent 超时、告诉用户"这个站过不去"——一次白等。
 *
 * 所以刷新后要能问一句"现在是什么状况"。这是**读一个进程内的瞬态事实**，
 * 不落盘、不进任何快照：浏览器活着就是活着，pm2 重启就没了，答案正确。
 *
 * GET /api/projects/:pid/browse → { live, url, busy, help }
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { browseState } from '../engine/browse/registry.js';
import { pendingHelp } from '../engine/browse/handover.js';

const router = express.Router();

router.get('/:pid/browse', (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const help = pendingHelp(req.params.pid);
    res.json({ ...browseState(req.params.pid), help: help ? help.reason : null });
  } catch (err) { next(err); }
});

export default router;
