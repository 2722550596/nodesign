/**
 * server/api/sessions.js — Session CRUD（H3：session-scoped workspace）
 *
 * GET    /api/projects/:pid/sessions                列项目所有 session（自实现）
 * GET    /api/projects/:pid/sessions/:sid           SDK getSessionMessages
 * POST   /api/projects/:pid/sessions/:sid/fork      SDK forkSession + 复制产物
 * PATCH  /api/projects/:pid/sessions/:sid           SDK rename + tag
 * DELETE /api/projects/:pid/sessions/:sid           SDK deleteSession + 删 session 目录
 *
 * H3 改造：每个 session 独立工作目录 sessions/<sid>/，CLAUDE_CONFIG_DIR
 * per-session（sessions/<sid>/.claude/）。SDK listSessions 按 cwd encoded path
 * 索引 jsonl，跨 session 列要自己 readdir sessions/ 后 per-sid getSessionInfo。
 */

import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import {
  getSessionInfo,
  getSessionMessages,
  forkSession,
  renameSession,
  tagSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { closeQuerySession, hasActiveQuerySession, getQuerySession } from '../engine/runs/active-runs.js';
import {
  getProjectWorkspace,
  getSessionWorkspace,
  ensureSessionWorkspace,
  forkSessionWorkspace,
  removeSessionWorkspace,
  validateSessionId,
} from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { platform } from '../runtime/platform.js';

const router = express.Router();

// SDK 内部把 cwd 编码成 ~/.claude/projects/<encoded>/ 子目录路径，
// 算法（grep 自 sdk.mjs）：所有非字母数字字符转 '-'。
function encodeCwdForSDK(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// SDK session API 需要 CLAUDE_CONFIG_DIR 指向 JSONL 实际存储的全局目录
// 来自 runtime/platform.js（跨平台决策单一来源）
const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 列指定 project 的所有 session（按 lastModified 倒序）。共享给：
 * 1. GET /api/projects/:pid/sessions（这文件下面的路由）
 * 2. GET /api/sessions/recent（recent.js 跨项目聚合）
 *
 * 后端实现：readdir sessions/ → 对每个 sid 调 SDK getSessionInfo
 * （per-session CLAUDE_CONFIG_DIR）→ filter null → sort by lastModified。
 *
 * @param {string} pid
 * @returns {Promise<object[]>} sessions 数组（每条至少含 sessionId / lastModified；
 *   SDK 还会补 customTitle / summary / firstPrompt / tag 等字段）
 */
export async function listSessionsForProject(pid) {
  const sessionsRoot = path.join(getProjectWorkspace(pid), 'sessions');
  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const sids = entries
    .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name))
    .map(e => e.name);
  const results = await Promise.all(sids.map(async (sid) => {
    const sessionRoot = path.join(sessionsRoot, sid);
    try {
      const info = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        getSessionInfo(sid, { dir: sessionRoot }),
      );
      return info || null;
    } catch (err) {
      console.warn(`[sessions list] ${sid.slice(0, 8)} info failed:`, err.message);
      return null;
    }
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
}

// ── List：自实现（readdir sessions/ + per-sid getSessionInfo）──
router.get('/:pid/sessions', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const all = await listSessionsForProject(req.params.pid);

    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : all.length;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const sessions = all.slice(offset, offset + limit);

    res.json({ sessions });
  } catch (err) { next(err); }
});

// ── Read：单 session messages ──
router.get('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);

    const includeSystemMessages = req.query.includeSystem === '1';

    const messages = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      getSessionMessages(req.params.sid, {
        dir: sessionRoot,
        includeSystemMessages,
      }),
    );
    res.json({ messages });
  } catch (err) { next(err); }
});

