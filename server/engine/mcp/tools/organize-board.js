/**
 * mcp/tools/organize-board.js —— organize_board（2026-08-14，用户提议）
 *
 * 画布语言的收纳动词：把散在桌面上的产物（生成图 / 文件 / 文件夹）归进
 * 文件夹。在这之前 agent 只能裸 Bash mv —— 能用，但它不知道搬家的画布语义
 * （id=路径，搬=换身份，关系线端点要跟着走），裸 mv 只靠每轮 commit 对账
 * 兜底，窗口期里剪枝器还可能把正在改名的东西连坐剪掉。
 *
 * 实现 = **和用户拖拽「移动到…」同一份核心**（projects/move-entry.js）：
 * 磁盘先行、画布身份同步、转发表记账，一个字不重写。
 *
 * 批量制（同 roll_film / paint_still）：≤16 件、串行、**中途失败即停**
 * （后面的不动，报告哪件停的）。目标夹不存在就建 —— 归纳常配新夹。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { moveEntry, MoveError } from '../../../projects/move-entry.js';
import { Events } from '../../agent/events.js';

export function makeOrganizeBoardTool({ projectId, ctx }) {
  return tool(
    'organize_board',
    `Tidy the workbench canvas: move artifacts (generated images, files, folders) into a folder. Same semantics as the user dragging a card into a folder — the file really moves on disk, and its canvas identity (position, relation lines) follows automatically.

Use for: grouping generated images into a folder, collecting a site's materials into <site>/assets/, un-cluttering the desktop root.
Not for: site/world roots as destination (they are artifacts, not storage — a site takes materials in its assets/ subfolder); notes/ (sticky notes live where they live).

Batch: up to 16 items, moved in order, stops at first failure.`,
    {
      items: z.array(z.string().min(1)).min(1).max(16)
        .describe('Workspace-relative paths to move (files or folders), e.g. ["assets/generated/a.png", "旧稿.html"]'),
      into: z.string()
        .describe('Destination folder (workspace-relative), e.g. "素材" or "观察日志/assets". Created if missing. "" = workspace root (un-nest).'),
    },
    async ({ items, into }) => {
      const lines = [];
      let moved = 0;
      for (const item of items) {
        try {
          const out = await moveEntry(projectId, item, into, { createFolder: true });
          moved += 1;
          lines.push(out.moved ? `✓ ${out.from} → ${out.to}` : `· ${out.from}（已在原地）`);
          if (out.moved) {
            try {
              // 补一发 file_changed（MCP 写盘不走 PostToolUse 直发）：前端产物
              // 清单重拉 + 在场精灵的挂账路径补射都吃这个
              ctx?.emit?.(Events.fileChanged(out.to, 'rename'));   // 工作区相对路径=正字法
            } catch { /* fail-soft */ }
          }
        } catch (err) {
          const why = err instanceof MoveError ? err.message : (err?.message || String(err));
          lines.push(`✗ ${item}：${why}`);
          lines.push(`（后面 ${items.length - moved - 1} 件没动 —— 修正后重调）`);
          break;
        }
      }
      try {
        if (moved > 0) ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `归纳了 ${moved} 件到 ${into || '桌面根'}` });
      } catch { /* fail-soft */ }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
