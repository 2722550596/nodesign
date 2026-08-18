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
import { setActiveDeck } from '../../../lib/artifact-target.js';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { taskManifest } from '../../../lib/kinds/index.js';

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makePreviewDeckTool({ ctx, sessionId, workspaceRoot }) {
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
          "Deck to show, workspace-relative (e.g. 'canvas.html' or '稿件/主稿.html'). Omit for the active artifact.",
        ),
    },
    async ({ path: rawPath }) => {
      try {
        const p = typeof rawPath === 'string' ? rawPath.trim().replace(/^\.\//, '') : '';
        // 绝对路径同拒：这个 path 直发前端当寻址依据（home 幽灵族的家规）
        if (p.includes('..') || p.startsWith('/')) {
          return { content: [{ type: 'text', text: 'Invalid path (workspace-relative only).' }], isError: true };
        }
        // ⭐ 2026-08-18：先查这个文件在不在。
        // 以前这里只挡 `..` 和绝对路径，然后无条件 emit + 回一句 "Opened …"。
        // 传一个不存在的路径、或者传站点的子页时，用户桌面上打开的是**本会话的
        // 空 canvas.html**，而 agent 拿到的是成功 —— 它没有任何办法察觉用户
        // 正对着一块空白（问题库 iss_msr8oki7_z9su：「静默成功是最伤的部分」）。
        let siteNote = null;
        if (p) {
          const abs = nodePath.join(workspaceRoot || '', p);
          try {
            await fs.access(abs);
          } catch {
            return {
              content: [{ type: 'text', text:
                `path not found: ${p} —— 先写出这个文件，或者用 list_pages 看清楚现有产物。`
                + '（没有打开任何东西，用户桌面没变。）' }],
              isError: true,
            };
          }
          // 站点的子页：站点是整站一扇窗，打开的是站不是那一页 —— 如实说
          try {
            const manifest = await taskManifest(workspaceRoot);
            const site = (manifest?.artifacts || []).find(a => a.kind === 'site' && !a.single
              && (a.root ? p.startsWith(`${a.root}/`) : true));
            if (site && p !== (site.entryRel || 'index.html')) {
              // 2026-08-18 起子页**真的**开在那一页上（前端 entry 一路传到 SiteWindow）。
              // 但只有在产物清单认得这一页时才成立 —— 不在清单里（比如刚写出来还没
              // 重拉）就还是退回入口，所以这句话要如实分两种说。
              const known = (site.pages || []).includes(
                site.root ? p.slice(site.root.length + 1) : p);
              siteNote = known
                ? `打开的是站点「${site.root || '工作区根'}」并停在 ${p} 这一页（整站一扇窗，用户可以在窗里翻别的页）。`
                : `注意：${p} 还不在这个站的页面清单里（产物列表下次重拉才认它），`
                  + `所以用户看到的是入口 ${site.entryRel || 'index.html'}。`
                  + '站内给它加一条真链接，或者等一轮再试。';
            }
          } catch { /* manifest 读不出来不挡预览 */ }
          setActiveDeck(sessionId, p);   // 摊给用户看的那份就是"当前 deck"
        }
        ctx?.emit?.(Events.deckPreview(p));
        return {
          content: [{
            type: 'text',
            text: [
              p ? `Opened ${p} on the user's workbench.`
                : "Opened this session's deck on the user's workbench.",
              siteNote,
            ].filter(Boolean).join('\n'),
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
