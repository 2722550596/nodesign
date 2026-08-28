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
 *   2. composeUserMessage：拼成 content blocks（多模态；system 注入 08-27 起归 session-loop runTurn 执行时点）
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
import { guardProject, guardRunInProject, modelUserFor } from './_guard.js';
import {
  ensureProjectWorkspace,
  ensureSessionWorkspace,
  validateSessionId,
  getSessionMetaDir,
} from '../projects/workspace.js';
import { createRun } from '../engine/runs/store.js';
import { runSession } from '../engine/agent/session-loop.js';
import {
  cancelRun, hasActiveQuerySession, getQuerySession, getSessionIdByRunId,
} from '../engine/runs/active-runs.js';
import { pushUserMessage, getQueueDepth } from '../engine/runs/turn-relay.js';
import { applySessionModel, resolveSessionModel } from '../engine/agent/session-model.js';
import { lruGet, lruPut, inflightTurns, INFLIGHT_RETENTION_MS } from './turn-inflight.js';
import { allowedModelsFor, defaultModelFor, modelIsFree, modelSwitchRejection } from '../engine/agent/model-context.js';
import { isEnvBundleModel } from '../engine/pi/model-map.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { checkQuota, checkFreeQuota, checkConcurrency, fmtUsd } from '../lib/quota.js';
import { shouldModerate, moderateText, recordViolation, levelFor } from '../lib/moderation.js';
import { getProjectBus } from '../ws/broker.js';
import { Events } from '../engine/agent/events.js';
// （readPendingSummary 08-27 搬去 session-loop runTurn 执行时点采集 —— 排队消息不带过期状态）
import { pendingRewinds } from './sessions.js';
import { composeUserMessage } from './turn-compose.js';
import { getPendingAsk, answerAsk } from '../engine/pi/ask-registry.js';

const router = express.Router();


