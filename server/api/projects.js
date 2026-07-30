/**
 * server/api/projects.js — Project CRUD
 *
 * GET    /api/projects              列项目（按 updated_at 倒序）
 * POST   /api/projects              { name, skillId?, description? } → 创建 + ensureProjectWorkspace
 * GET    /api/projects/:pid         单项目
 * PATCH  /api/projects/:pid         { name?, skillId?, description? } 部分更新
 * DELETE /api/projects/:pid         删项目 + workspace + 关联 runs
 *
 * description: 可选，<= 2000 字符。仅 NoDesign 后端/前端 UI 用，agent 不感知
 * （agent 看的是项目级 instruction = workspace/.claude/CLAUDE.md）。
 */

import express from 'express';
import {
  listProjects, createProject, updateProject, deleteProject,
  listRunsForProject,
} from '../projects/store.js';
import { guardProject } from './_guard.js';
import { ensureProjectWorkspace, removeProjectWorkspace } from '../projects/workspace.js';
import { removeEntriesForProject } from '../lib/showcase-store.js';
import { disposeProjectBus } from '../ws/broker.js';

const router = express.Router();

/** 列表的归属口径：普通用户只看自己的；admin 看全部 */
const ownerScope = (req) => (req.user?.role === 'admin' ? null : (req.user?.id ?? null));

const KIND_VALUES = new Set(['project', 'quick']);
const KIND_QUERY_VALUES = new Set(['project', 'quick', 'all']);

// GET /api/projects 默认行为（2026-05-07）：不带 ?kind= 时 **只返 kind='project'**，
// 把闪聊（kind='quick'）从主项目列表里挡掉 —— 避免老 client / 任何漏传 kind 的调用
// 把闪聊泄漏到「我的项目」UI。要拿全集显式传 ?kind=all。kind=quick 仍可单独筛。
router.get('/', (req, res, next) => {
  try {
    const raw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (raw && !KIND_QUERY_VALUES.has(raw)) {
      return res.status(400).json({ error: `kind must be project|quick|all (got ${raw})` });
    }
    const effectiveKind = raw === 'all' ? undefined : (raw || 'project');
    res.json({ projects: listProjects({ kind: effectiveKind, owner: ownerScope(req) }) });
  } catch (err) { next(err); }
});

const DESCRIPTION_MAX = 2000;

router.post('/', async (req, res, next) => {
  try {
    const { name, skillId, description, kind, autoNamed } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (description != null && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be string' });
    }
    if (typeof description === 'string' && description.length > DESCRIPTION_MAX) {
      return res.status(400).json({ error: `description too long (max ${DESCRIPTION_MAX})` });
    }
    if (kind != null && !KIND_VALUES.has(kind)) {
      return res.status(400).json({ error: `kind must be project|quick (got ${kind})` });
    }
    const project = createProject({
      name, skillId, description, kind, autoNamed: !!autoNamed,
      ownerId: req.user?.id ?? null,
    });
    await ensureProjectWorkspace(project.id);
    res.status(201).json({ project });
  } catch (err) { next(err); }
});

router.get('/:pid', (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    res.json({ project });
  } catch (err) { next(err); }
});

router.patch('/:pid', (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    const patch = {};
    if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
    if (typeof req.body?.skillId === 'string') patch.skillId = req.body.skillId;
    if ('description' in (req.body || {})) {
      const d = req.body.description;
      if (d != null && typeof d !== 'string') {
        return res.status(400).json({ error: 'description must be string' });
      }
      if (typeof d === 'string' && d.length > DESCRIPTION_MAX) {
        return res.status(400).json({ error: `description too long (max ${DESCRIPTION_MAX})` });
      }
      patch.description = (typeof d === 'string' && d.trim()) ? d.trim() : null;
    }
    if ('kind' in (req.body || {})) {
      if (!KIND_VALUES.has(req.body.kind)) {
        return res.status(400).json({ error: `kind must be project|quick (got ${req.body.kind})` });
      }
      patch.kind = req.body.kind;
    }
    const updated = updateProject(req.params.pid, patch);
    res.json({ project: updated });
  } catch (err) { next(err); }
});

router.delete('/:pid', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;

    // 级联：先清 workspace 文件，再删 DB row（DB row 删了找不到，先文件后 DB 顺序保险）
    try { await removeProjectWorkspace(req.params.pid); } catch (err) {
      console.warn(`[projects] removeWorkspace failed for ${req.params.pid}:`, err.message);
    }
    // 关联 runs：标记为 cancelled? 或直接 delete? MVP 直接 delete 关联 runs 行
    const runs = listRunsForProject(req.params.pid);
    if (runs.length) {
      const { default: db } = await import('../engine/runs/store.js');
      const stmt = db.prepare('DELETE FROM runs WHERE id = ?');
      for (const r of runs) stmt.run(r.id);
    }
    // 橱窗卡片指着这个项目的产物，作品没了卡片留着只会点出 404
    removeEntriesForProject(req.params.pid);
    deleteProject(req.params.pid);
    disposeProjectBus(req.params.pid);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
