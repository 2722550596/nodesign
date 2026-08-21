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
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { guardProject } from './_guard.js';
import { closeQuerySession, hasActiveQuerySession, getQuerySession } from '../engine/runs/active-runs.js';
import {
  getProjectWorkspace,
  getWorkspaceRoot,
  getSessionWorkspace,
  ensureSessionWorkspace,
  forkSessionWorkspace,
  removeSessionWorkspace,
  validateSessionId,
  getSessionMetaDir,
  encodeCwdForSDK,
} from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { patchBoard } from '../projects/board-store.js';
import { platform } from '../runtime/platform.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { getProjectBus } from '../ws/broker.js';
import { getLastContextUsage } from '../engine/runs/live-turn.js';
import { Events } from '../engine/agent/events.js';
import { resolveSessionModel, applySessionModel } from '../engine/agent/session-model.js';
import { selectableModelsFor, allowedModelsFor, isModelLockedFor, defaultModelFor, crossLaneSwitchReason } from '../engine/agent/model-context.js';

/**
 * 进行中的 rewind 操作 sid 集合 —— 供 turn.js startNewRunSession 守卫使用，
 * 防止同 sid 临时 rewind query 跟 normal turn query 同时启动撞 jsonl。
 */
export const pendingRewinds = new Set();

