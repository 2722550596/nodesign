/**
 * server/api/sessions.js — Session CRUD（M1 G1：数据源换 pi session JSONL）
 *
 * GET    /api/projects/:pid/sessions                列项目所有 session（.nd + sessions/ + pi-sessions/ 发现）
 * GET    /api/projects/:pid/sessions/:sid           readPiSessionMessages（SDK SessionMessage 形状）
 * POST   /api/projects/:pid/sessions/:sid/fork      复制最新 pi jsonl 到新 sid 目录
 * PATCH  /api/projects/:pid/sessions/:sid           rename/tag → .nd/<sid>/session-config.json
 * DELETE /api/projects/:pid/sessions/:sid           rm pi 转录目录 + 私档目录
 *
 * M1 换源（doc §5.5）：转录从 SDK ~/.claude/projects/ 搬到 <PROJECTS_DATA_ROOT>/
 * pi-sessions/<sid>/（解析在 engine/pi/pi-jsonl.js）。rewind 无 pi 对应物，暂禁 501
 * （M3 复评，设计决策 3）。
 */

import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { setActiveSession } from '../projects/store.js';
import { guardProject, modelUserFor } from './_guard.js';
import { closeQuerySession, hasActiveQuerySession } from '../engine/runs/active-runs.js';
import {
  getProjectWorkspace,
  getWorkspaceRoot,
  ensureSessionWorkspace,
  forkSessionWorkspace,
  removeSessionWorkspace,
  validateSessionId,
  getSessionMetaDir,
  PROJECTS_DATA_ROOT,
} from '../projects/workspace.js';
import {
  piSessionDir,
  findLatestSessionFile,
  hasPiSession,
  readPiSessionMessages,
  readPiSessionInfo,
  readLastAssistantUsage,
} from '../engine/pi/pi-jsonl.js';
import { getProjectBus } from '../ws/broker.js';
import { getLastContextUsage } from '../engine/runs/live-turn.js';
import { Events } from '../engine/agent/events.js';
import {
  resolveSessionModel, applySessionModel, defaultModel, readSessionConfigFile,
} from '../engine/agent/session-model.js';
import {
  selectableModelsFor, allowedModelsFor, isModelLockedFor, defaultModelFor, modelSwitchRejection,
  resolveModelContextWindow, brandOfModel,
} from '../engine/agent/model-context.js';

/**
 * 进行中的 rewind 操作 sid 集 —— 供 turn.js startNewRunSession 守卫使用。
 * M1：pi 引擎 rewind 已禁（下面 501），此 Set 恒空；export 保留给 turn.js 的 import
 * 兼容（G2 改造 turn.js 前不动它）。
 */
export const pendingRewinds = new Set();

const router = express.Router();


const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 列指定 project 的所有 session（按 lastModified 倒序）。共享给：
 * 1. GET /api/projects/:pid/sessions（这文件下面的路由）
 * 2. GET /api/sessions/recent（recent.js 跨项目聚合）
 *
 * M1 换源：sid 发现保留 .nd/ + sessions/ 双目录扫描（老 SDK 会话的私档 / 旧结构），
 * 再并入 pi-sessions/（新引擎的会话可能还没有 .nd 目录 —— G2 会写 .nd，但防御性
 * 并入）。per-sid info 改 readPiSessionInfo（pi-jsonl.js），title/tag 以
 * .nd/<sid>/session-config.json（PATCH rename/tag 的落点）优先覆盖。
 *
 * @param {string} pid
 * @returns {Promise<object[]>} sessions 数组（每条至少含 sessionId / lastModified；
 *   另带 customTitle / summary / firstPrompt / tag 等前端可消费字段）
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
    // pi 引擎转录：每 sid 一个目录（新会话可能还没有 .nd）
    ...await readSids(path.join(PROJECTS_DATA_ROOT, 'pi-sessions')),
  ])];
  const results = await Promise.all(sids.map(async (sid) => {
    try {
      const info = await readPiSessionInfo(piSessionDir(PROJECTS_DATA_ROOT, sid));
      if (!info) return null;
      // title/tag：Nodesign 自有 meta 优先（PATCH 写这里；pi session_info 的 name 只是兜底）
      const cfg = await readSessionConfigFile(getSessionMetaDir(pid, sid));
      if (typeof cfg.title === 'string' && cfg.title.trim()) info.customTitle = cfg.title.trim();
      if (typeof cfg.tag === 'string' && cfg.tag.trim()) info.tag = cfg.tag.trim();
      return info;
    } catch (err) {
      console.warn(`[sessions list] ${sid.slice(0, 8)} info failed:`, err.message);
      return null;
    }
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
}

// ── List：自实现（多目录 sid 发现 + per-sid readPiSessionInfo）──
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

// ── Read：单 session messages（pi JSONL → SDK SessionMessage 形状）──
router.get('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    // M1 换源：readPiSessionMessages 输出 SDK SessionMessage 形状（C5 映射），
    // 前端 sessionMessagesToDisplay 零改动消费。includeSystem 参数保留 API 兼容，
    // pi 的 system entry 一律跳过（= includeSystemMessages:false 语义）。
    const messages = await readPiSessionMessages(piSessionDir(PROJECTS_DATA_ROOT, req.params.sid));
    res.json({ messages });
  } catch (err) { next(err); }
});

