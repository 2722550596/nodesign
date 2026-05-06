/**
 * mcp/tools/request-plan-mode.js — request_plan_mode MCP tool
 *
 * 让 main agent 在跑到一半发现"这事儿挺复杂得先理一理"时，主动 emit 一个
 * "请求进 plan mode" 信号 → 前端 PlanRequestBanner 弹给用户 yes/no。
 *
 * 背景：
 *   Anthropic Claude Agent SDK 里 `permissionMode` 只能由 host（外部代码）
 *   通过 query.setPermissionMode() 切换，agent 看不到这个方法。所以"agent
 *   自决进 plan"必须走"agent → host signal → host setPermissionMode" 三段。
 *
 * 流程：
 *   1. agent 调 mcp__nodesign__request_plan_mode({reason, estimatedPages?})
 *   2. handler emit 'run.plan_mode_requested' 给前端
 *   3. 前端 PlanRequestBanner 弹横幅显 reason，用户 yes/no
 *   4. yes  → POST /api/projects/:pid/runs/:runId/permission-mode { mode:'plan' }
 *      → SDK 切 plan mode → 下一 turn agent 通过 system reminder 收到提示，
 *      按 plan-instructions.md 写 plan + 调 ExitPlanMode
 *   5. no   → 前端单纯 dismiss banner；agent 继续走非 plan 流程
 *      （MCP 工具 return text 已经告诉 agent "如果没收到 mode change 提示
 *      就当用户没批准，按原计划继续"）
 *
 * 不阻塞 agent：handler emit 完立即 return，agent 当前 turn 继续。SDK 在
 * setPermissionMode('plan') 后会在下一个 assistant message 注入 system
 * reminder（plan-mode preamble + ExitPlanMode protocol），agent 自然感知。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeRequestPlanModeTool({ ctx } = {}) {
  return tool(
    'request_plan_mode',
    `Request that the host switch this run into Plan Mode (read-only design
planning, ExitPlanMode required to leave). Use this when the user's brief is
complex enough that you want to align on a structured plan before any
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

EFFECT:
  Emits a 'run.plan_mode_requested' event. The user sees a banner with your
  reason and can approve or dismiss. If approved, the host calls
  query.setPermissionMode('plan') and you'll see a Plan-mode system reminder
  on your next assistant turn — at that point follow plan-instructions.md
  (write a plan, call ExitPlanMode). If dismissed, no notice arrives and you
  should just continue your current task without entering plan mode.

This tool returns immediately and does NOT block your turn. Keep working
unless / until you receive the Plan-mode system reminder.`,
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
    async ({ reason, estimatedPages, taskKind }) => {
      try {
        ctx?.emit?.({
          type: 'run.plan_mode_requested',
          reason,
          ...(estimatedPages != null ? { estimatedPages } : {}),
          ...(taskKind ? { taskKind } : {}),
        });
      } catch { /* fail-safe */ }

      return {
        content: [{
          type: 'text',
          text:
            'Plan-mode request emitted to user. Continue your current work. '
          + 'If the user approves, you\'ll receive a Plan-mode system reminder '
          + 'on the next assistant turn — at that point follow plan-instructions.md. '
          + 'If no reminder arrives within a turn or two, assume the user dismissed '
          + 'and proceed without entering plan mode.',
        }],
      };
    },
  );
}