// ── Fork：SDK fork + 复制产物 + mv jsonl 到新 session 子目录 ──
router.post('/:pid/sessions/:sid/fork', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const srcSid = req.params.sid;
    const srcSessionRoot = getSessionWorkspace(req.params.pid, srcSid);
    const { upToMessageId, title } = req.body || {};

    // 1. SDK fork —— 在 GLOBAL_CLAUDE_CONFIG_DIR 下生成新 sid 的 jsonl
    const result = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      forkSession(srcSid, { dir: srcSessionRoot, upToMessageId, title }),
    );
    const newSid = result.sessionId;
    validateSessionId(newSid);

    // 2. cp -r src 产物（canvas/spec/.git）→ sessions/<newSid>/
    await forkSessionWorkspace(req.params.pid, srcSid, newSid);

    // 3. mv 新 jsonl：SDK fork 在 srcSessionRoot 的 encoded-cwd 下生成 newSid.jsonl，
    //    需要移到 newSessionRoot 的 encoded-cwd 下（让 resume/list 按新 cwd 找到）
    const srcEncoded = encodeCwdForSDK(srcSessionRoot);
    const srcJsonl = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', srcEncoded, `${newSid}.jsonl`);

    const newSessionRoot = getSessionWorkspace(req.params.pid, newSid);
    const newEncoded = encodeCwdForSDK(newSessionRoot);
    const newJsonlDir = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', newEncoded);
    const newJsonl = path.join(newJsonlDir, `${newSid}.jsonl`);

    await fs.mkdir(newJsonlDir, { recursive: true });
    try {
      await fs.rename(srcJsonl, newJsonl);
    } catch (err) {
      console.warn(`[fork] rename ${srcJsonl} → ${newJsonl} failed (${err.code}); searching alt encoded dir`);
      const altParent = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects');
      const altSubs = await fs.readdir(altParent).catch(() => []);
      for (const sub of altSubs) {
        const candidate = path.join(altParent, sub, `${newSid}.jsonl`);
        try {
          await fs.access(candidate);
          await fs.rename(candidate, newJsonl);
          break;
        } catch { /* continue */ }
      }
    }

    res.json({ sessionId: newSid });
  } catch (err) { next(err); }
});

// ── PATCH：rename / tag ──
router.patch('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const { title, tag } = req.body || {};

    if (typeof title === 'string') {
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        renameSession(req.params.sid, title, { dir: sessionRoot }),
      );
    }
    if ('tag' in (req.body || {})) {
      if (tag !== null && typeof tag !== 'string') {
        return res.status(400).json({ error: 'tag must be string or null' });
      }
      if (typeof tag === 'string' && tag.length > 50) {
        return res.status(400).json({ error: 'tag too long (max 50)' });
      }
      await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        tagSession(req.params.sid, tag, { dir: sessionRoot }),
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Close：终结活跃 query session（streamInput 模式）──
//   POST /api/projects/:pid/sessions/:sid/close
//   关掉 inputQueue → runSession for-await-of 自然退出 → query 进程死。
//   下次 turn 该 sid 起新 runSession（resume 旧 jsonl）。
//   200 { ok: true, wasActive }
router.post('/:pid/sessions/:sid/close', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const wasActive = hasActiveQuerySession(req.params.sid);
    if (wasActive) closeQuerySession(req.params.sid, 'user_close');
    res.json({ ok: true, wasActive });
  } catch (err) { next(err); }
});

// ── DELETE：SDK 删 jsonl + rm session 目录（产物 / git） ──
router.delete('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);

    // 1. SDK delete jsonl（从全局 CLAUDE_CONFIG_DIR 删除）
    try {
      await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        deleteSession(req.params.sid, { dir: sessionRoot }),
      );
    } catch (err) {
      // 如果 jsonl 已经不存在或 SDK 找不到，silent skip — 后面 rm 整个目录兜底
      console.warn(`[delete session] SDK delete failed (${err.message}); proceeding to rm dir`);
    }

    // 2. rm 整个 sessions/<sid>/ 目录（产物 + git + 软链）
    await removeSessionWorkspace(req.params.pid, req.params.sid);

    // 3. 清 active_session_id 如果指向被删的
    if (project.activeSessionId === req.params.sid) {
      try { setActiveSession(req.params.pid, null); } catch { /* ignore */ }
    }

    res.status(204).end();
  } catch (err) { next(err); }
});

// ── POST /:pid/sessions/:sid/rewind ──
// SDK enableFileCheckpointing=true 给我们 Query.rewindFiles(userMessageId) 控制方法。
// 调它会把 session 内文件状态回滚到 userMessageId 那条 user message 之前的样子
// （所有后续 Edit/Write 撤销）。仅在 streamInput query 还活着时可用——session 已 close
// 没法 control，返 410 让前端置灰按钮。
//
// body: { userMessageId }
// 200 { canRewind, filesChanged?, insertions?, deletions? }
// 410 { error: 'session not active' } - query 已关，无法回滚
router.post('/:pid/sessions/:sid/rewind', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { userMessageId } = req.body || {};
    if (!userMessageId || typeof userMessageId !== 'string') {
      return res.status(400).json({ error: 'userMessageId required' });
    }

    const rec = getQuerySession(req.params.sid);
    if (!rec || !rec.query || rec.abortController.signal.aborted) {
      // query 不在了——session 已 close 或从没起过 streamInput query
      return res.status(410).json({ error: 'session not active', code: 'SESSION_CLOSED' });
    }

    const result = await rec.query.rewindFiles(userMessageId);
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