/**
 * ── 上下文用量（按需查询）──
 *
 * run.context_usage 是 turn 内推的，turn 一结束前端就只剩一个空值。可用户想看
 * "现在装了多少、要不要压缩"恰恰是在两轮之间。composer 的 [+] 菜单展开时打这条。
 *
 * M1 近似口径（pi 引擎，SDK query.getContextUsage 权威路径随引擎换掉）：取最新
 * jsonl 里**最后一条 assistant message 的 usage**，input + cacheRead + cacheWrite
 * 当 used —— pi 的 usage.input 是本次请求未命中缓存的增量、cacheRead/cacheWrite
 * 是缓存命中/写入部分，三者之和 ≈ 模型这次实际看到的上下文大小。分母从会话
 * session-config 的 model 查 resolveModelContextWindow 真实窗口（与
 * Events.contextUsage 的分母同源，前端 ContextMeter 形状逐字段对齐）。
 * 近似误差：最后一条消息的 usage 不含其后工具结果的增量，M2 复评。
 * 拿不到 usage → 内存记忆值兜底；再没有 → 零用量（前端进度条低于阈值自动隐藏）。
 */
router.get('/:pid/sessions/:sid/context-usage', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const sid = req.params.sid;
    const usage = await readLastAssistantUsage(piSessionDir(PROJECTS_DATA_ROOT, sid));
    if (usage) {
      const totalTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      const { model: appModel } = await resolveSessionModel(getSessionMetaDir(req.params.pid, sid));
      const realMax = resolveModelContextWindow(appModel) ?? null;
      return res.json({
        type: 'run.context_usage',
        totalTokens,
        maxTokens: realMax,
        sdkMaxTokens: null,             // pi 无 SDK compact 触发线概念
        percentage: realMax > 0 ? Math.round((totalTokens / realMax) * 100) : 0,
        autoCompactThreshold: null,     // M1：pi compaction 阈值暂不可得
        isAutoCompactEnabled: null,
        model: appModel,
        brand: brandOfModel(appModel),
        messageBreakdown: null,
        memoryFilesTokens: 0,
        mcpToolsTokens: 0,
        agentsTokens: 0,
        live: false,                    // 非活 query 现问，是 jsonl 读出的近似值
      });
    }

    const remembered = getLastContextUsage(sid);
    if (remembered) return res.json({ ...remembered, live: false });
    // 完全没跑过（或服务器重启且 jsonl 无 usage）：零用量，形状与上面对齐
    return res.json({
      type: 'run.context_usage',
      totalTokens: 0, maxTokens: null, sdkMaxTokens: null, percentage: 0,
      autoCompactThreshold: null, isAutoCompactEnabled: null,
      model: null, brand: null, messageBreakdown: null,
      memoryFilesTokens: 0, mcpToolsTokens: 0, agentsTokens: 0,
      live: false,
    });
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
    // default 按**项目 owner** 算（08-21；_guard.modelUserFor）：公开注册号的默认不是环境变量里的订阅行；
    // 没覆盖时按钮上显示的就是它。admin 代看 basic 项目时清单也按 owner（订阅行 locked），跟 turn.js 一致
    const modelUser = modelUserFor(req, project);
    const userDefault = defaultModelFor(modelUser) || fallback;
    res.json({ model: override || userDefault, override, default: userDefault, options: selectableModelsFor(modelUser) });
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
    const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）
    if (raw !== null && isModelLockedFor(modelUser, raw)) {
      return res.status(403).json({ error: '这个模型仅限 Pro 档，暂未对外开放', code: 'MODEL_LOCKED', model: raw });
    }
    if (typeof raw === 'string' && !allowedModelsFor(modelUser).some((m) => m.id === raw)) {
      return res.status(400).json({ error: `unknown model: ${raw}`, code: 'UNKNOWN_MODEL' });
    }

    await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const metaDir = getSessionMetaDir(req.params.pid, req.params.sid);
    // ⛔ 这条闸 08-25 之前是**死守卫**（08-21 装的时候就写错了位置）：它写在 applySessionModel 之后，
    // 又拿 apply **之后**读回来的 currentModel 去比 —— 那就是 raw 跟它自己比，crossLaneSwitchReason
    // 的第一行 `fromModel === toModel` 直接返回 null，一次都没拦住过；而且就算能拦，文件已经写了、
    // 空闲的 query 也已经被 applySessionModel 关掉重启了，409 只是句马后炮。
    // 现在：**apply 之前**读、拿 apply 之前的有效模型比。`raw === null`（清覆盖回默认）同样要判 ——
    // 从 Ox 会话清回订阅默认，是同一个病。
    const before = await resolveSessionModel(metaDir);
    const target = raw ?? defaultModel();
    // 只对**跑过的会话**拦：这条闸防的是历史里那些没有 signature 的 thinking 块被回传给真 Anthropic
    // （08-21 fable P3）。还没跑过的会话没有历史，拦它只会让人换不了模型。
    const why = modelSwitchRejection({
      from: before.model, to: target,
      hasHistory: await hasPiSession(piSessionDir(PROJECTS_DATA_ROOT, req.params.sid)),
    });
    if (why) return res.status(409).json({ error: why, code: 'LANE_SWITCH' });
    const result = await applySessionModel(req.params.sid, metaDir, raw, 'picker');
    const { fallback } = await resolveSessionModel(metaDir);
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

// ── Fork：复制最新 pi jsonl 到新 sid 目录 + 备私档 ──
router.post('/:pid/sessions/:sid/fork', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const srcSid = req.params.sid;
    const { upToMessageId, title } = req.body || {};

    // M1 换源：SDK forkSession → 文件复制。pi 按目录发现会话：把源 sid 目录里
    // 最新的 jsonl 复制进新 sid 目录（文件名保持原名 —— 文件名里是 pi 自己的
    // sessionId，pi 不在意目录名）。header/entries 原样带过去，新目录 --continue
    // 即从这份历史继续 = fork 语义。
    if (upToMessageId) {
      // SDK 式"截到指定消息"的 partial fork 无 pi 对应物；显式拒绝，不静默全量复制
      return res.status(400).json({
        error: 'pi fork 暂不支持 upToMessageId 截断（M3 复评）',
        code: 'FORK_TRUNCATE_NOT_SUPPORTED_PI',
      });
    }

    const srcFile = await findLatestSessionFile(piSessionDir(PROJECTS_DATA_ROOT, srcSid));
    if (!srcFile) {
      return res.status(404).json({ error: 'session transcript not found', code: 'JSONL_MISSING' });
    }

    const newSid = randomUUID();
    validateSessionId(newSid);

    // 备好新会话的私档目录（不再复制任何产物 —— 分叉的是对话，不是工作区）
    await forkSessionWorkspace(req.params.pid, srcSid, newSid);

    const destDir = piSessionDir(PROJECTS_DATA_ROOT, newSid);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(srcFile, path.join(destDir, path.basename(srcFile)));

    // 标题落 Nodesign 自有 meta（list 的 title 优先读这里）
    if (typeof title === 'string' && title.trim()) {
      await mergeSessionMeta(req.params.pid, newSid, { title: title.trim() });
    }

    res.json({ sessionId: newSid });
  } catch (err) { next(err); }
});

