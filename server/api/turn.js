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
import {
  ensureProjectWorkspace,
  ensureSessionWorkspace,
  validateSessionId,
  readAssetsSummary,
} from '../projects/workspace.js';
import { createRun } from '../engine/runs/store.js';
import { runSession } from '../engine/agent/session-loop.js';
import {
  cancelRun, provideAnswer, getQuery, provideElicitation,
  hasActiveQuerySession, pushUserMessage, getQuerySession, closeQuerySession,
  getQueueDepth, setSessionPermissionMode, getSessionIdByRunId,
  providePlanRequestDecision,
  providePlanApprovalDecision,
} from '../engine/runs/active-runs.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { getProjectBus } from '../ws/broker.js';
import { readPendingSummary } from './pending-changes.js';
import { pendingRewinds } from './sessions.js';

/** 直接 image input 阈值：> 1MB 走 path 让 agent Read，< 1MB inline base64 */
const IMAGE_INLINE_MAX_BYTES = 1 * 1024 * 1024;
/** Anthropic API 支持的 image media types（sdk-tools.d.ts:150 + API doc） */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

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
 * Emit run.permission_mode_changed —— 让前端 PlanModeToggle 按钮 visual 跟 SDK
 * 实际 permissionMode 双向同步。所有 mode 切换路径（用户 toggle / plan-approve /
 * plan-reject / turn 入口 mode 校正）调完 setPermissionMode 后都该 emit 一次。
 *
 * 前端 ProjectWorkspace.handleEvent case 'run.permission_mode_changed' 收事件
 * → setPlanModeEnabled(mode === 'plan')，UI toggle 自动反映 SDK 真相。
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
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { chat, attachments, skillId, sessionId, permissionMode, requestId, raw } = req.body || {};
    if (!chat || typeof chat !== 'string' || !chat.trim()) {
      return res.status(400).json({ error: 'chat string required' });
    }

    // Phase A.6：requestId 命中 LRU → 直接返已存在的 run/session（弱网重发幂等）
    // race 修复：① LRU 命中（已完成请求）→ 立即返；② in-flight 命中（正在跑）→
    // await 第一 POST 的 result 后返 deduped；③ 都 miss → 注册 in-flight Promise
    // 后继续走 createRun 路径，结尾 resolve / reject 通知后续等待者。
    let inflightResolve = null;
    let inflightReject = null;
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
    const initialPermissionMode = permissionMode === 'plan' ? 'plan' : 'bypassPermissions';

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

    // 取 sessionRoot + 两类 workspace 主动提示：
    //   - pendingSummary（C4）：用户在 chat 间隔做的直接编辑/评论 buffer
    //   - assetsSummary（C8）：./assets/ 里的参考素材（图/文档），新 session 必报，
    //     续 session 仅当 buffer/旧素材的存在仍可能影响判断时报（这里简化为"非空就报"）
    await ensureProjectWorkspace(project.id);
    const sessionRoot = await ensureSessionWorkspace(project.id, sid);
    const pendingSummary = isNewSession ? { count: 0, summary: '' } : await readPendingSummary(sessionRoot);
    const assetsSummary = await readAssetsSummary(sessionRoot);
    // raw：纯文本直达 SDK，不加任何装饰块 —— 斜杠命令（/compact 等）要求消息
    // 就是命令本身，多包一层 system 注入就不会被识别
    const { displayText, blocks } = raw === true
      ? { displayText: chat.trim(), blocks: [{ type: 'text', text: chat.trim() }] }
      : await composeUserMessage(chat, attachments, pendingSummary, assetsSummary, sessionRoot);

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
    const run = createRun({ skillId: finalSkillId, brief: displayText, projectId: project.id });

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
      // permissionMode 校正：用户 cancel 后切了"深度对齐" toggle 时，PlanModeToggle
      // 看 activeRun=null 跳过了 /permission-mode API（前端 store 切了但 SDK 没切），
      // pushUserMessage 路径下 SDK 仍按旧 mode 处理新 chat → canUseTool 拦 Write/Edit。
      // 这里在 push 前对齐 mode 让 SDK 看到用户最新意图。setPermissionMode 是 SDK
      // 原生 API，可在 turn 边界外调；fail-soft 不阻塞。
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

    // 写回 active_session_id（让下次不带 sessionId 的 turn fallback 续到这个）
    try { setActiveSession(project.id, sid); } catch { /* ignore */ }
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
 * 把 chat 文本 + attachments 拼成 SDK content blocks 数组。
 *
 * 返回：
 *   - displayText: 用于 createRun 审计 + run.error 时前端显示 fallback
 *   - blocks: BetaContentBlockParam[]（喂 SDK 的 user message content）
 *
 * 策略：
 *   - **小图（< 1MB） inline base64** → user message 顶层 image content block，
 *     agent 一上来就能 vision 看见参考图，不用先 Read。Kimi vision 通过
 *     binary-fixup-proxy 已验证（lift transform 仅处理 tool_result 嵌套；
 *     user message 顶层 image 直接走标准路径，无需 lift）。
 *   - **大图（>= 1MB）/ 非 image / 文档** → 文本路径让 agent Read（避免大文件
 *     爆 user message token，配合 prelude 的"开工前必看 ./assets/"硬规则）
 *   - **anchor / comment 类型** → 文本描述
 *
 * Anthropic image content block 仅支持 jpeg/png/gif/webp，不支持 svg/heic 等。
 * 不在白名单的 image mime → 按文本路径降级。
 */
