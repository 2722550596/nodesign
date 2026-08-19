/**
 * server/api/turn-plan.js — plan mode 那族端点（2026-08-19 从 turn.js 拆出）
 *
 * 拆的理由是行数棘轮：turn.js 顶到冻结上限（910 > 902），规矩是"胖了就拆，
 * 别抬上限"。挑这一族走，是因为它跟 turn.js 的主职责（收一条用户消息 → 起/续
 * SDK 会话）没有关系 —— 它们全是**对一个已经在跑的 run 做带外操作**：切
 * permission mode、解开 agent 阻塞在 canUseTool 上的那个 Promise、批准或驳回
 * 一份 plan。四个 handler 之间共享的上下文（切 mode 必须同步 session 级
 * currentPermissionMode、approve 与 reject 要对称地切回同一个 mode）也只在它们
 * 之间存在。
 *
 * 挂载点不变：index.js 把它挂在 /api/projects 上，路径与拆分前逐字节相同，
 * 前端一个字不用改。
 *
 * 守卫与 emitPermissionModeChanged 都从原处 import，不抄第二份 —— 这个仓库为
 * 「同一件东西有多个实例」付过最贵的学费。turn.js 不 import 本文件（两边由
 * index.js 平行挂载），所以没有循环依赖。
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { guardProject, guardRunInProject } from './_guard.js';
import { emitPermissionModeChanged } from './turn.js';
import { ensureSessionWorkspace } from '../projects/workspace.js';
import {
  cancelRun, getQuery, getQuerySession,
  setSessionPermissionMode, getSessionIdByRunId,
  providePlanRequestDecision, providePlanApprovalDecision,
} from '../engine/runs/active-runs.js';
import { platform } from '../runtime/platform.js';

const router = express.Router();

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

export default router;