const router = express.Router();

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
  // 会话的落脚点在 2026-08-08 扁平化时搬了家：`<项目>/sessions/<sid>/`（每会话
  // 一个沙盒）→ `<工作区>/.nd/<sid>/`（只剩私档，cwd 是工作区本身）。
  //
  // ⚠️ 这里漏改过一次，后果是**迁移之后会话列表永远为空** —— 界面上历史对话
  // 全部消失（数据没丢，`.nd/` 和转录都在，只是没人去列）。所以两处都读：
  // 迁移过的看 `.nd/`，没迁移的看老的 `sessions/`。
  const workspaceRoot = getWorkspaceRoot(pid);
  const readSids = async (dir) => {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name)).map(e => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  };
  const sids = [...new Set([
    ...await readSids(path.join(workspaceRoot, '.nd')),
    ...await readSids(path.join(getProjectWorkspace(pid), 'sessions')),
  ])];
  const results = await Promise.all(sids.map(async (sid) => {
    // 转录按 **cwd** 编码定位，而 cwd 现在就是工作区（getSessionWorkspace 也返回它）
    const sessionRoot = workspaceRoot;
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
    const project = guardProject(req, res);
    if (!project) return;

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
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

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

/**
 * ── 上下文用量（按需查询）──
 *
 * run.context_usage 是 turn 内推的，turn 一结束前端就只剩一个空值。可用户想看
 * "现在装了多少、要不要压缩"恰恰是在两轮之间。composer 的 [+] 菜单展开时打这条。
 *
 * 两个来源，优先级从高到低：
 *   1. query 还活着 → 直接向 SDK 现问（streamInput 模式下 query 在 turn 之间不死），
 *      这是权威值
 *   2. query 已经没了 → 内存里记着的最后一次事件，标 live:false 让前端说明白
 * 都没有 → 204，前端显示"还没开始对话"。
 */
router.get('/:pid/sessions/:sid/context-usage', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const sid = req.params.sid;
    const qs = getQuerySession(sid);
    if (typeof qs?.query?.getContextUsage === 'function') {
      try {
        const usage = await qs.query.getContextUsage();
        // appModel 决定分母（真实容量 vs SDK 的 compact 触发线），跟 turn 内推的
        // 事件走同一个构造函数，前端拿到的两份数据形状一致。
        // 模型从 session-config 现读 —— 原来这里问的是 querySession.ctx?.appModel，
        // 而那个 ctx 字段从注册起就是 null 且无人填写，那一支永远走不到，分母只能
        // 掉回 SDK 的 compact 触发线，同一个会话两次读数对不上。
        const { model: appModel } = await resolveSessionModel(getSessionMetaDir(req.params.pid, sid));
        if (usage) return res.json({ ...Events.contextUsage(usage, appModel), live: true });
      } catch (err) {
        // SDK 拒答不算错（query 正在收尾等）—— 掉到记忆值上，别把菜单打成红的
        console.warn(`[sessions] getContextUsage failed sid=${sid.slice(0, 8)}: ${err.message}`);
      }
    }

    const remembered = getLastContextUsage(sid);
    if (remembered) return res.json({ ...remembered, live: false });
    return res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * ── 会话模型 ──
 *
 * GET  → { model, override, default, options }
 *        model    = 这个会话实际会跑的（session-config 的覆盖，没有就是全局默认）
 *        override = 用户在这个会话里选过的；null 表示「跟随默认」
 *        options  = 可选清单，来自 model-context.js 那两张映射表旁边 ——
 *                   前端不再自己硬编码 id，写错一个字只会静默降级没人报错
 * PUT  → body { model: string | null }，null = 清掉覆盖回到默认
 *
 * 为什么单独开一条而不复用 PATCH /config：改模型不只是写字段，还得让**已经跑着的
 * query 认账**（空闲时关掉，下条消息以新模型 resume）。这两步分开过一次，结果是
 * 配置说一套、进程跑另一套。
 */
router.get('/:pid/sessions/:sid/model', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;
    const { model, override, fallback } = await resolveSessionModel(
      getSessionMetaDir(req.params.pid, req.params.sid),
    );
    // default 按用户算（08-21）：公开注册号的默认不是环境变量里的订阅行；没覆盖时按钮上显示的就是它
    const userDefault = defaultModelFor(req.user) || fallback;
    res.json({ model: override || userDefault, override, default: userDefault, options: selectableModelsFor(req.user) });
  } catch (err) { next(err); }
});

router.put('/:pid/sessions/:sid/model', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const raw = req.body?.model;
    if (raw !== null && typeof raw !== 'string') {
      return res.status(400).json({ error: 'model must be a string or null' });
    }
    // 只收清单里的 id：随手传个拼错的 model 进去，SDK 会自己 fallback、真实容量
    // 查不到，两处都不报错，事后只能从"怎么变慢了"倒推
    if (raw !== null && isModelLockedFor(req.user, raw)) {
      return res.status(403).json({ error: '这个模型需要邀请码账号（订阅 Claude 额度）', code: 'MODEL_LOCKED', model: raw });
    }
    if (typeof raw === 'string' && !allowedModelsFor(req.user).some((m) => m.id === raw)) {
      return res.status(400).json({ error: `unknown model: ${raw}`, code: 'UNKNOWN_MODEL' });
    }

    await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const metaDir = getSessionMetaDir(req.params.pid, req.params.sid);
    const result = await applySessionModel(req.params.sid, metaDir, raw, 'picker');
    const { fallback, model: currentModel } = await resolveSessionModel(metaDir);
    if (raw !== null) {
      const why = crossLaneSwitchReason(currentModel, raw);
      if (why) return res.status(409).json({ error: why, code: 'LANE_SWITCH' });
    }
    res.json({
      model: result.model,
      override: result.override,
      default: fallback,
      changed: result.changed,
      restarted: result.restarted,
      options: selectableModelsFor(req.user),
    });
  } catch (err) { next(err); }
});

