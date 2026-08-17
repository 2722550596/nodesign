/**
 * mcp/tools/build-docx.js — build_docx MCP tool（2026-08-17）
 *
 * 把 token 源文件构建成 .docx。
 *
 * ⭐**agent 拿到的是一条命令，不是一个构建系统。** 它写 JSON、调这个工具、
 * 然后 screenshot 看结果 —— 不需要知道 OOXML、不需要跑 node、不需要碰沙盒
 * 外的东西。（跟 h3box / publish_site 一个路子。）
 *
 * ⚠️ 构建完**不自动截图**：那会让每次构建都多花几秒和一张图的上下文。看不看
 * 由 agent 自己决定 —— 但返回文案里会催它去看，因为「做完看一眼」这条纪律在
 * docx 上比在网页上更要紧（没有 DOM 可查，眼睛是唯一的验收手段）。
 */

import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildFromSource, DocxSourceError } from '../../../lib/docx/build-from-source.js';
import { setActiveArtifact } from '../../../lib/artifact-target.js';
import { safeResolveRead, safeResolveWrite } from '../../../lib/safe-path.js';

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

export function makeBuildDocxTool({ workspaceRoot, sessionId }) {
  return tool(
    'build_docx',
    `Build a .docx from its token source file.

The token JSON is the source of truth; the .docx is a build output. Always edit
the JSON and rebuild — never hand-edit the .docx, or the next build silently
throws your edit away.

Source file shape:
  {
    "preset":  "公文",              // dictionary entry to start from (optional)
    "tokens":  { ... },             // overrides on top of the preset
    "content": [ {"t":"p","style":"Normal","text":"..."} ],
    "header":  "...", "footer": "..."   // optional
  }

Built-in dictionary entries: 办公标准 (plain Office look) / 公文 (GB/T 9704-2012
Chinese official document) / 学术论文 (Chinese academic). These are starting
points, not a menu — override tokens freely, or skip preset and supply the full
token table.

Block types: {"t":"p"} paragraph, {"t":"table"}, {"t":"pageBreak"}.

After building, LOOK AT IT with screenshot. A .docx has no DOM — rendering is
the only way to verify layout, and "it built without errors" says nothing about
whether it looks right.`,
    {
      source: z
        .string()
        .optional()
        .describe("Token source file, workspace-relative. Defaults to '文档.json'."),
      output: z
        .string()
        .optional()
        .describe("Output .docx path, workspace-relative. Defaults to the source name with a .docx extension."),
    },
    async ({ source, output }) => {
      const srcRel = (source || '文档.json').replace(/\\/g, '/');
      const outRel = (output || srcRel.replace(/\.json$/i, '.docx')).replace(/\\/g, '/');
      if (!/\.docx$/i.test(outRel)) return err(`输出得是 .docx，收到的是 ${outRel}`);

      // ⚠️ 词法检查挡不住软链：工作区里一个指向外面的 `out.docx` 软链，会让这个
      // 工具变成一个**绕过沙盒的任意写原语**（MCP 工具跑在 server 进程里，不在
      // bwrap 内）。读写判据不同，见 lib/safe-path.js。
      const srcAbs = await safeResolveRead(workspaceRoot, srcRel);
      if (!srcAbs) return err('源路径跑出工作区了');
      const outAbs = await safeResolveWrite(workspaceRoot, outRel);
      if (!outAbs) return err('产物路径跑出工作区了（目标是软链也会被拒 —— 顺着它写会覆盖工作区外的文件）');

      try {
        const r = await buildFromSource(srcAbs, outAbs);
        // 记成当前产物，这样后面 screenshot / 导出不传 path 也能找到它
        setActiveArtifact(sessionId, outRel, 'docx');
        return {
          content: [{
            type: 'text',
            text: `${outRel} 已构建 · ${(r.bytes / 1024).toFixed(1)}KB · ${r.blocks} 个块 · ${r.styles} 个样式`
              + `${r.preset ? ` · 起点「${r.preset}」` : ''}\n`
              + '现在 screenshot 看一眼。构建没报错**不等于**排版对了 —— '
              + '缩进、行距、层级、分页这些只有渲染出来才看得见。',
          }],
        };
      } catch (e) {
        if (e instanceof DocxSourceError) {
          return err(`${srcRel} 构建失败：${e.message}${e.detail ? `\n${e.detail}` : ''}`);
        }
        return err(`构建出错：${String(e.message || e).slice(0, 500)}`);
      }
    },
  );
}