async function composeUserMessage(chat, attachments, pendingSummary, assetsSummary, sessionRoot) {
  const blocks = [];

  // C4：用户在过去时段做的 direct edit + comment → prepend system 提示
  // 不灌详情（让 agent 主动调 mcp__nodesign__get_pending_changes 拉），省 token
  if (pendingSummary && pendingSummary.count > 0) {
    blocks.push({
      type: 'text',
      text: `<system>${pendingSummary.summary}。可调 mcp__nodesign__get_pending_changes 查看详情；处理完调 mcp__nodesign__clear_pending_changes 清 buffer。</system>`,
    });
  }

  // C8：assets/ 主动提醒（替代 prelude 硬规则"必先 Glob assets"）—— workspace
  // 检测到有素材时温和提示 agent，没素材就不注入，agent 不必每个 turn 硬查
  if (assetsSummary && assetsSummary.count > 0) {
    // assets/ 是 symlink → shared/assets/，SDK Glob/Grep 走 ripgrep 默认不跟
    // symlink，所以 `Glob("assets/*")` 会拿 "No files found"。把完整路径列出来
    // 让 agent 跳过 Glob 直接 Read（plan mode Bash 被 deny 没有 ls 兜底，更需要这条）。
    const fileList = Array.isArray(assetsSummary.paths) && assetsSummary.paths.length > 0
      ? `\n完整路径（直接 Read，**别用 Glob/Grep——assets/ 是 symlink，SDK 默认不跟会返回空**）：\n${assetsSummary.paths.map((p) => `- ${p}`).join('\n')}`
      : '';
    let hint = '建议挑 1 张关键图 Read 看一眼（你能直接 vision 看到颜色/质感/排版），再决定动手。如果跟用户的 brief 不相关可以先不看。';
    if (assetsSummary.hasBinaryDocs) {
      hint += ' PDF / PPTX / DOCX / XLSX 直接 Read 拿不到结构化内容（二进制或 zip 包），用 Bash 跑 python3 解：pdf 用 pdfplumber 或 PyPDF2、ppt 用 python-pptx、docx 用 python-docx、xlsx 用 openpyxl。**python 提取出来的不只是文本，通常还包含嵌入图片**（导出到临时目录如 `/tmp/extracted/` 或 `./assets/extracted/`）—— 提取完一定 Read 看图片（vision 自动渲染），别只看 stdout 文本就以为信息齐了。文档里的图常含关键 brand 元素 / 数据图表 / 案例视觉，跳过看图等于丢了一半内容。';
    }
    blocks.push({
      type: 'text',
      text: `<system>${assetsSummary.summary}。${hint}${fileList}</system>`,
    });
  }

  blocks.push({ type: 'text', text: chat });

  if (Array.isArray(attachments) && attachments.length > 0) {
    // 先尝试给 image attachment inline base64；inline 失败的当 path 走文本路径
    const inlineImageNames = [];
    const fallbackLines = [];

    for (const a of attachments) {
      if (!a || typeof a !== 'object') continue;
      if (a.type === 'anchor') {
        fallbackLines.push(`- 选中元素: page=${a.pageIndex} ${a.tag || 'element'} ${a.text ? `"${a.text}"` : ''}`);
        continue;
      }
      if (a.type === 'comment') {
        fallbackLines.push(`- 评论: ${a.text} (anchor: ${JSON.stringify(a.anchor || {})})`);
        continue;
      }
      // asset 路径分支（assets API 返回 path 形如 '../../shared/assets/<name>'）
      if (!a.path) continue;
      const inline = await tryInlineImageAttachment(a, sessionRoot);
      if (inline) {
        blocks.push(inline);
        inlineImageNames.push(a.name || path.basename(a.path));
      } else {
        fallbackLines.push(`- ${a.path}${a.name ? `（${a.name}）` : ''}`);
      }
    }

    if (inlineImageNames.length > 0) {
      blocks.push({
        type: 'text',
        text: `[已直接附上 ${inlineImageNames.length} 张参考图：${inlineImageNames.join('、')} —— 你可以直接 vision 看，不需要再 Read]`,
      });
    }
    if (fallbackLines.length > 0) {
      blocks.push({
        type: 'text',
        text: `可用素材（用 Read 工具读取，路径相对 workspace）：\n${fallbackLines.join('\n')}`,
      });
    }
  }

  // 故事忠于：comment 类型的 attachment 触发"改前回故事"提醒
  // 设计原则 metadata-not-content：只提醒 agent 去 Read，不注入 plan/decisions 内容
  const hasComment = Array.isArray(attachments) && attachments.some((a) => a && a.type === 'comment');
  if (hasComment) {
    let hasDesignPlan = false;
    try {
      await fs.access(path.join(sessionRoot, 'design-plan.md'));
      hasDesignPlan = true;
    } catch { /* design-plan.md 不存在，用退化文案 */ }

    blocks.push({
      type: 'text',
      text: hasDesignPlan
        ? '[评论提示 — 改前可以 Read design-plan.md 对照该页 c_decisions（reference / opposition / constraint / motion）；如果改动跟主线方向不一致，在 chat 里跟用户点一下再动手]'
        : '[评论提示 — 改前可以回看最近 decisions（hook 已注入摘要 / 细节去 Read spec.json）；如果改动方向不确定，跟用户点一下]',
    });
  }

  // displayText：合并 blocks 用 \n\n，给 DB 审计 / fallback 显示用
  // image block 用占位文本而非 base64（base64 进 DB / 前端 fallback 都没意义）
  const displayText = blocks.map((b) => {
    if (b.type === 'image') return '[image]';
    return b.text || `[${b.type}]`;
  }).join('\n\n');

  return { displayText, blocks };
}