// ── Fork：SDK fork + 复制产物 + mv jsonl 到新 session 子目录 ──
router.post('/:pid/sessions/:sid/fork', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const srcSid = req.params.sid;
    const srcSessionRoot = getSessionWorkspace(req.params.pid, srcSid);
    const { upToMessageId, title } = req.body || {};

    // 1. SDK fork —— 在 GLOBAL_CLAUDE_CONFIG_DIR 下生成新 sid 的 jsonl
    const result = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      forkSession(srcSid, { dir: srcSessionRoot, upToMessageId, title }),
    );
    const newSid = result.sessionId;
    validateSessionId(newSid);

    // 2. 备好新会话的私档目录（不再复制任何产物 —— 分叉的是对话，不是工作区）
    await forkSessionWorkspace(req.params.pid, srcSid, newSid);

    // 3. jsonl 归位。
    //
    // 扁平化之后同一个项目的所有会话共用一个 cwd，encoded 目录因此**完全相同**，
    // SDK fork 出来的 newSid.jsonl 一落地就已经在对的位置了。这一整段搬运
    // （含"换个 encoded 目录再找一遍"的兜底）只对旧数据还有意义：那时每个
    // 会话一个 cwd，fork 出来的 jsonl 落在**源会话**的目录里，不搬就找不到。
    const srcEncoded = encodeCwdForSDK(srcSessionRoot);
    const newSessionRoot = getSessionWorkspace(req.params.pid, newSid);
    const newEncoded = encodeCwdForSDK(newSessionRoot);
    if (srcEncoded !== newEncoded) {
      const srcJsonl = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', srcEncoded, `${newSid}.jsonl`);
      const newJsonlDir = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', newEncoded);
      const newJsonl = path.join(newJsonlDir, `${newSid}.jsonl`);
      await fs.mkdir(newJsonlDir, { recursive: true });
      try {
        await fs.rename(srcJsonl, newJsonl);
      } catch (err) {
        console.warn(`[fork] rename ${srcJsonl} → ${newJsonl} failed (${err.code}); searching alt encoded dir`);
        const altParent = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects');
        const pidPrefix = encodeCwdForSDK(getProjectWorkspace(req.params.pid));
        const altSubs = (await fs.readdir(altParent).catch(() => []))
          .filter(sub => sub.startsWith(pidPrefix));
        for (const sub of altSubs) {
          const candidate = path.join(altParent, sub, `${newSid}.jsonl`);
          try {
            await fs.access(candidate);
            await fs.rename(candidate, newJsonl);
            break;
          } catch { /* continue */ }
        }
      }
    }

    res.json({ sessionId: newSid });
  } catch (err) { next(err); }
});

// ── PATCH：rename / tag ──
router.patch('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

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
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;
    const wasActive = hasActiveQuerySession(req.params.sid);
    if (wasActive) closeQuerySession(req.params.sid, 'user_close');
    res.json({ ok: true, wasActive });
  } catch (err) { next(err); }
});

// ── DELETE：SDK 删 jsonl + rm session 目录（产物 / git） ──
router.delete('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

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

    // 2. 删这条会话的私档（`.nd/<sid>/`）。
    //
    // ⚠️ 这里以前是 `rm -rf sessions/<sid>/`（产物 + git + 软链），后面还跟着
    // 一步"连带删掉绑定的任务文件夹"。**删对话现在绝不能碰产物** —— 产物属于
    // 项目，同一个项目里换条对话继续做是常态。
    await removeSessionWorkspace(req.params.pid, req.params.sid);

    // 3. 清 active_session_id 如果指向被删的。**要广播** —— 指针是会话真相源
    //    （2026-08-13 收敛），别的标签页不知道指针被清就会继续往死会话里发。
    //    为什么这条事件不带 sessionId 字段：见 events.js projectActiveSession 注释。
    if (project.activeSessionId === req.params.sid) {
      try {
        setActiveSession(req.params.pid, null);
        getProjectBus(req.params.pid).publish(Events.projectActiveSession(null));
      } catch { /* ignore */ }
    }

    res.status(204).end();
  } catch (err) { next(err); }
});


