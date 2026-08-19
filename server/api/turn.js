/**
 * server/api/turn.js — 唯一 LLM 入口（agentic 设计的核心）
 *
 * POST /api/projects/:pid/turn
 *   body: {
 *     chat:        string,           // 用户文本
 *     attachments: [{ path, ... }],  // 附件托盘里的内容（asset / anchor / comment）
 *     skillId?:    string,           // 默认走 project.skillId
 *   }
 *   return 202 { runId, sessionId }
 *
 * 行为（streamInput 重构后）：
 *   1. 校验 project + 解析 input
 *   2. composeUserMessage：拼成 SDK content blocks（多模态 / system 提示注入）
 *   3. createRun（pending） — per-turn record，前端按 runId 跟踪
 *   4. 立即返回 runId + sessionId（agent 异步在后端跑）
 *   5. 看 hasActiveQuerySession(sid)：
 *      - 已有 → pushUserMessage 进 inputQueue，runSession 拉走处理（追加 / 续 chat）
 *      - 没有 → startNewRunSession 起新 long-running query handle，预 push 首条 message
 *   6. setActiveSession：写 project.activeSessionId 让下次不带 sid 的 turn fallback
 *
 * 续 turn 不依赖 jsonl resume —— streamInput 模式 query 横跨整个 session，
 * conversation state 在 SDK binary 内存里。
 *
 * 错误：
 *   - runSession throw → 已通过 EventBus 推 run.error；console 留痕
 *   - HTTP 已经 202 返回，不再回 5xx
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { guardProject, guardRunInProject } from './_guard.js';
import {
  ensureProjectWorkspace,
  ensureSessionWorkspace,
  validateSessionId,
  getSessionMetaDir,
} from '../projects/workspace.js';
import { readAssetsSummary } from '../projects/assets-summary.js';
import { createRun } from '../engine/runs/store.js';
import { runSession } from '../engine/agent/session-loop.js';
import {
  cancelRun, provideAnswer, getQuery, provideElicitation,
  hasActiveQuerySession, pushUserMessage, getQuerySession, closeQuerySession,
  getQueueDepth, setSessionPermissionMode, getSessionIdByRunId,
  providePlanRequestDecision,
  providePlanApprovalDecision,
} from '../engine/runs/active-runs.js';
import { applySessionModel } from '../engine/agent/session-model.js';
import { selectableModelsFor } from '../engine/agent/model-context.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { checkQuota, checkConcurrency, fmtUsd } from '../lib/quota.js';
import { shouldModerate, moderateText, recordViolation, levelFor } from '../lib/moderation.js';
import { getProjectBus } from '../ws/broker.js';
import { Events } from '../engine/agent/events.js';
import { readPendingSummary } from './pending-changes.js';
import { pendingRewinds } from './sessions.js';
import { platform } from '../runtime/platform.js';
import { composeUserMessage } from './turn-compose.js';

const router = express.Router();

/**
 * Phase A.6（2026-05-07）：requestId LRU dedup —— 弱网下用户重发 / fetch retry
 * 同 requestId 直接返已存在的 { runId, sessionId }，不重复 createRun / startNewRunSession。
 *
 * 数据：Map<requestId, { pid, runId, sessionId, ts }>，简单 5 分钟 TTL + 1024 容量上限
 * （超过先驱逐最旧）。同进程内存，重启清空（此时活 run 也都死了，一致）。
 *
 * race 修复（2026-05-08）：原版 lruGet → createRun → lruPut 之间无并发保护。两个
 * 并发 POST 同 requestId 都通过 lruGet 返 null → 各自 createRun → 双 run 同 sid
 * 推进同 inputQueue → agent 收两条同 chat 处理两轮（双倍 token / canvas 双写）。
 *
 * 加 inflightTurns Map<requestId, Promise<result>>：第一 POST 进来注册 in-flight
 * Promise；第二 POST 看到 in-flight 就 await 拿第一个的 result 返 deduped。
 * 第一个 POST 拿到 res 写完 lruPut + resolveInflight，5s 后 delete in-flight（让
 * LRU 接管后续幂等查询）。
 */
const REQUEST_LRU_TTL_MS = 5 * 60 * 1000;
const REQUEST_LRU_MAX = 1024;
const requestLru = new Map();
const inflightTurns = new Map();  // requestId → Promise<{ pid, runId, sessionId }>
const INFLIGHT_RETENTION_MS = 5_000;
function lruGet(requestId) {
  const rec = requestLru.get(requestId);
  if (!rec) return null;
  if (Date.now() - rec.ts > REQUEST_LRU_TTL_MS) {
    requestLru.delete(requestId);
    return null;
  }
  return rec;
}
function lruPut(requestId, rec) {
  if (requestLru.size >= REQUEST_LRU_MAX) {
    // 驱逐最早（Map 保留插入顺序）
    const firstKey = requestLru.keys().next().value;
    if (firstKey) requestLru.delete(firstKey);
  }
  requestLru.set(requestId, { ...rec, ts: Date.now() });
}