/**
 * 尝试把 attachment 直接读成 image content block。
 * 失败（不是 image / 太大 / 读取失败 / mime 不在白名单）返 null，让调用方
 * 走 path 字符串 fallback。
 *
 * @param {object} attachment - { path, name?, mime?, size? }
 * @param {string} sessionRoot - 绝对路径，sessions/<sid>/
 * @returns {Promise<null | { type: 'image', source: { type: 'base64', media_type, data } }>}
 */
async function tryInlineImageAttachment(attachment, sessionRoot) {
  const mime = attachment.mime;
  if (!mime || !IMAGE_MEDIA_TYPES.has(mime)) return null;

  // attachment.path 是相对 sessionRoot 的（assets API 返 '../../shared/assets/...'）
  // 解析成绝对路径，并校验解析后仍在 project workspace 内（防 path traversal）
  let absPath;
  try {
    absPath = path.resolve(sessionRoot, attachment.path);
  } catch {
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > IMAGE_INLINE_MAX_BYTES) return null;

  let buf;
  try {
    buf = await fs.readFile(absPath);
  } catch {
    return null;
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mime,
      data: buf.toString('base64'),
    },
  };
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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
 * 运行时切 model（如 kimi-k2.6 / claude-sonnet-4-6 / claude-opus-4-7）。
 * 前端 model picker 用。Kimi gateway 可用 model 列表受 gateway 限制。
 *
 * Body: { model: string }  - 传 null 或 omit 让 SDK 用 default
 */
router.post('/:pid/runs/:runId/model', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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

    await query.setModel(model || undefined);
    res.json({ ok: true, model });
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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
    // 切 'bypassPermissions' 而非 'default'（用户报告"ExitPlanMode 后 Edit 还是被
    // 拦"的根因）—— session 起初就是 'bypassPermissions'（session-loop.js:232），
    // plan 退出回到同一 mode 才一致。'default' 让 SDK 走 per-tool 询问流程，多数
    // 写工具默认 deny。
    await query.setPermissionMode('bypassPermissions');
    const sid = getSessionIdByRunId(req.params.runId);
    if (sid) {
      setSessionPermissionMode(sid, 'bypassPermissions');
      emitPermissionModeChanged(project.id, sid, 'bypassPermissions');
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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