// ── POST /:pid/sessions/:sid/rewind ──
// SDK Query.rewindFiles(userMessageId) 控制方法 —— 把 session 内文件回滚到该
// user message 之前的状态（后续 Edit/Write 全撤销）。SDK file checkpoint 写在
// session jsonl（type='file-history-snapshot'），跨进程持久化天然搞定。
//
// 两条路径：
//   1. active query 在跑 → 直接用现有 query.rewindFiles（最快，无 spawn 成本）
//   2. session 已 close（历史 session）→ 起临时 query (resume + drain) → rewindFiles → close
//
// 历史 session 也能 undo —— 之前返 410 是应用层偷懒，SDK 完全支持 resume + rewindFiles。
//
// body: { userMessageId }
// 200 { canRewind, filesChanged?, insertions?, deletions? }
// 404 { code: 'JSONL_MISSING' }   jsonl 不存在（session 删了 / 部分创建）
// 409 { code: 'REWIND_BUSY' }     同 sid 已有 rewind 进行中
// 500 { code: 'REWIND_FAILED' }   临时 query 启动 / rewindFiles 失败
router.post('/:pid/sessions/:sid/rewind', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const { userMessageId } = req.body || {};
    if (!userMessageId || typeof userMessageId !== 'string') {
      return res.status(400).json({ error: 'userMessageId required' });
    }

    const { pid, sid } = req.params;

    // 路径 1：active query 在跑 —— 直接用现有 query
    const rec = getQuerySession(sid);
    if (rec?.query && !rec.abortController.signal.aborted) {
      const result = await rec.query.rewindFiles(userMessageId);
      // 对话层同步回滚（2026-08-08「做完整」）：rewindFiles 只回文件。显示与模型
      // 记忆读的都是这份 jsonl —— 关掉活口 query（下条消息从截断后的 jsonl resume，
      // 记忆才真的回退），等 SDK flush 后把 jsonl 截到该 user 消息之前。
      try { closeQuerySession(sid, 'rewind_truncate'); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 800));
      const removed = await truncateJsonlAtMessage(getSessionWorkspace(pid, sid), sid, userMessageId);
      const payload = { ...result, conversationTruncated: removed != null, removedEntries: removed ?? 0 };
      emitRewindFiles(pid, sid, payload);
      return res.json(payload);
    }

    // race guard：active session 存在但 query handle 未 attach（session 启动中
    // 的窄 race window — registerQuerySession 已 set Map 但 attachSessionQuery
    // 还没赋值 query 字段）→ 拒 409 让用户重试。如果直接 fallthrough 进路径 2
    // 起临时 query，两个 SDK binary 会同时 attach 同一 jsonl 文件 → 错乱不可恢复。
    if (hasActiveQuerySession(sid) && rec && !rec.abortController.signal.aborted) {
      return res.status(409).json({
        error: 'session is starting (query handle not yet attached), retry shortly',
        code: 'SESSION_STARTING',
      });
    }

    // 路径 2：起临时 query resume → rewindFiles → close
    if (pendingRewinds.has(sid)) {
      return res.status(409).json({ error: 'rewind in progress', code: 'REWIND_BUSY' });
    }
    const sessionRoot = getSessionWorkspace(pid, sid);
    if (!await jsonlExistsForSession(sessionRoot, sid)) {
      return res.status(404).json({ error: 'session jsonl not found', code: 'JSONL_MISSING' });
    }

    pendingRewinds.add(sid);
    const inputQueue = new AsyncQueue();
    let tempQuery = null;
    let drain = null;
    try {
      tempQuery = query({
        prompt: inputQueue,
        options: {
          resume: sid,
          enableFileCheckpointing: true,
          cwd: sessionRoot,
          // 关键：跟 runSession 一致传 CLAUDE_CONFIG_DIR，否则 SDK 找不到 jsonl
          env: { ...process.env, CLAUDE_CONFIG_DIR: GLOBAL_CLAUDE_CONFIG_DIR },
          persistSession: true,
          // 不传 hooks / mcpServers / agents / canUseTool —— 临时 query 不跑 turn
        },
      });
      // fire-and-forget consume —— SDK control method 走 bidirectional protocol，
      // stream 不消费会卡死 control RPC。drain 跑在后台，close 后自然结束。
      drain = (async () => {
        try { for await (const _ of tempQuery) { /* discard */ } }
        catch { /* expected on close */ }
      })();
      // 15s timeout（SDK boot + jsonl load + control RPC ~3-5s 正常 → 3× margin）
      const result = await Promise.race([
        tempQuery.rewindFiles(userMessageId),
        new Promise((_, rj) => setTimeout(() => rj(new Error('rewind timeout')), 15000)),
      ]);
      // 对话层回滚：先收干净临时 query（文件句柄/尾部 flush），再截断 jsonl
      try { tempQuery.close(); } catch { /* */ }
      try { inputQueue.close(); } catch { /* */ }
      if (drain) { try { await drain; } catch { /* */ } }
      tempQuery = null; drain = null;
      await new Promise((r) => setTimeout(r, 300));
      const removed = await truncateJsonlAtMessage(sessionRoot, sid, userMessageId);
      const payload = { ...result, conversationTruncated: removed != null, removedEntries: removed ?? 0 };
      emitRewindFiles(pid, sid, payload);
      res.json(payload);
    } catch (err) {
      console.warn(`[sessions.rewind] temp query failed (sid=${sid.slice(0, 8)}): ${err.message}`);
      res.status(500).json({ error: err.message, code: 'REWIND_FAILED' });
    } finally {
      try { tempQuery?.close(); } catch { /* ignore */ }
      try { inputQueue.close(); } catch { /* ignore */ }
      if (drain) { try { await drain; } catch { /* ignore */ } }
      pendingRewinds.delete(sid);
    }
  } catch (err) { next(err); }
});

