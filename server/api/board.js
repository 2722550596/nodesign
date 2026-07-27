/**
 * server/api/board.js — 工作台画布布局持久化（2026-07-27 分区版）
 *
 * GET   /api/projects/:pid/board  → shared/board.json（无则返回默认空布局）
 * PATCH /api/projects/:pid/board  → diff 合并写（前端拖拽/建区只发脏条目；null=删）
 * PUT   /api/projects/:pid/board  → 全量替换（保留给 reset 场景）
 *
 * 读写统一走 server/projects/board-store.js（带 per-project 写锁，
 * 与 agent 侧 pin_to_board 工具共享，互不覆盖）。
 */

import express from 'express';
import { validateProjectId, getProject } from '../projects/store.js';
import { readBoard, replaceBoard, patchBoard } from '../projects/board-store.js';

const router = express.Router();

function guard(req, res) {
  validateProjectId(req.params.pid);
  if (!getProject(req.params.pid)) {
    res.status(404).json({ error: 'project not found' });
    return false;
  }
  return true;
}

router.get('/:pid/board', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    res.json({ board: await readBoard(req.params.pid) });
  } catch (err) { next(err); }
});

router.patch('/:pid/board', express.json({ limit: '600kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const patch = req.body?.patch;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch required' });
    const board = await patchBoard(req.params.pid, patch);
    res.json({ ok: true, board });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.put('/:pid/board', express.json({ limit: '600kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const body = req.body?.board;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'board required' });
    const board = await replaceBoard(req.params.pid, body);
    res.json({ ok: true, board });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

export default router;
