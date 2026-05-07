/**
 * mcp/tools/request-plan-mode.js — request_plan_mode MCP tool
 *
 * 让 main agent 在跑到一半发现"这事儿挺复杂得先理一理"时，主动 emit 一个
 * "请求进 plan mode" 信号 → 前端 PlanRequestBanner 弹给用户 yes/no。
 *
 * **阻塞态**（2026-05-07 改）：handler await 用户决定后才返回。之前非阻塞导致：
 *   - agent 边请求边继续做事（写文件 / 调工具），等用户点 yes 时 run 已 done
 *     → /permission-mode endpoint getQuery 返 null → setPermissionMode 失败
 *     → 用户体感"同意了也进不去 plan mode"
 *   - 阻塞后 turn 一直活着等 query.setPermissionMode 切 mode + 用户决定
 *
 * 流程：
 *   1. agent 调 mcp__nodesign__request_plan_mode({reason, estimatedPages?})
 *   2. handler 自生成 requestId = randomUUID()（**不是** SDK tool_use_id —— MCP
 *      RequestHandlerExtra 规范没这字段，Anthropic SDK 转发 mcp_message 时也不注入；
 *      banner 句柄全程是不透明 string，前后端串起来即可）
 *   3. handler emit 'run.plan_mode_requested' { toolUseId: requestId, reason, ... }
 *      然后 await registerPendingPlanRequest(sessionId, requestId)
 *   4. 前端 PlanRequestBanner 弹横幅，含 toolUseId 给 decide 端点
 *   5. 用户 yes
 *      → 前端先 POST /permission-mode { mode:'plan' }（实际切 SDK）
 *      → 再 POST /plan-request/:tid/decide { approved:true }（解阻塞 + agent 拿到结果）
 *      → handler return text 提示 agent 已切 plan，按 plan-instructions.md 走
 *   6. 用户 no
 *      → 前端 POST /plan-request/:tid/decide { approved:false }
 *      → handler return text 让 agent 按原计划继续
 *   7. session 关掉 / abort → pending Promise reject → handler 返 error 给 agent
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerPendingPlanRequest } from '../../runs/active-runs.js';

/**
 * @param {object} deps
 * @param {string} [deps.sessionId]   NoDesign sessionId — pending Promise key
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeRequestPlanModeTool({ ctx, sessionId } = {}) {
  return tool(
    'request_plan_mode',
    `Request the host switch this run into Plan Mode (read-only design planning,
逐页 brainstorm 协作 + ExitPlanMode required to leave). Use this when user's
brief is complex enough you want to align on a structured plan before any
generation work.

WHEN TO USE:
  - 5+ page deck / strong narrative arc
  - User brief > 200 words with multiple constraints
  - Conflicting requirements that need explicit trade-off decisions
  - Tasks where rework cost is high (heavy data viz, multi-character story)

WHEN NOT TO USE:
  - Simple single-page tweaks
  - Clearly scoped UI fixes
  - User already gave a precise outline

EFFECT (BLOCKING):
  Emits a 'run.plan_mode_requested' event. The user sees a banner with your
  reason and can approve or dismiss. **This tool blocks until user decides** —
  agent does not continue mid-decision (avoids racing the user's click).

  - User approves → host calls query.setPermissionMode('plan'), tool returns
    "approved" text. Your next assistant turn will see Plan-mode system
    reminder; follow plan-instructions.md (逐页 brainstorm + ExitPlanMode).
  - User dismisses → tool returns "dismissed" text; continue your current task
    without entering plan mode.

If session aborts while waiting (rare), tool returns an error.`,
    {
      reason: z
        .string()
        .min(8)
        .max(400)
        .describe('Why you think Plan Mode would help (shown to the user in the banner). Be specific: what decisions you want to align on.'),
      estimatedPages: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe('For deck-style tasks: rough page count estimate. Helps user gauge scope.'),
      taskKind: z
        .enum(['deck', 'landing', 'dashboard', 'report', 'other'])
        .optional()
        .describe('Coarse task kind; helps user banner show the right framing.'),
    },
    async ({ reason, estimatedPages, taskKind }, _extra) => {
      // banner-side request id（不是 SDK 的 tool_use_id）：MCP RequestHandlerExtra
      // 规范字段没有 toolUseID，Anthropic SDK 转发 mcp_message 时也不注入 _meta，
      // 所以 handler 拿不到 SDK 真 tool_use_id。这里改用自生成 UUID 当 banner 句柄
      // —— 全链路（emit 事件 → 前端 banner → POST decide → providePlanRequestDecision）
      // 只需要前后用同一个不透明 string 串起来，跟 SDK 内部 tool_use_id 无关。
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'request_plan_mode internal error: sessionId not configured.' }],
          isError: true,
        };
      }
      const requestId = randomUUID();

      try {
        ctx?.emit?.({
          type: 'run.plan_mode_requested',
          toolUseId: requestId,  // 字段名保留 toolUseId（前端 PlanRequestBanner / decide 端点协议不变）
          reason,
          ...(estimatedPages != null ? { estimatedPages } : {}),
          ...(taskKind ? { taskKind } : {}),
        });
      } catch { /* fail-safe */ }

      try {
        const decision = await registerPendingPlanRequest(sessionId, requestId);
        if (decision?.approved) {
          return {
            content: [{
              type: 'text',
              text:
                'User APPROVED plan mode. Host has called query.setPermissionMode("plan"). '
              + 'Your next assistant turn will receive the Plan-mode system reminder. '
              + 'Follow nodesign-plan-instructions.md: integrate overall meta first '
              + '(tone/palette/metaphor via AskUserQuestion), then run the per-page brainstorm '
              + 'loop (each page: think → AskUserQuestion with preview → user feedback → '
              + '落 c_decisions → next page). When all pages aligned, call ExitPlanMode '
              + 'with the full design-plan.md content.',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text:
              'User DISMISSED the plan-mode request. Stay in current mode and continue '
            + 'the task as planned (Mode A — Stage 0 alignment + direct generate).',
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text:
              `request_plan_mode failed: ${err?.message || String(err)}. `
            + 'Continue current task without entering plan mode.',
          }],
          isError: true,
        };
      }
    },
  );
}