// ── PATCH：rename / tag（写 Nodesign 自有 meta，不再走 SDK）──
router.patch('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const { title, tag } = req.body || {};
    const patch = {};

    if (typeof title === 'string') {
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      patch.title = title.trim();
    }
    if ('tag' in (req.body || {})) {
      if (tag !== null && typeof tag !== 'string') {
        return res.status(400).json({ error: 'tag must be string or null' });
      }
      if (typeof tag === 'string' && tag.length > 50) {
        return res.status(400).json({ error: 'tag too long (max 50)' });
      }
      patch.tag = (typeof tag === 'string' && tag.trim()) ? tag.trim() : null;  // null = 清掉
    }

    await mergeSessionMeta(req.params.pid, req.params.sid, patch);
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

// ── DELETE：rm pi 转录目录 + 会话私档目录 ──
router.delete('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    // 1. M1 换源：SDK deleteSession → 删 pi 转录目录（每 sid 一个目录）
    try {
      await fs.rm(piSessionDir(PROJECTS_DATA_ROOT, req.params.sid), { recursive: true, force: true });
    } catch (err) {
      // 目录不存在等 silent skip —— 与老逻辑一致，后面 rm 私档兜底
      console.warn(`[delete session] pi session dir rm failed (${err.message}); proceeding to rm meta`);
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
// M1：SDK Query.rewindFiles 的文件 checkpoint 活在 SDK jsonl 里，pi 引擎无对应物，
// 暂禁 —— M3 复评（设计决策 3）。turn.js 里的 run 级 rewind 归 G2，这里不碰。
router.post('/:pid/sessions/:sid/rewind', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;
    return res.status(501).json({
      code: 'REWIND_NOT_SUPPORTED_PI',
      message: 'pi 引擎暂不支持 rewind（M3 复评）',
    });
  } catch (err) { next(err); }
});

/**
 * 会话的 Nodesign 自有 meta 合并写（.nd/<sid>/session-config.json）。
 *
 * M1 rename/tag 不再走 SDK —— 落到 session-loop 存 model 的同一份文件（读侧复用
 * session-model.js 的 readSessionConfigFile；list 的 title/tag 优先读这里）。
 * null 值 = 清字段。read-modify-write 与模型 picker 的 writeSessionModelOverride
 * 之间有窄 race 窗（那把锁是 session-model 模块私有的），M1 接受，M2 复评。
 */
async function mergeSessionMeta(pid, sid, patch) {
  const metaDir = getSessionMetaDir(pid, sid);
  await fs.mkdir(metaDir, { recursive: true });
  const cfg = await readSessionConfigFile(metaDir);
  const next = { ...cfg, ...patch, updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
  }
  await fs.writeFile(path.join(metaDir, 'session-config.json'), JSON.stringify(next, null, 2), 'utf8');
}

export default router;
