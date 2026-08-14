/**
 * mcp/tools/record-decision.js — record_decision MCP tool
 *
 * agent 在做关键设计决策时调，把"做了什么 + 为什么"写成任务便利贴
 * `tasks/<任务>/notes/决策.md` 的一面（`---` 分面）。2026-07-30 起决策
 * 不再进 spec.json.decisions[]：便利贴是 agent 和用户的**共享层**——
 * 用户在画布上直接看到、能翻、能改；spec.json 只是 agent 自己的暗档案，
 * 用户看不见，头脑风暴根本进不来。旧会话已有的 spec.json decisions[]
 * 仍被 hooks 注入（只读遗产），新决策一律走这里。
 *
 * 便利贴格式约定（前端 NoteSticker 按此渲染）：
 *   - 一个 .md = 一张贴；`\n---\n` 分面，翻页看
 *   - 每面第一行 `# 标题`
 *
 * 任务定位：活跃产物（artifact-target）所在任务优先，没有就取 tasks/ 下
 * 唯一的任务目录；都没有 → 报错让 agent 先建任务（决策必须有归属，写到
 * session 根用户在桌面上看不见，等于没记）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Events } from '../../agent/events.js';

const NOTE_FILE = '决策.md';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {string} [deps.sessionId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeRecordDecisionTool({ workspaceRoot, sessionId, ctx }) {
  return tool(
    'record_decision',
    `Record a key design decision as a face of the project's decision sticky note
(notes/决策.md). The note is SHARED with the user — it renders as
a flippable sticky on their canvas, they can read and edit it. Use this to
capture WHY you made a particular choice — color, type scale, layout metaphor,
copy strategy — so the intent survives across sessions and the user can push
back on it.

Use this tool when:
- You make a non-trivial choice that has multiple defensible alternatives
  (e.g., picking a primary color, deciding deck length, choosing a layout)
- The user gives feedback that changes a previous decision (record both)
- You want to document a constraint discovered mid-work

Do NOT use this tool for:
- Trivial implementation details (CSS class names, file structure)
- Things obvious from the canvas itself (the visible design speaks for itself)
- Every change — over-recording bloats the note and dilutes signal

For free-form shared notes (brainstorm material, reference digests, handoff
context), just Write notes/<slug>.md directly — same sticky-note
rendering, no tool needed.`,
    {
      title: z
        .string()
        .min(2)
        .max(200)
        .describe('Short decision title (e.g., "Primary color = #3366FF")'),
      rationale: z
        .string()
        .min(2)
        .max(2000)
        .describe('Why this choice — connect to brief / user feedback / design principle'),
      scope: z
        .string()
        .optional()
        .describe('Where it applies (e.g., "Global", "Cover page", "All H1 headings")'),
      alternatives: z
        .array(z.string())
        .optional()
        .describe('Alternatives considered, briefly noting why rejected'),
    },
    async ({ title, rationale, scope, alternatives }) => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot record decision.' }],
            isError: true,
          };
        }
        const alts = Array.isArray(alternatives)
          ? alternatives.map(s => String(s).trim()).filter(Boolean) : [];
        const face = [
          `# ${title.trim()}`,
          '',
          rationale.trim(),
          ...(scope ? ['', `- 范围：${scope.trim()}`] : []),
          ...(alts.length ? [`- 备选：${alts.join(' / ')}`] : []),
          `- ${new Date().toISOString().slice(0, 10)}`,
        ].join('\n');

        const notesDir = path.join(workspaceRoot, 'notes');
        await fs.mkdir(notesDir, { recursive: true });
        const noteFile = path.join(notesDir, NOTE_FILE);
        let prev = '';
        try { prev = await fs.readFile(noteFile, 'utf8'); } catch { /* 首条 */ }
        const next = prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n---\n\n${face}\n` : `${face}\n`;
        await fs.writeFile(noteFile, next, 'utf8');

        const faceCount = next.split(/\n---\n/).length;
        try {
          // MCP 工具写盘不走 PostToolUse(Write/Edit) 那条 file_changed 直发，
          // 自己补一发，前端便利贴才会当场刷新
          ctx?.emit?.(Events.fileChanged(noteFile, 'change'));
          ctx?.emit?.({
            type: 'run.decision_recorded',
            title: title.trim(),
            scope: scope?.trim() || null,
            decisionsCount: faceCount,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            // ⚠️ 这里曾写 `tasks/${task}/...` —— 扁平化删掉 task 变量时漏了这行，
            // `task` 成悬空引用：决策照写、事件照发，**返回时 ReferenceError 被
            // 外层 catch 接住**，agent 每次调用都收到报错以为失败（还可能重试出
            // 重复面）。悬空引用潜伏族第二案（第一案 reloadToken，2026-08-08）。
            text: `Decision recorded as face ${faceCount} of notes/${NOTE_FILE}: "${title.trim()}"`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Record decision failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
