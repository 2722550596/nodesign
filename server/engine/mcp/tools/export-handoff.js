/**
 * mcp/tools/export-handoff.js — export_handoff MCP tool
 *
 * agent 觉得设计到了交付时机时主动调，把 canvas.html / spec.json /
 * assets / chat-history / README 打包成 handoff.zip。
 *
 * 复用 server/api/exports.js 的 buildHandoffZip pipeline，agent 端和
 * 用户按钮路径输出一致。
 *
 * 输出位置：写到 workspace/exports/handoff-<ts>.zip。agent 不能直接给
 * 用户文件，所以告诉用户路径，用户从前端 UI 看到 / 下载。
 *
 * 调用约定（agent 端）：
 *   mcp__nodesign__export_handoff
 *     notes?: string  可选记录"为什么这个时机交付"
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '../tool-shim.js';
import { z } from 'zod';
import { buildHandoffZip } from '../../../api/exports.js';
import { getProject, listRunsForProject } from '../../../projects/store.js';
import { resolveCanvasTarget, CANVAS_PATH_DESC } from '../../../lib/artifact-target.js';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {string} [deps.projectId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeExportHandoffTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }) {
  return tool(
    'export_handoff',
    `Build a handoff zip: the artifact's source, the assets it actually
references, and a README that says what it is, how to run it, and — for a
mock-data app — which backend endpoints the recipient needs to implement.

Use this when the work is done and the user wants to take it away. The point of
this package is that **someone else can pick the project up and keep building**;
it is not the "give me a pretty file to look at" path (that's the export menu's
PDF / single-page HTML).

The zip is written to workspace/exports/handoff-<timestamp>.zip. After building,
tell the user the path so they can download it via the UI.

Use this tool when:
- The artifact meets the brief and you've verified it (e.g., via screenshot_canvas)
- The user says "give me the files" / "package it up" / "I want to host this myself"

Do NOT use this tool when:
- The work is still in iteration
- The artifact doesn't exist yet (nothing has been written)`,
    {
      notes: z
        .string()
        .optional()
        .describe('Optional notes about why exporting now (gets logged but not in the zip)'),
      path: z.string().optional().describe(CANVAS_PATH_DESC),
    },
    async ({ notes, path: relPath }) => {
      try {
        let projectMeta = null;
        let runs = [];
        if (projectId) {
          try {
            projectMeta = getProject(projectId);
            runs = listRunsForProject(projectId);
          } catch { /* DB not available 或 project 已删 */ }
        }

        // 2026-07-28：这里以前少传了 sharedRoot（签名是 (sessionRoot, sharedRoot, opts)），
        // opts 被当成 sharedRoot —— 导出的 zip 里 assets 全空、元数据全 unknown。
        const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
        if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };
        const buf = await buildHandoffZip(workspaceRoot, sharedRoot || workspaceRoot, {
          projectId: projectMeta?.id || projectId || 'unknown',
          projectName: projectMeta?.name || 'design',
          skillId: projectMeta?.skillId,
          sessionId,
          runs,
          deckPath: target.relPath,
        });

        const exportDir = path.join(workspaceRoot, 'exports');
        await fs.mkdir(exportDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        // 名字不能再叫 relPath：它会遮蔽入参 relPath，而上面 resolveCanvasTarget
        // 已经读过那个入参 —— 同一个块里先读后声明 = TDZ，整个工具每次调用必炸
        const zipRel = `exports/handoff-${stamp}.zip`;
        const absPath = path.join(workspaceRoot, zipRel);
        await fs.writeFile(absPath, buf);

        try {
          ctx?.emit?.({
            type: 'run.export_built',
            format: 'handoff',
            path: zipRel,
            sizeBytes: buf.length,
            notes: notes || null,
          });
          // 打完包直接进用户的下载列表，不用他再去导出菜单里翻（2026-07-28）
          ctx?.emit?.({
            type: 'run.download_ready',
            url: `/api/projects/${encodeURIComponent(projectId || '')}`
              + `/sessions/${encodeURIComponent(sessionId || '')}`
              + `/exports/file/${encodeURIComponent(path.basename(zipRel))}`,
            filename: path.basename(zipRel),
            sizeBytes: buf.length,
            count: 1,
            note: notes || '工程交付包',
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            text: `Handoff zip built: ${zipRel} (${(buf.length / 1024).toFixed(1)} KB), deck = ${target.relPath}. `
              + `Tell the user the package is ready — they can download it from the UI's export menu.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Export handoff failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