/**
 * 检查 SDK jsonl 是否存在 —— 历史 session 在 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl。
 * encodeCwdForSDK + GLOBAL_CLAUDE_CONFIG_DIR 都已在文件顶部定义。
 */
/**
 * 对话层回滚（2026-08-08）：把 jsonl 截断到 userMessageId 那条之前（含它与其后全部）。
 * jsonl 是追加式日志，截到 prefix = 它历史上真实存在过的状态，resume 天然自洽；
 * 之后的 file-history-snapshot 属于被撤销的编辑，一并丢弃是正确语义。
 * 原子写（tmp+rename）。找不到该 uuid 返 null（fail-soft：文件回滚仍算成功）。
 */
async function truncateJsonlAtMessage(sessionRoot, sid, userMessageId) {
  const jsonlPath = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', encodeCwdForSDK(sessionRoot), `${sid}.jsonl`);
  try {
    const raw = await fs.readFile(jsonlPath, 'utf8');
    const lines = raw.split('\n');
    let cut = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i] || !lines[i].includes(userMessageId)) continue;
      try { if (JSON.parse(lines[i]).uuid === userMessageId) { cut = i; break; } } catch { /* 非 JSON 行跳过 */ }
    }
    if (cut < 0) {
      console.warn(`[sessions.rewind] uuid ${userMessageId.slice(0, 8)} 不在 jsonl 里，跳过对话截断`);
      return null;
    }
    const kept = lines.slice(0, cut).join('\n');
    const tmp = `${jsonlPath}.tmp-rewind`;
    await fs.writeFile(tmp, kept ? `${kept}\n` : '');
    await fs.rename(tmp, jsonlPath);
    return lines.filter(Boolean).length - lines.slice(0, cut).filter(Boolean).length;
  } catch (err) {
    console.warn(`[sessions.rewind] jsonl 截断失败（不影响文件回滚）：${err.message}`);
    return null;
  }
}

async function jsonlExistsForSession(sessionRoot, sid) {
  const encoded = encodeCwdForSDK(sessionRoot);
  const jsonlPath = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', encoded, `${sid}.jsonl`);
  try {
    await fs.access(jsonlPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * rewindFiles 成功后 emit run.file_changed 事件让前端 iframe 自动 reload。
 * 复用现有 event 类型 —— ProjectWorkspace.jsx 已 case 它（仅 .html 后缀 bump reloadToken），
 * 0 前端事件代码改动。
 */
function emitRewindFiles(pid, sid, result) {
  if (!result?.canRewind || !Array.isArray(result.filesChanged) || !result.filesChanged.length) return;
  const bus = getProjectBus(pid);
  for (const filePath of result.filesChanged) {
    bus.publish({
      type: 'run.file_changed',
      filePath,
      event: 'change',
      sessionId: sid,
      ts: new Date().toISOString(),
    });
  }
}

export default router;
