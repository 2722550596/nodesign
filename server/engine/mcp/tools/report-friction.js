/**
 * mcp/tools/report-friction.js — report_friction MCP tool
 *
 * agent 主动报 harness 层面的摩擦：工具缺了个参数、返回的东西不合用、
 * 为了绕过某个限制多走了几步、某个工具的行为跟文档不一致。
 *
 * 跟自动层（PostToolUseFailure → issues 表 source='auto'）的分工：
 *   自动层记"发生了什么"——某工具失败 N 次，不依赖 agent 自觉，但指不出修法。
 *   这一层补"为什么难受、期望怎样"——一条 "screenshot 超时 12 次" 没有信息量，
 *   一条 "截长站点页时我只想要首屏，但只能 fullPage 然后自己裁" 才指向修法。
 *
 * 措辞上刻意压住"遇到困难就上报"的倾向：上报**不是**绕路的替代品。工具描述里
 * 写死"照常把活儿干完，顺手记一笔"，否则 agent 会变成遇事先上报再糊弄过去，
 * 还给自己一个交代。
 *
 * 同类摩擦按指纹聚合累加，不是刷一万条重复。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { recordIssue, signatureOf } from '../../../lib/issues-store.js';
import { getProject } from '../../../projects/store.js';

/**
 * @param {object} deps
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeReportFrictionTool({ projectId, sessionId, ctx }) {
  return tool(
    'report_friction',
    `Report friction in the HARNESS — the tools and environment you work in — so it
can be fixed. This goes to the maintainer's issue list, not to the user.

Report when:
- A tool is missing a parameter you needed, or returns more/less than is useful
- You had to work around something more than once (the workaround IS the report)
- A tool's behaviour contradicts its description
- Something failed in a way the error message did not explain
- You notice you have been doing something tedious that the harness could do

This is NOT a substitute for doing the work. Finish the task the way you would
have anyway — route around the problem, deliver the result — and log this on the
side. Never report and then hand back less than you could have.

Do NOT report:
- Your own mistakes (wrong path, malformed edit) — that is not harness friction
- One-off flakes that a retry fixed
- Anything about the design work itself (that belongs in the conversation)

Be concrete. "screenshot is slow" is useless. "screenshot_canvas on a 6000px site
page takes ~14s and returns an image too large to read, so I crop by hand every
time; a viewportOnly flag would remove the whole detour" is actionable.`,
    {
      summary: z.string().min(8).max(200)
        .describe('One line: what is wrong. Concrete, not "X is bad".'),
      detail: z.string().min(20).max(3000)
        .describe('What you were doing, what happened, and what you did instead (the workaround).'),
      expectation: z.string().min(10).max(1500)
        .describe('What would have removed the detour — a flag, a different return shape, a missing tool.'),
      toolName: z.string().max(80).optional()
        .describe('The tool involved, if it is about one (e.g. "mcp__nodesign__screenshot_canvas").'),
    },
    async ({ summary, detail, expectation, toolName }) => {
      try {
        const rec = recordIssue({
          source: 'agent',
          toolName: toolName || null,
          summary,
          detail,
          expectation,
          projectId,
          sessionId,
          userId: projectId ? getProject(projectId)?.ownerId : null,
          // 按"摘要 + 工具"归一化：同一个抱怨反复出现是累加计数，不是刷屏
          signature: signatureOf(`${toolName || ''}|${summary}`),
        });
        if (!rec) {
          return {
            content: [{ type: 'text', text: 'Could not write the report (logged server-side). Carry on with the task.' }],
            isError: true,
          };
        }
        try {
          ctx?.emit?.({ type: 'run.friction_reported', summary, toolName: toolName || null, count: rec.count });
        } catch { /* emit fail-safe */ }
        return {
          content: [{
            type: 'text',
            text: rec.count > 1
              ? `Logged (this is the ${rec.count}th time this one has come up). Now carry on and finish the task.`
              : 'Logged. Now carry on and finish the task.',
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `report_friction failed: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