router.post('/:pid/turn', async (req, res, next) => {
  // ⚠️ 必须在 try **外面**：catch 是 try 的**兄弟**作用域。写在里面的话 catch 那句
  // `typeof inflightReject === 'function'` 够不到它，而 typeof 对未声明的名字不抛错
  // 只返 'undefined' —— 那条 race 修复就此一声不响地失效（08-17 被 no-undef.lint 扫出）。
  let inflightResolve = null;
  let inflightReject = null;
  try {
    const project = guardProject(req, res);
    if (!project) return;

    const { chat, attachments, skillId, sessionId, requestId, raw } = req.body || {};
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

    const finalSkillId = (typeof skillId === 'string' && skillId) || project.skillId;

    // C4：先确定 sessionRoot（sid 解析逻辑下面已写）。pendingSummary 的注入 08-27
    // 搬到 session-loop runTurn 执行时点；这里 ensure 只为附件解析和 runSession 落根。

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

    // 守卫：死会话 rewind（临时 spawn 裸 pi，sessions.js pendingRewinds）在跑时
    // 拒绝同 sid 新 turn —— 防止两个 pi 进程同时写同一 session JSONL。裸 pi
    // navigate_tree ~3-5s，用户重试一次就 OK。
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
    // 模型解析提前到配额之前（08-21，配额按是否免费分岔）：body.model > 会话覆盖 > 默认（defaultModelFor）
    const requestedModelEarly = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null;
    const sessionModelEarly = await resolveSessionModel(getSessionMetaDir(project.id, sid));
    const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）
    const turnModel = requestedModelEarly || sessionModelEarly.override || defaultModelFor(modelUser) || sessionModelEarly.model;
    // 解析出来的模型一律过白名单（不只 body.model）：旧覆盖/资格收回/无 select 裸名都在此拦（fable P0）
    // env 全家桶 fallback（M1.5）：NODESIGN_MODEL 指向 manifest 外的自定义上游时，
    // 它不在模型表里，白名单会 403 —— 但 pi 侧已注册 custom provider，放行。
    if (!isEnvBundleModel(turnModel) && !allowedModelsFor(modelUser).some((m) => m.id === turnModel)) {   // 清单整个为空（本地版没 key/没登录/没插槽）→ 指路设置页，别让人去选择器里找
      return res.status(403).json(allowedModelsFor(modelUser).length ? { error: `这个会话指向的模型（${turnModel}）现在不可用，请在模型选择器里换一个`, code: 'MODEL_NOT_ALLOWED', model: turnModel } : { error: '还没有可用的模型：到「设置」填 API Key（或本机 claude login），或者配一个模型插槽', code: 'NO_MODEL_CONFIGURED', model: turnModel });
    }
    // ⛔ 08-25 修：原来这条带着 `sessionModelEarly.override &&`，于是**跑在全局默认上的会话（override=null）
    // 整个逃过检查** —— 而站上默认恰恰是免费的 Ox（openai-chat），正是这条闸要防的那一头。
    // 改成拿**当前有效模型**（override → env → 兜底，resolveSessionModel 已经算好）去比；新会话不拦，
    // 它还没有历史，而这条闸防的是历史里没有 signature 的 thinking 块被回传给真 Anthropic。
    // ⚠️ 已知的一处宽严不匹配：这里的"新会话"判据是 `!resumeSessionId`，而不是 sessions.js 那条 PUT 用的
    // "jsonl 存不存在"。差别只在一种情况——**会话建了但一次没跑过、第一轮就显式换到另一通路**，
    // 这里会多拦一次（409 说"新开一个会话"，人照做就没事）。sessionRoot 要到本函数后半段才拿得到，
    // 为这一种情况把 ensureSessionWorkspace 提前不划算。
    const laneWhy = modelSwitchRejection({ from: sessionModelEarly.model, to: requestedModelEarly, hasHistory: !isNewSession });
    if (laneWhy) return res.status(409).json({ error: laneWhy, code: 'LANE_SWITCH' });
    if (modelIsFree(turnModel)) {
      const fq = checkFreeQuota(req.user);
      if (!fq.ok) {
        return res.status(429).json({ error: `今天的免费轮次用完了（${fq.used} / ${fq.limit}），明天零点刷新`, code: 'QUOTA_EXCEEDED', kind: fq.kind, used: fq.used, limit: fq.limit });
      }
    }
    const quota = modelIsFree(turnModel) ? { ok: true } : checkQuota(req.user);
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
    // 不产生新并发）。免费行不受全局固定数限制，只受内存闸（quota.js）
    if (!getQuerySession(sid)?.currentRunId) {
      const gate = checkConcurrency(req.user, { free: modelIsFree(turnModel) });
      if (!gate.ok) {
        return res.status(429).json({ error: gate.message, code: gate.code });
      }
    }

    // ── 内容外审（2026-08-02）：消息先过分类器再进 agent。拦下 = 零成本，run 都不建。
    // 强度按账号（users.moderation_level_api，站主在控制台调），判定 / 留证 / 连坐封禁的
    // 口径全在 lib/moderation.js。
    // 没有文字就没有可审的东西（附件本来就不审，见 lib/moderation.js）——
    // 拿空串去问分类器只是白花一次调用和 1 秒。
    //
    // M3b 起外审是单旋钮（不再按模型通路分），但保留先算 turnModel 的顺序：
    // 新会话带 body.model 就是它（白名单校验在下面那段，这里只是读；非法名最终会 400），
    // 否则读该会话的 session-config（新会话没文件 → 全局默认）。只读不写 ——
    // 模型持久化仍在外审之后，拦下的消息不该改会话配置。
    if (shouldModerate(req.user, turnModel) && chatText.trim()) {
      const verdict = await moderateText(chatText, levelFor(req.user, turnModel));
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

    // 取 sessionRoot：附件 inline 解析 + runSession 的工作区根。
    //   （pendingSummary 注入 08-27 起在 session-loop runTurn 执行时点采集 ——
    //     消息可能在 inputQueue 排队，API 时点采的状态会过期）
    await ensureProjectWorkspace(project.id);
    const sessionRoot = await ensureSessionWorkspace(project.id, sid);

    // 模型选择（可选 body.model）：只用于**新建会话**时把首选模型带进来
    // （首页 / Hub 那条路，会话还不存在，前端只有 localStorage 偏好）。
    //
    // 会话建起来之后模型的真相在 session-config.json，改它走 PUT /sessions/:sid/model。
    // 这里之所以不再无脑接受 body.model：前端每条消息都带偏好的话，在另一台机器上
    // 为这个会话选的模型会被本机的旧偏好悄悄改回去 —— 一次发消息顺带改配置，
    // 用户完全看不见。
    // 没带 body.model 且会话无覆盖 → 默认模型写进会话
    const requestedModel = requestedModelEarly || (!sessionModelEarly.override ? turnModel : null);
    if (requestedModel) {
      // 与 PUT /sessions/:sid/model 同一道闸（2026-08-19 评审抓的洞）：这条路
      // 以前不校验，等于绕过 picker 白名单的后门 —— 表里有带真钥匙的 API 模型，
      // 裸 POST 就能替会话选中它烧上游的钱。校验用 allowedModelsFor。
      if (!isEnvBundleModel(requestedModel) && !allowedModelsFor(modelUserFor(req, project)).some((m) => m.id === requestedModel)) {
        return res.status(400).json({ error: `unknown model: ${requestedModel}`, code: 'UNKNOWN_MODEL' });
      }
      await applySessionModel(sid, getSessionMetaDir(project.id, sid), requestedModel, 'turn');
    }

    // raw：纯文本直达引擎，不加任何装饰块 —— 斜杠命令（/compact 等）要求消息
    // 就是命令本身，多包一层 system 注入就不会被识别。raw 标志随 queue item 传到
    // runTurn，执行时点同样跳过动态注入装配（状态块 / pendingSummary）。
    const isRaw = raw === true && !!chatText.trim();
    const { displayText, blocks } = isRaw
      ? { displayText: chatText.trim(), blocks: [{ type: 'text', text: chatText.trim() }] }
      : await composeUserMessage(chatText, attachments, sessionRoot);

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

    // M1 pi-rp 消息形状：{ text, images, raw? }。compose 出的是 Anthropic content blocks，
    // 这里翻译：text blocks 拼接；image block {source:{base64,media_type,data}} →
    // {type:'image', data, mimeType}（rpc-client prompt 的 images 形状）。
    const textParts = [];
    const images = [];
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
      else if (b.type === 'image' && b.source?.data) {
        images.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
      }
    }
    const piMessage = { text: textParts.join('\n\n'), images, ...(isRaw ? { raw: true } : {}) };

    if (hasActiveQuerySession(sid)) {
      // pi-rp 模式：session 已有 pi 子进程在跑 →
      // push 这条 message 进 queue，由 runSession 的消息循环拉走处理。
      // 适用：① 续 chat（agent 已结束上一轮 idle 等）② 用户在 agent 跑时追加消息（排队）
      const ok = pushUserMessage(sid, run.id, piMessage);
      if (!ok) {
        // race：刚 close 的 session（理论上极少）—— fallback 起新
        console.warn(`[turn] pushUserMessage failed for ${sid.slice(0, 8)}, falling back to new session`);
        startNewRunSession({ runId: run.id, sid, sessionRoot, message: piMessage, eventBus: bus, project, finalSkillId, chat });
      } else {
        // push 后 emit 当前 queue 积压深度，前端显示"已排队 N 条"
        // depth=0 表示 agent idle 立刻处理；depth>0 表示 agent 还在忙，要排队
        const depth = getQueueDepth(sid);
        bus.publish({ type: 'run.queue.depth', sessionId: sid, depth, ts: new Date().toISOString() });
      }
    } else {
      // 没活跃 session → 起新 runSession（首条 message 提前 push 进 queue）
      startNewRunSession({ runId: run.id, sid, sessionRoot, message: piMessage, eventBus: bus, project, finalSkillId, chat });
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
 * 起一个新的 runSession（pi-rp long-running 子进程），并预 push 首条 user
 * message（{runId, text, images, raw?}）让 pi 启动后立即处理。fire-and-forget — 不阻塞 HTTP response。
 */
function startNewRunSession({ runId, sid, sessionRoot, message, eventBus, project, finalSkillId, chat }) {
  const inputQueue = new AsyncQueue();
  // 首条消息直接 push 进 queue —— runSession 启动后用 initialRunId 关联
  inputQueue.push({ runId, text: message.text, images: message.images, ...(message.raw === true ? { raw: true } : {}) });

  runSession({
    sessionId: sid,
    projectId: project.id,
    ownerId: project.ownerId,   // pi 子进程身份（NODESIGN_UID）
    sessionWorkspaceRoot: sessionRoot,
    eventBus,
    inputQueue,
    skillId: finalSkillId,
    initialRunId: runId,
  })
    .then(() => {
      console.info(`[turn] runSession ${sid.slice(0, 8)} ended cleanly`);
    })
    .catch((err) => {
      // session 抛错：pi 子进程可能挂了，前端通过 run.error event 看到
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
 * M2 实装（doc §5.3 方案 A）：AskUserQuestion 复刻。pi 扩展 ask-user.ts 的
 * registerTool execute 长轮询 sidecar /ask 挂着；本路由把前端答案 resolve 进
 * ask-registry，/ask 随之返回，工具拿到答案继续跑。
 *
 * body: { answers: [{ selectedLabels?: string[], customText?: string }] }
 *   （answers 数组与 questions 平行；"Other" 自由输入走 customText）
 *
 * 200 { ok: true }           答案已送达
 * 404 NO_PENDING_ASK         该会话没有挂起的问题（超时/已答/已取消）
 * 409 ASK_RUN_MISMATCH       问题属于另一个 turn
 */
router.post('/:pid/runs/:runId/answer', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;
    const { runId } = req.params;
    const sid = getSessionIdByRunId(runId);
    const pendingAsk = sid ? getPendingAsk(sid) : null;
    if (!pendingAsk) {
      return res.status(404).json({ error: '没有等待回答的问题', code: 'NO_PENDING_ASK' });
    }
    if (pendingAsk.runId && pendingAsk.runId !== runId) {
      return res.status(409).json({ error: '问题属于另一个 turn', code: 'ASK_RUN_MISMATCH' });
    }
    const answers = req.body?.answers ?? req.body;
    answerAsk(sid, answers);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Phase B 批次 4：POST /api/projects/:pid/runs/:runId/elicit/:reqId/answer
 *
 * M1 换源后 501：elicitation 靠 SDK onElicitation 回调实现，pi-rp 没有对应
 * 机制（M2 评估）。路由保留，语义同 answer。
 */
router.post('/:pid/runs/:runId/elicit/:reqId/answer', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;
    return res.status(501).json({
      error: 'elicitation 交互 M1 暂不支持（引擎已换 pi-rp）',
      code: 'M1_NOT_SUPPORTED',
    });
  } catch (err) { next(err); }
});


import { hotSwitchModelHandler } from './turn-model-switch.js';

/** 运行中热切模型（实现连同它那三道闸搬去了 turn-model-switch.js） */
router.post('/:pid/runs/:runId/model', hotSwitchModelHandler);


// 注：POST /image-approval 路由已删除（2026-05-06）。原本配 ImageApprovalBanner
// 走 approve/regenerate/dismiss 三按钮 gate，但实际上 emit 完即返不阻塞 agent，
// 形同弹窗装饰。改为：generate_image 已在 CallToolResult 返 image content block，
// 前端自动渲染；agent 在 caption / 自然回话邀请反馈，下一轮用户 chat 即天然 gate。

export default router;
