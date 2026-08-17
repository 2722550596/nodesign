/**
 * assets/notes.js — 便签（灵感便利贴）的增删改。
 *
 * 2026-08-17 从 assets.js 搬出来。这一族自成一体：只碰 `assets/notes/` 和
 * `notes/` 两个目录，跟 assets.js 其余路由（产物清单、文件服务、文件夹操作）
 * 不共享任何状态。搬它是因为 assets.js 压在行数棘轮上限上 ——
 * 「想给胖文件加功能，先拆出去一块」，这是那条规矩兑现的样子。
 *
 * ⚠️ 依赖走**注入**不走 import：反过来 import assets.js 会绕成环。
 */

import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { safeSegment, parseNoteFrontmatter } from './helpers.js';

/**
 * @param {object} deps
 * @param {import('express').Router} deps.router
 */
export function mountNotesRoutes({ router, guardProject, getSharedDir, ensureProjectWorkspace, sanitizeFilename }) {
  /**
   * POST /:pid/notes — 新建灵感便签（第一个非文件上传类产物 kind）。
   * body: { text, title? } → 写 shared/assets/notes/<ts>-<slug>.md。
   * 便签就是 markdown 文件：agent 可 Read（assets/notes/ 在 cwd 软链下），
   * 加入上下文托盘走和图片相同的 attachment 管道。
   */
  router.post('/:pid/notes', express.json(), async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      if (text.length > 20_000) return res.status(400).json({ error: 'note too long (max 20k chars)' });
      const sessionId = typeof req.body?.sessionId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(req.body.sessionId)
        ? req.body.sessionId : null;
  
      await ensureProjectWorkspace(req.params.pid);
      const notesDir = path.join(getSharedDir(req.params.pid), 'assets', 'notes');
      await fs.mkdir(notesDir, { recursive: true });
  
      // slug：CJK 标题 sanitize 后是一串下划线，折叠+去边；没剩下有效字符就叫 note
      const slug = sanitizeFilename(String(req.body?.title || text.slice(0, 24)))
        .replace(/\.+$/, '').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'note';
      const filename = `${Date.now().toString(36)}-${slug}.md`;
      // session 归属写进 frontmatter —— 前端按它把便签自动摆进对应工作区
      const content = sessionId ? `---\nsession: ${sessionId}\n---\n\n${text}` : text;
      await fs.writeFile(path.join(notesDir, filename), content, 'utf8');
  
      res.status(201).json({
        artifact: {
          kind: 'note', name: filename, path: `assets/notes/${filename}`,
          size: Buffer.byteLength(content), mtime: new Date().toISOString(),
          ext: '.md', isImage: false, text,
          ...(sessionId ? { sessionId } : {}),
        },
      });
    } catch (err) { next(err); }
  });
  
  
  /** DELETE /:pid/notes/:filename — 删便签（仅 notes/ 目录，单层名 + 落点校验） */
  router.delete('/:pid/notes/:filename', async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const filename = req.params.filename;
      if (!safeSegment(filename) || !filename.endsWith('.md')) {
        return res.status(400).json({ error: 'invalid note filename' });
      }
      const notesDir = path.join(getSharedDir(req.params.pid), 'assets', 'notes');
      const filePath = path.resolve(notesDir, filename);
      if (!filePath.startsWith(notesDir + path.sep)) {
        return res.status(400).json({ error: 'invalid note filename' });
      }
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
        throw err;
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });
  
  /**
   * 任务便利贴路由（2026-07-30）—— tasks/<任务>/notes/*.md 的用户侧写入口。
   * agent 侧不走这里（它直接 Write 文件）；这两条给前端"共享头脑风暴"用：
   * 用户在贴纸阅读浮层里改内容 / 删贴。
   *
   * 校验：任务名和文件名都可能是 CJK（决策.md），不能套 assets/notes 那条
   * `[A-Za-z0-9._-]` 正则。改为否定式（禁路径分隔符 / .. / 隐藏文件）+
   * resolve 后必须留在 shared/tasks 下的双保险。
   */
  function safeNoteSegment(s, { md = false } = {}) {
    if (typeof s !== 'string' || !s || s.length > 200) return false;
    if (s.includes('/') || s.includes('\\') || s.includes('..') || s.startsWith('.')) return false;
    if (md && !s.endsWith('.md')) return false;
    return true;
  }
  
  function resolveTaskNote(pid, filename) {
    const base = path.join(getSharedDir(pid), 'notes');
    const file = path.resolve(base, filename);
    if (!file.startsWith(base + path.sep)) return null;
    return file;
  }
  
  /** PUT /:pid/task-notes/:filename — 写/改便利贴（用户侧编辑） */
  router.put('/:pid/task-notes/:filename', express.json(), async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const { filename } = req.params;
      if (!safeNoteSegment(filename, { md: true })) {
        return res.status(400).json({ error: 'invalid filename' });
      }
      const text = String(req.body?.text ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'text required' });
      if (text.length > 20_000) return res.status(400).json({ error: 'note too long (max 20k chars)' });
      const file = resolveTaskNote(req.params.pid, filename);
      if (!file) return res.status(400).json({ error: 'invalid path' });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, 'utf8');
      res.json({ ok: true, path: `notes/${filename}` });
    } catch (err) { next(err); }
  });
  
  /** DELETE /:pid/task-notes/:filename — 删便利贴 */
  router.delete('/:pid/task-notes/:filename', async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const { filename } = req.params;
      if (!safeNoteSegment(filename, { md: true })) {
        return res.status(400).json({ error: 'invalid filename' });
      }
      const file = resolveTaskNote(req.params.pid, filename);
      if (!file) return res.status(400).json({ error: 'invalid path' });
      try {
        await fs.unlink(file);
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
        throw err;
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });}
