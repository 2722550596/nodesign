/**
 * mcp/tools/preview-deck.js — preview_deck MCP tool（2026-07-28）
 *
 * agent 主动把做好的 deck 摊到用户眼前：等价于用户在工作台上双击那张 deck 卡
 * ——收起态就展开成内嵌渲染，已经展开就开成画布内的最大化窗口。
 *
 * 实现：纯 emit run.deck_preview 事件（跟 navigate_to_page 同款控制层套路），
 * 路径归一在前端做（lib/stage.js 的 resolveObjectId 已经认得 tasks/<任务>/canvas.html
 * 和会话 cwd 的 canvas.html 两种形态）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Events } from '../../agent/events.js';
import { setActiveDeck } from '../../../lib/canvas-target.js';

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makePreviewDeckTool({ ctx, sessionId }) {
  return tool(
    'preview_deck',
    `Show a deck to the user on their workbench — the same thing that happens
when they double-click the deck card themselves: a collapsed card expands into
a live embedded preview, an already-expanded one opens as a maximized window
over the desktop.

Use this when:
- You just finished (or substantially changed) a deck and want the user to look
- The user asks "show me" / "let me see it"
- You're about to discuss a deck and want it on screen first

Do NOT use it to spam attention mid-work — one call when the thing is worth
looking at. This does not replace screenshot_canvas: that one is for **you** to
see the render, this one is for **the user**.`,
    {
      path: z
        .string()
        .optional()
        .describe(
          "Deck to show, e.g. 'tasks/<task folder>/canvas.html'. Omit for the current session's own canvas.html.",
        ),
    },
    async ({ path: rawPath }) => {
      try {
        const p = typeof rawPath === 'string' ? rawPath.trim().replace(/^\.\//, '') : '';
        if (p.includes('..')) {
          return { content: [{ type: 'text', text: 'Invalid path.' }], isError: true };
        }
        if (p) setActiveDeck(sessionId, p);   // 摊给用户看的那份就是"当前 deck"
        ctx?.emit?.(Events.deckPreview(p));
        return {
          content: [{
            type: 'text',
            text: p
              ? `Opened ${p} on the user's workbench.`
              : "Opened this session's deck on the user's workbench.",
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `preview_deck failed: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
