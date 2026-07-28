/**
 * mcp/tools/list-pages.js — list_pages MCP tool
 *
 * 加载 canvas.html 用 playwright headless，扫所有 `<section data-page="N">`
 * 返回每页的元信息（index / layout / data-anchor / 标题 / bbox）。比 read_page
 * 轻 —— read_page 给整段 outerHTML，list_pages 只给每页 1 行摘要。
 *
 * 典型场景：agent 想知道"这 deck 有多少页 / 每页大致是什么主题"，做总览决策时调。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveDeckSize, extractDeckAspect } from '../../../shared/deck.js';
import {
  resolveCanvasTarget, CANVAS_PATH_DESC, KIND_SITE, listSitePages,
} from '../../../lib/artifact-target.js';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeListPagesTool({ workspaceRoot, sessionId, ctx: _ctx }) {
  return tool(
    'list_pages',
    `List the pages of the current artifact.

DECK — one entry per <section data-page="N">: { index, layout, anchor, title, bbox }.
SITE — one entry per html file in the task folder: { file, title, headings, links, bytes },
plus a broken internal-link report.
The tool figures out which kind it is; you do not pass it.

Use when:
- You want a quick overview before deciding what to change
- You need the page count (deck) or the site map (site)
- Verifying structure after a restructure

Lighter than read_page (which returns full outerHTML of one page).`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
    },
    async ({ path: relPath }) => {
      if (!workspaceRoot) {
        return {
          content: [{ type: 'text', text: 'No workspace bound; cannot list pages.' }],
          isError: true,
        };
      }
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };

      // 站点：「页」是独立文件，不是同一份文档里的 section。硬按 deck 那套扫
      // `section[data-page]` 会 0 命中，然后回一句"这份画布没有页面"—— 一个内容
      // 完整的站点会被 agent 读成空文件，这正是要避免的静默失败。
      if (target.kind === KIND_SITE && target.taskDir) {
        return listSiteStructure(target);
      }

      const canvasPath = target.absPath;
      let html;
      try {
        html = await fs.readFile(canvasPath, 'utf8');
      } catch {
        return { content: [{ type: 'text', text: `${target.relPath} not found in workspace.` }], isError: true };
      }
      const dims = resolveDeckSize(extractDeckAspect(html));

      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: dims.width, height: dims.height } });
        await page.goto(`file://${canvasPath}`, { waitUntil: 'networkidle', timeout: 15000 });

        const pages = await page.$$eval('section[data-page]', (sections) => {
          return sections.map((s, i) => {
            const r = s.getBoundingClientRect();
            const idxAttr = s.getAttribute('data-page');
            const heading = s.querySelector('h1, h2, h3, h4');
            return {
              index: idxAttr ? parseInt(idxAttr, 10) : (i + 1),
              layout: s.getAttribute('data-layout') || null,
              anchor: s.getAttribute('data-anchor') || null,
              title: heading ? (heading.textContent || '').trim().slice(0, 100) : null,
              bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
            };
          });
        });

        if (pages.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `${target.relPath} has no <section data-page="N"> elements.`,
            }],
          };
        }

        // Thumbnail hint：thumbnails 目录存在时 prepend 让 agent 知道 preview vs 真实 src 差别
        let thumbnailHint = '';
        try {
          await fs.access(path.join(workspaceRoot, 'assets', 'generated', '.thumbnails'));
          thumbnailHint = '[hint] N 页摘要中若含 image url，preview iframe 加载的是 thumbnail 快照；'
            + 'HTML 文件中的 src 是真实路径（同 Read canvas.html）。\n\n';
        } catch { /* no thumbnails dir */ }

        return {
          content: [{
            type: 'text',
            text: `${thumbnailHint}${pages.length} page(s):\n\n${JSON.stringify(pages, null, 2)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `list_pages failed: ${err?.message || String(err)}` }],
          isError: true,
        };
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* ignore */ }
        }
      }
    },
  );
}

/**
 * 站点结构：任务目录里每个 html 一条，带标题 / 小标题 / 站内外链接 / 体积。
 *
 * 纯文本解析，不开 playwright —— 站点是多文件，逐个起浏览器既慢又没必要；
 * agent 要的是"这站有哪些页、彼此怎么连"，那是源码里就有的信息。
 * 顺带查断链：站内链接指到不存在的文件是站点最常见、也最容易漏的错。
 */
async function listSiteStructure(target) {
  const pages = await listSitePages(target.taskDir);
  if (pages.length === 0) {
    return {
      content: [{ type: 'text', text: `${target.task} 是站点任务，但目录里还没有 html 页面。` }],
    };
  }
  const out = [];
  for (const rel of pages) {
    let raw = '';
    try { raw = await fs.readFile(path.join(target.taskDir, rel), 'utf8'); } catch { continue; }
    const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const headings = [...raw.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
      .map(m => m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 8);
    const links = [...new Set([...raw.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
      .map(m => (m[1] || m[2]).trim())
      .filter(Boolean))];
    const internal = links.filter(h => !/^(?:[a-z][a-z0-9+\-.]*:|\/\/|#)/i.test(h));
    const stylesheets = [...new Set(
      [...raw.matchAll(/<link\b[^>]*?href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
        .filter(m => /stylesheet/i.test(m[0]))
        .map(m => m[1] || m[2]),
    )];
    out.push({
      file: rel,
      title: titleM ? titleM[1].replace(/\s+/g, ' ').trim().slice(0, 100) : null,
      headings,
      internalLinks: internal,
      externalLinkCount: links.length - internal.length,
      stylesheets,
      bytes: Buffer.byteLength(raw),
    });
  }

  const known = new Set(pages);
  const broken = [];
  for (const p of out) {
    for (const href of p.internalLinks) {
      const clean = href.split('#')[0].split('?')[0];
      if (!clean || !/\.html?$/i.test(clean)) continue;
      const dir = p.file.includes('/') ? p.file.slice(0, p.file.lastIndexOf('/') + 1) : '';
      const stack = [];
      for (const seg of (dir + clean).split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') stack.pop();
        else stack.push(seg);
      }
      if (!known.has(stack.join('/'))) broken.push(`${p.file} → ${href}`);
    }
  }
  const brokenNote = broken.length
    ? `\n\n⚠️ 站内链接指向不存在的页面（${broken.length} 条）：\n${broken.map(b => `- ${b}`).join('\n')}`
    : '';

  return {
    content: [{
      type: 'text',
      text: `站点 ${target.task} · ${out.length} 个页面（入口 ${pages[0]}）：\n\n`
        + `${JSON.stringify(out, null, 2)}${brokenNote}`,
    }],
  };
}
