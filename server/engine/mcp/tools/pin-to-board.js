/**
 * mcp/tools/pin-to-board.js — pin_to_board MCP tool（2026-07-27 分区画布）
 *
 * agent 协助整理工作台：把一个产物/文档/deck 摆进某个工作区（zone）。
 * 写 shared/board.json（board-store 单锁原子操作，与前端 PATCH 互不覆盖），
 * 然后广播 board.updated（sessionId: null → project 全连接都收到，前端整份重拉）。
 *
 * 物件 id 约定（与前端 BoardCanvas 派生一致）：
 *   - 产物文件：'assets/...'（generated/ notes/ 上传件都在 shared/assets 下）
 *   - 项目文档：'doc:_root'（agent-memory/memory.md）/ 'doc:brand'
 *   - deck：'deck:<sessionId>'
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { pinToZone } from '../../../projects/board-store.js';

/**
 * @param {object} deps
 * @param {string} [deps.sharedRoot]   project shared/ 根（校验文件存在用）
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]    默认目标工作区
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makePinToBoardTool({ sharedRoot, projectId, sessionId, ctx }) {
  return tool(
    'pin_to_board',
    `Place an item onto the project workbench board, inside a task zone. The
board is the user's spatial canvas: everything you generate (images, notes)
auto-appears in the current task's zone already — you do NOT need this tool
for your own outputs. Use it to deliberately organize or surface content:

- Pull a reference (an uploaded asset, the brand doc, an older deck's image)
  into the current task's zone so the user sees it alongside the work
- Restore something the user dragged away, when they ask for it back
- Tidy up: move an item into the zone of the session it belongs to

Item path forms accepted:
- 'assets/generated/<file>' / 'assets/notes/<file>.md' / 'assets/<file>' (uploads)
- 'agent-memory/memory.md' (project memory doc) / 'agent-memory/brand/memory.md' (brand doc)
- 'deck:<sessionId>' (a deck card)

The zone defaults to the current session's work zone (created if missing).`,
    {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe("Item to pin — see accepted path forms in the tool description"),
      zone: z
        .string()
        .optional()
        .describe("Target zone = a sessionId. Omit for the current session's zone."),
    },
    async ({ path: rawPath, zone }) => {
      try {
        if (!projectId) {
          return { content: [{ type: 'text', text: 'No project bound; cannot pin.' }], isError: true };
        }
        const zoneId = (zone && /^[A-Za-z0-9-]{8,64}$/.test(zone)) ? zone : sessionId;
        if (!zoneId) {
          return { content: [{ type: 'text', text: 'No target zone: pass `zone` (a sessionId) — this run has no session bound.' }], isError: true };
        }

        // 归一化成前端物件 id
        let objectId = String(rawPath).trim().replace(/^\.\//, '');
        if (objectId === 'agent-memory/memory.md') objectId = 'doc:_root';
        else if (objectId === 'agent-memory/brand/memory.md') objectId = 'doc:brand';
        else if (!objectId.startsWith('deck:') && !objectId.startsWith('doc:')) {
          if (/^(generated|notes)\//.test(objectId)) objectId = `assets/${objectId}`;
          if (!objectId.startsWith('assets/')) objectId = `assets/${objectId}`;
          if (objectId.includes('..')) {
            return { content: [{ type: 'text', text: 'Invalid path.' }], isError: true };
          }
          // 尽力校验文件存在，防钉一个不存在的物件（前端会当孤儿布局忽略）
          if (sharedRoot) {
            const abs = path.join(sharedRoot, objectId);
            try { await fs.access(abs); } catch {
              return {
                content: [{ type: 'text', text: `File not found under shared assets: ${objectId}. Check the path (accepted forms are in the tool description).` }],
                isError: true,
              };
            }
          }
        }

        const { zone: placedZone, placed } = await pinToZone(projectId, { objectId, zoneId });

        try {
          ctx?.emit?.({
            type: 'board.updated',
            sessionId: null,          // project 级广播：显式压掉 ctx 的 sessionId enrich
            objectId,
            zoneId,
            summary: `已把 ${objectId} 放进工作区`,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            text: `Pinned ${objectId} into zone ${zoneId}${placedZone.title ? ` (${placedZone.title})` : ''} at (${placed.x}, ${placed.y}). The user's board updates live.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `pin_to_board failed: ${err.message}` }], isError: true };
      }
    },
  );
}
