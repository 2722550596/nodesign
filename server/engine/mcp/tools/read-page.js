/**
 * mcp/tools/read-page.js — read_page MCP tool
 *
 * 让 agent 精确读 canvas.html 的某一页（`<section data-page="N">` 一段），
 * 不必每次 Read 整个 canvas.html 然后自己切片。
 *
 * 行为：
 *   - input: { page: number }（1-based，跟 data-page="N" 一致）
 *   - 找 canvas.html 里 `<section[^>]*data-page="N"[^>]*>...</section>` 一段
 *   - 返该段 outerHTML（含 attributes + 完整子树）
 *   - **Hybrid 范式扩展（2026-05-06）**：检测 `<script type="text/babel">` 存在
 *     时，section 里若有 `data-react-mount="xxx"` 或 React mount 用的 `id="xxx"`，
 *     额外 grep babel script 里 `getElementById('xxx')` 上下文 (±20 行) 一并返
 *     回——agent 想改 React 部分时不必再 Read 整个 babel script
 *   - 找不到该页 → isError + 列出当前 canvas.html 实际有哪些 page
 *   - canvas.html 不存在 → isError + 提示 agent 需要先 Write 创建
 *
 * 用 regex 而非 DOM parser：纯字符串匹配，避免 jsdom 等大依赖；
 * canvas.html 是 agent 自己写的，section 嵌套不会出现（约定每页是 sibling section）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveCanvasTarget, CANVAS_PATH_DESC, KIND_SITE, requireBrowsable,
} from '../../../lib/artifact-target.js';

/**
 * Thumbnail hint：检测 sectionHtml 是否含 `assets/generated/` 图 + thumbnails 目录存在
 * 返 prepend hint 字符串（无需 hint 时返空）。
 *
 * 让 agent 知道：preview iframe 加载的 <img src> 是 thumbnail 快照（GET /canvas
 * 路径透明改写），文件系统 / 这里返的 outerHTML 中 src 是真实 src，重生图后
 * thumbnail 自动更新。
 */
