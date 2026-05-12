/**
 * server/api/pending-changes.js — 用户直接编辑 + 评论 buffer（C4）
 *
 * 用户在 canvas 上做的"直接改文本"和"写评论"在前端 push 到这里。下次发 chat
 * 消息时，turn.js 在 composeUserMessage 里 prepend 一个 system 提示告诉 agent
 * "有 N 处变更"，agent 主动调 mcp__nodesign__get_pending_changes 拉详情。
 *
 * 路径：
 *   POST   /api/projects/:pid/sessions/:sid/pending-changes  append item
 *   GET    /api/projects/:pid/sessions/:sid/pending-changes  返 { items, count }
 *   DELETE /api/projects/:pid/sessions/:sid/pending-changes  全清（也接 ?ids=）
 *
 * 文件：<sessionRoot>/pending-changes.json
 *   { items: [{ id, kind, anchor, aiContext?, diff?, text?, linkedToEditId?, move?, styleDelta?, reactMount?, ts }] }
 *
 * 2026-05-12 起新增 kind:
 *   - 'pending-move'      用户在 canvas 上拖动元素（前端虚拟改 DOM，agent run 时落源码）
 *                          带 move: { container: anchor, before: anchor|null }
 *   - 'pending-style'     用户拖动 / nudge 改样式（位移、对齐等）
 *                          带 styleDelta: { left?, top?, marginLeft?, ... }
 *                          可选 constraint: { x, y } (Figma 风格 anchor — 决定父 resize 时跟哪边)
 *   - 'pending-duplicate' 用户 alt-drag 复制元素
 *                          带 move: { container, before }
 *   - 'pending-delete'    用户按 Del 删除元素
 *   全部可选带 reactMount: true 表示要改 JSX 源码不是 HTML。
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { mutex } from 'async-mutex-lite';
import { validateProjectId, getProject } from '../projects/store.js';
import { ensureSessionWorkspace, validateSessionId } from '../projects/workspace.js';

const router = express.Router();

const FILE_NAME = 'pending-changes.json';
const MAX_ITEMS = 200;

function guard(req, res) {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
  } catch (err) {
    res.status(400).json({ error: err.message || 'invalid pid/sid' });
    return null;
  }
  const project = getProject(req.params.pid);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

async function readBuf(sessionRoot) {
  const file = path.join(sessionRoot, FILE_NAME);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return { items: parsed.items, file };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { items: [], file };
}

async function writeBuf(file, items) {
  await fs.writeFile(file, JSON.stringify({ items }, null, 2), 'utf8');
}

router.get('/:pid/sessions/:sid/pending-changes', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const { items } = await readBuf(sessionRoot);
    res.json({ items, count: items.length });
  } catch (err) { next(err); }
});

router.post('/:pid/sessions/:sid/pending-changes', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const { kind, anchor } = body;
    const VALID_KINDS = ['edit', 'comment', 'pending-move', 'pending-style', 'pending-duplicate', 'pending-delete'];
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${VALID_KINDS.join(' / ')}` });
    }
    if (!anchor || typeof anchor !== 'object') {
      return res.status(400).json({ error: 'anchor object required' });
    }
    if (kind === 'edit') {
      const { diff } = body;
      if (!diff || typeof diff !== 'object'
          || typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') {
        return res.status(400).json({ error: 'edit kind requires diff: { oldText, newText }' });
      }
    } else if (kind === 'comment') {
      const { text } = body;
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'comment kind requires non-empty text' });
      }
      // linkedToEditId (optional) —— 把评论挂到某条 pending edit 上，作为该次操作的补充指令
      if (body.linkedToEditId !== undefined && typeof body.linkedToEditId !== 'string') {
        return res.status(400).json({ error: 'linkedToEditId must be string if present' });
      }
    } else if (kind === 'pending-move' || kind === 'pending-duplicate') {
      const { move } = body;
      if (!move || typeof move !== 'object' || !move.container || typeof move.container !== 'object') {
        return res.status(400).json({
          error: `${kind} requires move: { container: anchor, before: anchor|null }`,
        });
      }
    } else if (kind === 'pending-style') {
      const { styleDelta } = body;
      if (!styleDelta || typeof styleDelta !== 'object') {
        return res.status(400).json({ error: 'pending-style requires styleDelta object' });
      }
    }
    // pending-delete 只需 anchor

    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);

    // 接受 body.id（前端 newId('cmt') 等）以让前后端 id 统一——agent 调
    // clear_pending_changes 时 event 带 clearedIds，前端 comments state 用同一
    // id filter 出橙色 overlay。无传入则后端 randomUUID 兜底。
    const itemId = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : randomUUID();
    const item = {
      id: itemId,
      kind,
      anchor,
      ...(body.aiContext ? { aiContext: body.aiContext } : {}),
      ...(body.reactMount === true ? { reactMount: true } : {}),
      ...(kind === 'edit' ? { diff: body.diff } : {}),
      ...(kind === 'comment' ? {
        text: body.text,
        ...(body.linkedToEditId ? { linkedToEditId: body.linkedToEditId } : {}),
      } : {}),
      ...((kind === 'pending-move' || kind === 'pending-duplicate') ? { move: body.move } : {}),
      ...(kind === 'pending-style' ? {
        styleDelta: body.styleDelta,
        ...(body.constraint && typeof body.constraint === 'object'
          ? { constraint: body.constraint }  // { x: 'left'|'right'|'center'|'stretch', y: 'top'|'bottom'|'center'|'stretch' }
          : {}),
      } : {}),
      ts: new Date().toISOString(),
    };

    // 串行 read-modify-write 防多点击 race（用户连点 5 次评论 → 5 个 POST 几乎同时
    // 到达，原版 readBuf→push→writeBuf 无锁，后写者覆盖前写者 → 用户感"评论凭空消失"。
    // per-sessionRoot mutex 串行所有 pending-changes 写。
    const trimmedCount = await mutex(`pending:${sessionRoot}`, async () => {
      const { items, file } = await readBuf(sessionRoot);
      items.push(item);
      const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
      await writeBuf(file, trimmed);
      return trimmed.length;
    });

    res.json({ ok: true, item, count: trimmedCount });
  } catch (err) { next(err); }
});

router.delete('/:pid/sessions/:sid/pending-changes', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);

    // 同 POST：mutex 串行避免 DELETE / POST 并发互踩
    const idsParam = req.query?.ids;
    const idsSet = idsParam
      ? new Set(String(idsParam).split(',').map(s => s.trim()).filter(Boolean))
      : null;
    const result = await mutex(`pending:${sessionRoot}`, async () => {
      const { items, file } = await readBuf(sessionRoot);
      const filtered = idsSet ? items.filter(it => !idsSet.has(it.id)) : [];
      await writeBuf(file, filtered);
      return { removed: items.length - filtered.length, count: filtered.length };
    });

    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

export default router;

/**
 * Helper for turn.js / agent loop — 同步检查 buffer 是否非空（不加路由）。
 * @returns {Promise<{ count, summary }>}
 *    summary 形如 "用户在过去时段做了 3 处变更（2 编辑 + 1 评论）"
 */
export async function readPendingSummary(sessionRoot) {
  try {
    const { items } = await readBuf(sessionRoot);
    if (items.length === 0) return { count: 0, summary: '' };
    const edits = items.filter(it => it.kind === 'edit').length;
    const comments = items.filter(it => it.kind === 'comment').length;
    const moves = items.filter(it => it.kind === 'pending-move').length;
    const duplicates = items.filter(it => it.kind === 'pending-duplicate').length;
    const styles = items.filter(it => it.kind === 'pending-style').length;
    const deletes = items.filter(it => it.kind === 'pending-delete').length;
    const parts = [];
    if (edits > 0) parts.push(`${edits} 编辑`);
    if (comments > 0) parts.push(`${comments} 评论`);
    if (moves > 0) parts.push(`${moves} 拖动`);
    if (duplicates > 0) parts.push(`${duplicates} 复制`);
    if (styles > 0) parts.push(`${styles} 样式`);
    if (deletes > 0) parts.push(`${deletes} 删除`);
    return {
      count: items.length,
      summary: `用户在过去时段做了 ${items.length} 处变更（${parts.join(' + ')}）`,
    };
  } catch {
    return { count: 0, summary: '' };
  }
}