/**
 * Emit run.permission_mode_changed —— 广播 SDK 实际 permissionMode 的变化。所有
 * mode 切换路径（plan-approve / plan-reject / turn 入口 mode 校正）调完
 * setPermissionMode 后都该 emit 一次。
 *
 * 前端 2026-07-30 起不再镜像这个事件（「深度对齐」toggle 已删，plan mode 期间的
 * 状态显示由 PlanRequestBanner / PlanReviewCard 承担）。事件保留给多 tab 观测和
 * 排障用 —— mode 是 SDK 真相的一部分，不该只活在服务端日志里。
 *
 * @param {string} pid
 * @param {string} sid
 * @param {string} mode  - 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
 */
function emitPermissionModeChanged(pid, sid, mode) {
  if (!pid || !sid || !mode) return;
  try {
    getProjectBus(pid).publish({
      type: 'run.permission_mode_changed',
      sessionId: sid,
      mode,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[turn] emitPermissionModeChanged failed: ${err.message}`);
  }
}

router.post('/:pid/turn', async (req, res, next) => {
  // ⚠️ 必须在 try **外面**：catch 是 try 的**兄弟**作用域。写在里面的话 catch 那句
  // `typeof inflightReject === 'function'` 够不到它，而 typeof 对未声明的名字不抛错
  // 只返 'undefined' —— 那条 race 修复就此一声不响地失效（08-17 被 no-undef.lint 扫出）。
  let inflightResolve = null;
  let inflightReject = null;
  try {
    const project = guardProject(req, res);
    if (!project) return;

    const { chat, attachments, skillId, sessionId, permissionMode, requestId, raw } = req.body || {};
    // 只发附件不打字也是一条完整消息（2026-08-17，issue #1 第 8 条）：拖张参考图
    // 进来就该能发，逼用户补一句"看看这个"是白要的动作。
    // 空文字 **且** 空附件才是空消息 —— 那个仍然拦。
    const chatText = typeof chat === 'string' ? chat : '';
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!chatText.trim() && !hasAttachments) {
      return res.status(400).json({ error: 'chat string required' });
    }

    // Phase A.6：requestId 命中 LRU → 直接返已存在的 run/session（弱网重发幂等）
    // race 修复：① LRU 命中（已完成请求）→ 立即返；② in-flight 命中（正在跑）→
    // await 第一 POST 的 result 后返 deduped；③ 都 miss → 注册 in-flight Promise
    // 后继续走 createRun 路径，结尾 resolve / reject 通知后续等待者。
    if (typeof requestId === 'string' && requestId) {
      const cached = lruGet(requestId);
      if (cached && cached.pid === project.id) {
        return res.status(202).json({ runId: cached.runId, sessionId: cached.sessionId, deduped: true });
      }
      const inflight = inflightTurns.get(requestId);
      if (inflight) {
        try {
          const r = await inflight;
          if (r && r.pid === project.id) {
            return res.status(202).json({ runId: r.runId, sessionId: r.sessionId, deduped: true });
          }
        } catch { /* first POST failed → fall through 让本 POST 重新跑 */ }
      }
      // 注册 in-flight Promise，后到的同 requestId POST 会 await 这个
      const p = new Promise((rs, rj) => { inflightResolve = rs; inflightReject = rj; });
      inflightTurns.set(requestId, p);
      // 防 promise unhandled rejection 警告：失败时也 attach catch
      p.catch(() => {});
    }
    // Phase 3.2：前端 plan-mode toggle 传 permissionMode='plan' 启用 SDK 原生 plan mode；
    // 其他值（含不传）显式走 bypassPermissions（自动化 design agent 默认 — 见 SDK
    // PermissionMode 定义；不要传 null，行为未定义）。
    const initialPermissionMode = permissionMode === 'plan' ? 'plan' : platform.permissionModeDefault;

    const finalSkillId = (typeof skillId === 'string' && skillId) || project.skillId;

    // C4：先确定 sessionRoot，给 composeUserMessage 看 pending-changes buffer
    // （sid 解析逻辑下面已写）—— 提早 ensure 一次让 buffer 检查能命中真路径。

    // session id 解析逻辑（streamInput 模式）：
    //   - body.sessionId === string → 用该 sid（已有活 query 就 push，没有就起新 runSession）
    //   - body.sessionId === null → 新建 session（前端"+新会话"显式触发）
    //   - body.sessionId 不传 → fallback project.activeSessionId（向后兼容）
    //
    // 新建场景用 randomUUID 预生成 sid，传给 SDK options.sessionId 让 SDK 用
    // 我们的 sid（d.ts:1537 sessionId 单独可传）。cwd 提前切到 sessions/<sid>/，
    // agent 一启动就在 session 沙盒里跑。
    //
    // 变量名仍叫 resumeSessionId 是历史遗留——streamInput 模式不真"resume jsonl"，
    // 它只是"当前要用的 sid"。未 rename 是因为有大量 callsite 兼容成本。
    let resumeSessionId;
    if ('sessionId' in (req.body || {})) {
      resumeSessionId = sessionId || null;
    } else {
      resumeSessionId = project.activeSessionId;
    }
    const isNewSession = !resumeSessionId;
    const sid = isNewSession ? randomUUID() : resumeSessionId;
    validateSessionId(sid);

    // 守卫：临时 rewind query 在跑时拒绝同 sid 新 turn —— 防止两个 SDK subprocess
    // 同时写同一 jsonl。临时 query ~3-5s，用户重试一次就 OK。
    if (pendingRewinds.has(sid)) {
      return res.status(409).json({ error: 'rewind in progress, retry shortly', code: 'REWIND_BUSY' });
    }

    // ── 内测闸门（2026-07-30）：必须在 202 之前同步判 ──
    // 日配额：所有 turn 都扣（排队的稍后也烧钱）。口径是金额不是 token，
    // 原因见 lib/quota.js 文件头 —— 简言之 token 数对缓存命中与否几乎无差别，
    // 金额能差十倍，拿 token 当闸门等于没量到主项。
    //
    // 07-31 起只剩这一道：分模型限额撤了，因为金额天然让 opus 烧得更快，
    // 不需要第二个数字表达同一个意图。
    const quota = checkQuota(req.user);
    if (!quota.ok) {
      return res.status(429).json({
        // 试用号（终身口径）没有"明天刷新"可许诺，文案不能骗人
        error: quota.kind === 'lifetime'
          ? `试用额度已用完（${fmtUsd(quota.used)} / ${fmtUsd(quota.limit)}），感谢体验！想继续用可以联系站主`
          : `今日额度已用完（${fmtUsd(quota.usedToday)} / ${fmtUsd(quota.limit)}），明天零点刷新`,
        code: 'QUOTA_EXCEEDED',
        kind: quota.kind,
        used: quota.used,
        usedToday: quota.usedToday,
        limit: quota.limit,
      });
    }
    // 并发：只拦"会立刻开跑"的 turn；session 正忙时这条消息进排队（既有串行语义，
    // 不产生新并发）
    if (!getQuerySession(sid)?.currentRunId) {
      const gate = checkConcurrency(req.user);
      if (!gate.ok) {
        return res.status(429).json({ error: gate.message, code: gate.code });
      }
    }

    // ── 内容外审（2026-08-02）：消息先过分类器再进 agent。拦下 = 零成本，run 都不建。
    // 强度按账号（users.moderation_level，站主在控制台调），判定 / 留证 / 连坐封禁的
    // 口径全在 lib/moderation.js。
    // 没有文字就没有可审的东西（附件本来就不审，见 lib/moderation.js）——
    // 拿空串去问分类器只是白花一次调用和 1 秒。
    if (shouldModerate(req.user) && chatText.trim()) {
      const verdict = await moderateText(chatText, levelFor(req.user));
      if (!verdict.ok) {
        const rec = recordViolation({
          userId: req.user.id, projectId: project.id,
          category: verdict.category, severity: verdict.severity,
          reason: verdict.reason, excerpt: chatText, level: verdict.level,
        });
        // 上面两道闸的 429 是同步返回，弱网重发撞 in-flight 的窗口可以忽略；
        // 这里 await 了 ~1s，窗口是真的 —— reject 让正在 await 的同 requestId
        // POST fallthrough 自己重跑（然后再被拦一次），不能让它挂死。
        if (typeof requestId === 'string' && requestId) {
          try { if (typeof inflightReject === 'function') inflightReject(new Error('moderation blocked')); } catch { /* */ }
          inflightTurns.delete(requestId);
        }
        return res.status(451).json({
          error: rec?.disabled
            ? '消息涉及违规内容，账号已停用。如有疑问请联系站主'
            : '这条消息涉及违规内容，没有发给 agent。请调整后重发',
          code: 'MODERATION_BLOCKED',
        });
      }
    }

    // 取 sessionRoot + 两类 workspace 主动提示：
    //   - pendingSummary（C4）：用户在 chat 间隔做的直接编辑/评论 buffer
    //   - assetsSummary（C8）：./assets/ 里的参考素材（图/文档），新 session 必报，
    //     续 session 仅当 buffer/旧素材的存在仍可能影响判断时报（这里简化为"非空就报"）
    await ensureProjectWorkspace(project.id);
    const sessionRoot = await ensureSessionWorkspace(project.id, sid);

    // 模型选择（可选 body.model）：只用于**新建会话**时把首选模型带进来
    // （首页 / Hub 那条路，会话还不存在，前端只有 localStorage 偏好）。
    //
    // 会话建起来之后模型的真相在 session-config.json，改它走 PUT /sessions/:sid/model。
    // 这里之所以不再无脑接受 body.model：前端每条消息都带偏好的话，在另一台机器上
    // 为这个会话选的模型会被本机的旧偏好悄悄改回去 —— 一次发消息顺带改配置，
    // 用户完全看不见。
    const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim()
      ? req.body.model.trim() : null;
    if (requestedModel) {
      // 与 PUT /sessions/:sid/model 同一道闸（2026-08-19 评审抓的洞）：这条路
      // 以前不校验，等于绕过 picker 白名单的后门 —— model-ingress 上线后表里
      // 有带真钥匙的 API 模型（gemini），裸 POST 就能替会话选中它烧上游的钱。
      // 未来给 admin/获批用户开 API 模型时，闸门在这两处一起放，别只放一处。
      if (!selectableModelsFor(req.user).some((m) => m.id === requestedModel)) {
        return res.status(400).json({ error: `unknown model: ${requestedModel}`, code: 'UNKNOWN_MODEL' });
      }
      await applySessionModel(sid, getSessionMetaDir(project.id, sid), requestedModel, 'turn');
    }

    const pendingSummary = isNewSession ? { count: 0, summary: '' } : await readPendingSummary(sessionRoot);
    const assetsSummary = await readAssetsSummary(sessionRoot);
    // raw：纯文本直达 SDK，不加任何装饰块 —— 斜杠命令（/compact 等）要求消息
    // 就是命令本身，多包一层 system 注入就不会被识别
    const { displayText, blocks } = raw === true && chatText.trim()
      ? { displayText: chatText.trim(), blocks: [{ type: 'text', text: chatText.trim() }] }
      : await composeUserMessage(chatText, attachments, pendingSummary, assetsSummary, sessionRoot);

    // 上传/附件诊断：NODESIGN_DEBUG_TURN=1 时打印 blocks 概况，定位 image 体积/媒体类型
    // 引发的 400/超 token 类问题（配合 binary-fixup-proxy 的 /tmp dump）
    if (process.env.NODESIGN_DEBUG_TURN === '1') {
      const summary = blocks.map((b) => {
        if (b.type === 'image') {
          const dataLen = b.source?.data?.length || 0;
          return `image(${b.source?.media_type},${(dataLen / 1024).toFixed(1)}KB-base64)`;
        }
        return `${b.type}(${(b.text || '').length}c)`;
      });
      console.info(`[turn.compose] sid=${sid.slice(0, 8)} blocks=[${summary.join(', ')}]`);
    }

    // 创建 run（pending）— per-turn record，displayText 落 brief 字段做审计
    const run = createRun({
      skillId: finalSkillId, brief: displayText, projectId: project.id,
      userId: req.user?.id ?? null, sessionId: sid,
    });

    // Phase A.6：写 LRU 让后续重试同 requestId 拿到一致 (runId, sid)
    // 同时 resolve in-flight Promise 通知正在 await 的并发 POST，5s 后清 in-flight
    // entry（让 LRU 接管后续 dedup 查询）。
    if (typeof requestId === 'string' && requestId) {
      lruPut(requestId, { pid: project.id, runId: run.id, sessionId: sid });
      if (inflightResolve) {
        inflightResolve({ pid: project.id, runId: run.id, sessionId: sid });
      }
      setTimeout(() => inflightTurns.delete(requestId), INFLIGHT_RETENTION_MS);
    }

    // 立即返回，agent 后台跑
    res.status(202).json({ runId: run.id, sessionId: sid });
    const bus = getProjectBus(project.id);

    const sdkUserMessage = {
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
    };

    if (hasActiveQuerySession(sid)) {
      // streamInput 模式：session 已有 long-running query 在跑 →
      // push 这条 message 进 queue，由 runSession 的 for-await-of 拉走处理。
      // 适用：① 续 chat（agent 已结束上一轮 idle 等）② 用户在 agent 跑时追加消息
      //
      // permissionMode 校正：请求带的 mode 和 SDK 当前 mode 不一致时（例如上一轮
      // agent 自己进了 plan mode，用户直接又发了一条普通消息），pushUserMessage 路径
      // 下 SDK 会按旧 mode 处理新 chat → canUseTool 拦 Write/Edit。这里在 push 前对齐。
      // setPermissionMode 是 SDK 原生 API，可在 turn 边界外调；fail-soft 不阻塞。
      const querySession = getQuerySession(sid);
      const currentMode = querySession?.currentPermissionMode;
      const desiredMode = initialPermissionMode;
      if (currentMode && desiredMode && currentMode !== desiredMode && querySession?.query?.setPermissionMode) {
        try {
          await querySession.query.setPermissionMode(desiredMode);
          setSessionPermissionMode(sid, desiredMode);
          emitPermissionModeChanged(project.id, sid, desiredMode);
        } catch (err) {
          console.warn(`[turn] mode sync failed sid=${sid.slice(0, 8)} (${currentMode}→${desiredMode}): ${err.message}`);
        }
      }
      const ok = pushUserMessage(sid, run.id, sdkUserMessage);
      if (!ok) {
        // race：刚 close 的 session（理论上极少）—— fallback 起新
        console.warn(`[turn] pushUserMessage failed for ${sid.slice(0, 8)}, falling back to new session`);
        startNewRunSession({ runId: run.id, sid, sessionRoot, blocks: sdkUserMessage, eventBus: bus, project, finalSkillId, chat, initialPermissionMode });
      } else {
        // push 后 emit 当前 queue 积压深度，前端显示"已排队 N 条"
        // depth=0 表示 agent idle 立刻处理；depth>0 表示 agent 还在忙，要排队
        const depth = getQueueDepth(sid);
        bus.publish({ type: 'run.queue.depth', sessionId: sid, depth, ts: new Date().toISOString() });
      }
    } else {
      // 没活跃 session → 起新 runSession（首条 message 提前 push 进 queue）
      startNewRunSession({ runId: run.id, sid, sessionRoot, blocks: sdkUserMessage, eventBus: bus, project, finalSkillId, chat, initialPermissionMode });
    }

    // 写回 active_session_id（让下次不带 sessionId 的 turn fallback 续到这个）。
    // setActiveSession **无条件**调：它顺带 bump projects.updated_at，首页
    // 「我的项目」按这个排序 —— 只在指针变化时才写会让"同会话继续聊"不再
    // 把项目顶到最前。
    //
    // E1a（2026-08-13）：指针**实际变化**时广播 project.active_session ——
    // 会话真相源收敛到服务端指针后，同项目其他标签页靠这条事件对齐自己。
    // project 是本请求开头 guardProject 读的库快照，拿它比对够准（写这个
    // 字段的只有 turn 和删会话两条路，都走 HTTP 串行到达）。
    try {
      const pointerChanged = project.activeSessionId !== sid;
      setActiveSession(project.id, sid);
      if (pointerChanged) {
        bus.publish({ ...Events.projectActiveSession(sid), ts: new Date().toISOString() });
      }
    } catch { /* ignore */ }
  } catch (err) {
    // 处理失败时通知正在 await in-flight 的并发同 requestId POST：reject + 清 entry
    // 让它们 fallthrough 自己跑（subagent 提的 race 修复完整闭环）。
    try { if (typeof inflightReject === 'function') inflightReject(err); } catch { /* */ }
    const rid = req.body?.requestId;
    if (typeof rid === 'string' && rid) inflightTurns.delete(rid);
    next(err);
  }
});

/**
 * 起一个新的 runSession（streamInput long-running query），并预 push 首条 user
 * message 让 SDK 启动后立即处理。fire-and-forget — 不阻塞 HTTP response。
 */
function startNewRunSession({ runId, sid, sessionRoot, blocks, eventBus, project, finalSkillId, chat, initialPermissionMode }) {
  const inputQueue = new AsyncQueue();
  inputQueue.push(blocks);   // 直接 push 进 queue —— runSession 启动后用 initialRunId 关联

  runSession({
    sessionId: sid,
    projectId: project.id,
    sessionWorkspaceRoot: sessionRoot,
    eventBus,
    inputQueue,
    skillId: finalSkillId,
    // 不再传 sessionTitle —— SDK doc:"Custom session title... skips automatic
    // title generation"。让 SDK 用 ANTHROPIC_SMALL_FAST_MODEL（haiku）自动
    // 总结对话生成标题，前端 run.done 后 refetch sessions 拉新 summary。
    // 用户主动 rename（未来 ✏️ 按钮）走 SDK renameSession() 单独路径。
    initialRunId: runId,
    initialPermissionMode,
  })
    .then(() => {
      console.info(`[turn] runSession ${sid.slice(0, 8)} ended cleanly`);
    })
    .catch((err) => {
      // session 抛错：query 可能挂了，前端通过 run.error event 看到
      console.error(`[turn] runSession ${sid.slice(0, 8)} failed:`, err.message);
    });
}

/**
 * POST /api/projects/:pid/runs/:runId/cancel
 *
 * 用户点"停止生成"按钮 → 触发活跃 run 的 AbortController.abort()。
 * SDK 看到 abort signal → query 中断 → session-loop try/catch 走 aborted 路径
 * → emit run.cancelled 事件给前端。
 *
 * 200 { ok: true }                  成功 trigger abort
 * 404 { error: 'run not active' }  runId 不在 registry（已结束 / 不存在）
 */
router.post('/:pid/runs/:runId/cancel', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const ok = cancelRun(runId, 'user_cancel');
    if (!ok) {
      return res.status(404).json({
        error: 'run not active or already finished',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * A4.2：POST /api/projects/:pid/runs/:runId/answer
 *
 * 用户在 AskUserQuestionView 卡片点选项 → 前端 POST 来这个 endpoint →
 * provideAnswer resolve 对应 toolUseId 的 Promise → session-loop.js canUseTool
 * 返回 { behavior: 'allow', updatedInput: { ...input, answers } } → SDK
 * binary 调 tool.call → 模型看到 "User has answered: q1=A"。
 *
 * Body：
 *   {
 *     toolUseId: string,            // run.ask_user_question 事件带的
 *     answers: { [questionText]: optionLabel }  // multi-select 用 ", " 拼
 *   }
 *
 * 200 { ok: true }                            成功 resolve
 * 404 { error, code: 'NO_PENDING_QUESTION' }  run/toolUseId 不在 pending
 *                                             （已答 / 已 cancel / 已结束）
 * 400 { error }                               body 缺字段
 */
router.post('/:pid/runs/:runId/answer', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { toolUseId, answers } = req.body || {};
    if (!toolUseId || typeof toolUseId !== 'string') {
      return res.status(400).json({ error: 'toolUseId required (string)' });
    }
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'answers required (object: { [questionText]: label })' });
    }

    const ok = provideAnswer(runId, toolUseId, answers);
    if (!ok) {
      return res.status(404).json({
        error: 'no pending question for this run/toolUseId',
        code: 'NO_PENDING_QUESTION',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Phase B 批次 4：POST /api/projects/:pid/runs/:runId/elicit/:reqId/answer
 *
 * MCP 工具调 server.elicitInput() 时 SDK 触发 onElicitation 回调，回调 emit
 * run.elicitation_request 事件让前端弹 Modal。用户填完后 POST 这个 endpoint
 * → provideElicitation resolve session-loop.js 里 await 的 Promise
 * → SDK 拿到 { action, content } 继续工具调用。
 *
 * Body:
 *   {
 *     action: 'accept' | 'decline' | 'cancel',
 *     content?: { [field]: any }  // accept 时用户填的表单字段
 *   }
 *
 * 200 { ok: true }
 * 404 { error, code: 'NO_PENDING_ELICITATION' }
 * 400 { error }
 */
router.post('/:pid/runs/:runId/elicit/:reqId/answer', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId, reqId } = req.params;
    const { action, content } = req.body || {};
    if (!action || !['accept', 'decline', 'cancel'].includes(action)) {
      return res.status(400).json({ error: 'action required (accept|decline|cancel)' });
    }

    const ok = provideElicitation(runId, reqId, { action, content });
    if (!ok) {
      return res.status(404).json({
        error: 'no pending elicitation for this run/reqId',
        code: 'NO_PENDING_ELICITATION',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────
// SDK Query control method endpoints（sdk.d.ts:2017 Query interface）
// 这些方法只在 streaming input/output 模式下可用 — session-loop.js 唯一入口
// 已让所有 run 走 AsyncIterable<SDKUserMessage>（buildUserMessageStream）满足前提。
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/projects/:pid/runs/:runId/rewind
 *
 * 配合 sdkOptions.enableFileCheckpointing —— 把 cwd 文件回滚到指定 user
 * message 时点 + session JSONL 截断到该 message。前端 user message 旁的
 * undo 按钮调这个 endpoint。
 *
 * Body: { messageId: string }  - SDKAssistantMessage.uuid 或 user message uuid
 *
 * 注意：rewindFiles 不主动 git revert（git 不在 SDK 管辖）→ 用户用 undo 后
 * 产物文件落后 git history 一步；前端可以 hint 或 host 端补 commit。
 */
router.post('/:pid/runs/:runId/rewind', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { messageId } = req.body || {};
    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ error: 'messageId required (string)' });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active or query handle not yet attached',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.rewindFiles !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing rewindFiles method (older SDK?)',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    const result = await query.rewindFiles(messageId);
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:pid/runs/:runId/permission-mode
 *
 * 运行时切 permission mode（'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'）。
 * Phase 3 plan-mode native 路径必需 —— plan 审批通过后切回 'default' 让
 * agent 继续 generate（write 工具放开）。
 *
 * Body: { mode: PermissionMode }
 */
router.post('/:pid/runs/:runId/permission-mode', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { mode } = req.body || {};
    const VALID_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
    if (!mode || !VALID_MODES.includes(mode)) {
      return res.status(400).json({
        error: `mode required, one of: ${VALID_MODES.join(', ')}`,
      });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setPermissionMode !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setPermissionMode method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    // inner try/catch：SDK 拒切 mode 的具体原因（如老 session resume 后没
    // --dangerously-skip-permissions flag → "Cannot set permission mode to
    // bypassPermissions ..."）应该返给前端让用户知道；走 next(err) 让 Express
    // 默认 handler 处理就只剩通用 500 错，前端 toast 显示不出有效信息。
    try {
      await query.setPermissionMode(mode);
    } catch (err) {
      console.warn(`[permission-mode] setPermissionMode(${mode}) failed: ${err.message}`);
      const isPermissionFlagErr = /dangerously-skip-permissions|permission mode/i.test(err.message);
      return res.status(isPermissionFlagErr ? 409 : 500).json({
        error: err.message,
        code: isPermissionFlagErr ? 'PERMISSION_FLAG_MISMATCH' : 'SET_MODE_FAILED',
      });
    }
    // 同步更新 session 级 currentPermissionMode：canUseTool 钩子按此分流（plan
    // mode deny 列表）。不同步会让 mode 切回 default 后 canUseTool 仍按 plan 拦。
    const sid = getSessionIdByRunId(runId);
    if (sid) {
      setSessionPermissionMode(sid, mode);
      emitPermissionModeChanged(project.id, sid, mode);
    }
    res.json({ ok: true, mode });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:pid/runs/:runId/plan-request/:toolUseId/decide
 *
 * Phase C 阻塞态 plan-request：agent 调 mcp__nodesign__request_plan_mode 后
 * 工具阻塞 await 这个 endpoint。前端 PlanRequestBanner：
 *   - 用户 yes：先 POST /permission-mode { mode:'plan' }，再 POST 这个 { approved:true }
 *   - 用户 no：直接 POST 这个 { approved:false }
 *
 * 找到 sessionId（runId → session reverse lookup）→ providePlanRequestDecision 解阻塞。
 *
 * Body: { approved: boolean }
 */
router.post('/:pid/runs/:runId/plan-request/:toolUseId/decide', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId, toolUseId } = req.params;
    const { approved } = req.body || {};
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'approved (boolean) required in body' });
    }

    const sid = getSessionIdByRunId(runId);
    if (!sid) {
      return res.status(404).json({
        error: 'run not active or session unknown',
        code: 'SESSION_NOT_FOUND',
      });
    }
    const ok = providePlanRequestDecision(sid, toolUseId, { approved });
    if (!ok) {
      return res.status(404).json({
        error: 'no pending plan request found (already resolved / expired / wrong toolUseId)',
        code: 'PENDING_NOT_FOUND',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:pid/runs/:runId/model
 *
 * 运行中切 model（SDK query.setModel，当场对下一次 LLM 调用生效）。
 *
 * **目前只有 API 能到这里**：前端 picker 在 turn 运行中是禁用的，它走
 * PUT /sessions/:sid/model（那条等空闲才重启 query）。这条留着是因为"turn 跑到
 * 一半换模型"是它独有的能力，PUT 那条按设计做不到。前端那个没人调的 Turn.setModel
 * 绑定已删（doc 里还写着 kimi 时代的 model 名，留着只会误导下一个人）。
 *
 * 2026-07-30：切完**必须同时落 session-config**。原来这条只改运行时不写文件，
 * 于是"当前这轮是 Opus、下次 resume 变回 Sonnet"，而且界面无从得知；跟另外两条
 * 写模型的路加起来，同一个事实有三个互不知情的写者。现在统一走 applySessionModel，
 * 它自己会判断要不要重启空闲 query（这里 query 正在跑，不会重启）。
 *
 * Body: { model: string | null }  - null = 清掉覆盖回到全局默认
 */
router.post('/:pid/runs/:runId/model', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { model } = req.body || {};
    if (model !== null && model !== undefined && typeof model !== 'string') {
      return res.status(400).json({ error: 'model must be string or null' });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setModel !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setModel method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    const sid = getSessionIdByRunId(runId);
    await query.setModel(model || undefined);
    // 运行时切完再落盘：setModel 失败就不该留下"配置说切了"的假象
    let persisted = null;
    if (sid) {
      await ensureSessionWorkspace(project.id, sid);
      persisted = await applySessionModel(sid, getSessionMetaDir(project.id, sid), model ?? null, 'runtime');
    }
    res.json({ ok: true, model: persisted?.model ?? model, override: persisted?.override ?? null });
  } catch (err) { next(err); }
});

/**
 * Phase 3.2：POST /api/projects/:pid/runs/:runId/plan-approve
 *
 * 用户在 PlanReviewCard 点"批准"（可选编辑过 plan）→ 落 design-plan.md 留档 →
 * query.setPermissionMode('bypassPermissions') → agent 自然继续（plan mode 下
 * agent 调 ExitPlanMode 后 canUseTool 阻塞等 host 切 mode；切完 SDK 自动放行）。
 *
 * ⚠️ 切 'bypassPermissions' 而非 'default' —— session 起初就是 bypassPermissions
 * （session-loop.js:232），切 'default' 会让 SDK 走 per-tool 询问流程，多数写工具
 * 默认 deny → ExitPlanMode 后 Edit/Write 仍被拦的根因。
 *
 * Body: { editedPlan?: string } - 用户编辑过的 plan markdown（无则用 agent 原版）
 */
router.post('/:pid/runs/:runId/plan-approve', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { editedPlan, toolUseId } = req.body || {};

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setPermissionMode !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setPermissionMode method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    // 可选：把 editedPlan 落 design-plan.md，让后续 vision-checker 等可以 Read
    // 拿到用户审批通过的版本（agent 原版仅在 ExitPlanMode tool input 里）
    if (typeof editedPlan === 'string' && editedPlan.trim()) {
      try {
        // 用 sessionId 取 sessionRoot；从 query 上拿不到 cwd，借助 project + run
        // metadata。简化版：直接用 active session（turn.js 创建 run 时已 setActiveSession）
        const sid = project.activeSessionId;
        if (sid) {
          const sessionRoot = await ensureSessionWorkspace(project.id, sid);
          await fs.writeFile(
            path.join(sessionRoot, 'design-plan.md'),
            editedPlan.trim() + '\n',
            'utf8',
          );
        }
      } catch (err) {
        console.warn(`[plan-approve] failed to write design-plan.md:`, err.message);
        // 不阻塞 approve；agent 拿不到 design-plan.md 时仍按 ExitPlanMode 内的 plan 执行
      }
    }

    // 顺序关键：① 先切 mode → ② 再 resolve canUseTool 的 pending Promise。
    // 反过来 resolve 先发生 → canUseTool return → ExitPlanMode tool 执行 → agent
    // next turn 看到的可能仍是 plan-mode reminder（race condition）。
    //
    // 回到**会话起初那个 mode**（platform.permissionModeDefault：生产是
    // 'bypassPermissions'，exp 是 'auto'）。别写死 —— 写死会让 plan 批准之后
    // 整条会话退回没有分类器的状态。也别用 'default'：那会走 per-tool 询问流程，
    // 多数写工具默认 deny（"ExitPlanMode 后 Edit 还是被拦"就是这么来的）。
    const backToMode = platform.permissionModeDefault;
    await query.setPermissionMode(backToMode);
    const sid = getSessionIdByRunId(req.params.runId);
    if (sid) {
      setSessionPermissionMode(sid, backToMode);
      emitPermissionModeChanged(project.id, sid, backToMode);
    }
    if (sid && toolUseId) {
      // resolve canUseTool 里 await 的 pending plan approval Promise，agent 阻塞解开
      const ok = providePlanApprovalDecision(sid, toolUseId, {
        approved: true,
        editedPlan: typeof editedPlan === 'string' && editedPlan.trim() ? editedPlan.trim() : undefined,
      });
      if (!ok) {
        // 兼容老 session（PR 之前没 canUseTool 拦的 case）：providePlanApprovalDecision
        // 找不到 pending → 不 fail，agent 应该已经在 PostToolUse 路径继续了
        console.warn(`[plan-approve] no pending plan approval for tid=${toolUseId} (legacy hook path?)`);
      }
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Phase 3.2：POST /api/projects/:pid/runs/:runId/plan-reject
 *
 * 用户在 PlanReviewCard 点"重新对齐" → 中断 run，前端切回 chat 让用户重述 brief。
 * Body: { reason?: string }（写入 abort signal.reason，前端 run.cancelled 事件可看）
 */
router.post('/:pid/runs/:runId/plan-reject', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { toolUseId, reason: reasonRaw } = req.body || {};
    const reason = reasonRaw || 'plan_rejected';

    // 顺序：先显式 resolve pending plan approval（让 canUseTool 拿到 reject 决议
    // → return deny/interrupt）→ 再 cancelRun 兜底（abortController 关 query
    // 防漏网）。registerPendingPlanApproval 的 abort listener 也会 reject Promise，
    // 但显式 resolve 让 canUseTool 拿到的是用户意图（reject）而非 abort 错误。
    const sid = getSessionIdByRunId(runId);
    if (sid && toolUseId) {
      providePlanApprovalDecision(sid, toolUseId, { approved: false });
    }

    // 切回 bypassPermissions：reject 语义是"放弃这个 plan"，session 续命后继续走
    // 普通模式。不切的话 cancelRun → SDK query 续命但 currentPermissionMode 仍 'plan'
    // → 用户重发 chat 经 pushUserMessage 路径 → canUseTool 仍按 plan deny Write/Edit。
    // 对称 plan-approve 路径（line 803-805）。fail-soft 不阻塞 cancel。
    if (sid) {
      const qs = getQuerySession(sid);
      if (qs?.query?.setPermissionMode) {
        try {
          await qs.query.setPermissionMode('bypassPermissions');
          setSessionPermissionMode(sid, 'bypassPermissions');
          emitPermissionModeChanged(project.id, sid, 'bypassPermissions');
        } catch (err) {
          console.warn(`[plan-reject] setPermissionMode failed sid=${sid.slice(0, 8)}: ${err.message}`);
        }
      }
    }

    const ok = cancelRun(runId, reason);
    if (!ok) {
      return res.status(404).json({
        error: 'run not active or already finished',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 注：POST /image-approval 路由已删除（2026-05-06）。原本配 ImageApprovalBanner
// 走 approve/regenerate/dismiss 三按钮 gate，但实际上 emit 完即返不阻塞 agent，
// 形同弹窗装饰。改为：generate_image 已在 CallToolResult 返 image content block，
// 前端自动渲染；agent 在 caption / 自然回话邀请反馈，下一轮用户 chat 即天然 gate。

export default router;