async function detectThumbnailHint(workspaceRoot, sectionHtml) {
  if (!workspaceRoot || !sectionHtml) return '';
  if (!/assets\/generated\//.test(sectionHtml)) return '';
  try {
    await fs.access(path.join(workspaceRoot, 'assets', 'generated', '.thumbnails'));
    return '[hint] preview iframe 加载的 <img src> 指向 thumbnail（assets/generated/.thumbnails/*.thumb.webp）；'
      + '下面 outerHTML 中的 src 是真实 src（同 Read 源文件），重生原图 N 秒内 thumbnail 自动更新。';
  } catch {
    return '';
  }
}

/**
 * Hybrid 范式：从 section html 抽 mount id（data-react-mount + id 双源），
 * 然后到 raw canvas.html 的 babel script 段里 grep `getElementById('<id>')` 上下文。
 *
 * 为什么取 ±20 行：覆盖 createRoot 调用 + 上方 component 函数定义大概率在这窗口内。
 * agent 拿到这段后能直接看到 "<MyComponent .../>" 的调用 + 定义，不需要再 Read。
 *
 * @param {string} raw 整个 canvas.html
 * @param {string} sectionHtml 当前 section outerHTML
 * @returns {Array<{ mountId: string, snippet: string, startLine: number }>}
 */
function extractReactMountSources(raw, sectionHtml) {
  // 1. 检测 hybrid（必有 babel script）
  if (!/<script[^>]*type=["']text\/babel["']/i.test(raw)) return [];

  // 2. 抽 section 里的 mount id —— data-react-mount 优先，id 兜底
  const mountIds = new Set();
  for (const m of sectionHtml.matchAll(/\bdata-react-mount\s*=\s*["']([^"']+)["']/gi)) mountIds.add(m[1]);
  for (const m of sectionHtml.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) mountIds.add(m[1]);
  if (mountIds.size === 0) return [];

  // 3. 抽出所有 <script type="text/babel">...</script> 段
  const babelBlocks = [...raw.matchAll(/<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (babelBlocks.length === 0) return [];

  // 用整个 raw 行号做参考，方便 agent 知道 babel 段大概在文件哪里
  const rawLines = raw.split('\n');
  const segments = [];

  for (const id of mountIds) {
    // 在每个 babel 段里找 getElementById('<id>') 调用
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`getElementById\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`, 'g');

    for (const block of babelBlocks) {
      const blockText = block[1];
      if (!re.test(blockText)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;

      // 找 block 在 raw 中的起始行
      const blockStartIdx = raw.indexOf(block[0]);
      const blockStartLine = blockStartIdx >= 0 ? raw.slice(0, blockStartIdx).split('\n').length : 1;

      // grep 行号（相对 block）
      const blockLines = blockText.split('\n');
      blockLines.forEach((line, i) => {
        if (line.includes(`getElementById('${id}')`) || line.includes(`getElementById("${id}")`)) {
          const start = Math.max(0, i - 20);
          const end = Math.min(blockLines.length, i + 21);
          const snippet = blockLines.slice(start, end).join('\n');
          segments.push({
            mountId: id,
            snippet,
            startLine: blockStartLine + start + 1,  // raw 文件行号
          });
        }
      });
      break;  // 一个 mount id 在第一个匹配的 block 找到就停（避免重复）
    }
  }

  return segments;
}

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeReadPageTool({ workspaceRoot, sessionId, ctx: _ctx }) {
  return tool(
    'read_page',
    `DECK ONLY. Read a specific page (a single \`<section data-page="N">\`) from the deck .html.

Use this instead of Read+Grep+offset/limit when you want to inspect or
reason about one specific page in detail. Returns the outerHTML of that
section (including attributes and full subtree).

**Hybrid mode**: when the deck has \`<script type="text/babel">\` blocks
(the Hybrid format from the deck starter canvas.template.html), this tool also
returns the corresponding React mount source code for any
\`data-react-mount\` / \`id\` attribute it finds in the section — so you
don't need to Read the whole babel script just to find the component
that renders to a mount point on this page.

When to use:
- "Show me what page 3 looks like in code" — read_page(3)
- Before editing page N — read_page(N) to see exact current markup
- Debugging why a specific page renders wrong

When NOT to use:
- Reading the whole deck structure → use Read on the deck .html with limit:50
  to see all section openings
- Finding a specific element across pages → use Grep
- the deck file doesn't exist yet (creating from scratch) → use Write directly
- sites: pages are separate files — Read them, or list_pages for the site map`,
    {
      page: z
        .number()
        .int()
        .min(1)
        .describe('Page number (1-based, matches data-page="N" attribute)'),
      path: z.string().optional().describe(CANVAS_PATH_DESC),
    },
    async ({ page, path: relPath }) => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot read page.' }],
            isError: true,
          };
        }

        const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
        if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };
        const notBrowsable = requireBrowsable(target);
        if (notBrowsable) return { content: [{ type: 'text', text: notBrowsable }], isError: true };
        const canvasPath = target.absPath;
        let raw;
        try {
          raw = await fs.readFile(canvasPath, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') {
            return {
              content: [{
                type: 'text',
                text: 'That deck file does not exist yet. Use Write to create it first '
                  + '(see SKILL.md for the section data-page="N" structure).',
              }],
              isError: true,
            };
          }
          throw err;
        }

        // 匹配 `<section ... data-page="<page>" ...>...</section>`
        // 双引号 / 单引号 / 不引号都接受。section 内不嵌套 section（约定）。
        const pageStr = String(page);
        const escaped = pageStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 三种 attribute quoting 尝试
        const patterns = [
          new RegExp(`<section\\b[^>]*\\bdata-page\\s*=\\s*"${escaped}"[^>]*>[\\s\\S]*?</section>`, 'i'),
          new RegExp(`<section\\b[^>]*\\bdata-page\\s*=\\s*'${escaped}'[^>]*>[\\s\\S]*?</section>`, 'i'),
          new RegExp(`<section\\b[^>]*\\bdata-page\\s*=\\s*${escaped}\\b[^>]*>[\\s\\S]*?</section>`, 'i'),
        ];

        let match = null;
        for (const re of patterns) {
          const m = raw.match(re);
          if (m) { match = m; break; }
        }

        if (!match) {
          // 列出 canvas.html 里实际有哪些 page，给 agent 反馈
          const allPages = [...raw.matchAll(/<section\b[^>]*\bdata-page\s*=\s*['"]?(\d+)/gi)]
            .map(m => m[1])
            .filter((v, i, arr) => arr.indexOf(v) === i);
          // 站点：分页读根本不适用，直说该怎么做，别丢一句"没有分页结构"让 agent
          // 自己猜（它多半会改用 Read 全文件，把整份站点灌进上下文）
          if (target.kind === KIND_SITE) {
            return {
              content: [{
                type: 'text',
                text: `${target.relPath} 是站点页面，没有 <section data-page="N"> 分页，read_page 的页码语义不适用。\n`
                  + '站点这样读：先 list_pages 看站点结构（每页的标题 / 小标题 / 站内链接 / 断链），'
                  + '要看某一页的实际内容用 query_elements 按 selector 取，或者直接 Read 那个文件（站点页面通常不大）。',
              }],
              isError: true,
            };
          }
          const pagesList = allPages.length > 0
            ? `Available pages: ${allPages.join(', ')}`
            : `${target.relPath} has no <section data-page="N"> structure.`;
          return {
            content: [{
              type: 'text',
              text: `Page ${page} not found in ${target.relPath}. ${pagesList}`,
            }],
            isError: true,
          };
        }

        const sectionHtml = match[0];

        // Hybrid 范式扩展：检测 babel script + section 里的 mount id
        // 找到 mount id 后从 babel script 抓 ±20 行上下文返给 agent
        const hybridSegments = extractReactMountSources(raw, sectionHtml);

        // Thumbnail hint：section 含 assets/generated/ 图 + thumbnails 目录存在 → prepend hint
        const thumbnailHint = await detectThumbnailHint(workspaceRoot, sectionHtml);

        const parts = [];
        if (thumbnailHint) parts.push(thumbnailHint + '\n\n');
        parts.push(`Page ${page} (${sectionHtml.length} chars):\n\n${sectionHtml}`);
        if (hybridSegments.length > 0) {
          parts.push(
            `\n\n--- React mount sources for this page (${hybridSegments.length} mount${hybridSegments.length > 1 ? 's' : ''}) ---\n`
            + hybridSegments.map(({ mountId, snippet, startLine }) =>
                `\n## mount: ${mountId} (babel script line ~${startLine})\n\n\`\`\`tsx\n${snippet}\n\`\`\``
              ).join('\n')
          );
        }

        return {
          content: [{
            type: 'text',
            text: parts.join(''),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `read_page failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
