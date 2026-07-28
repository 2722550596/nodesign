/**
 * mcp/tools/screenshot.js — screenshot_canvas MCP tool
 *
 * 用 playwright headless chromium 截当前 workspace 的 canvas.html，
 * 返回 image content block，agent 可以直接 vision 看自己写的设计。
 *
 * 调用约定（agent 端）：
 *   mcp__nodesign__screenshot_canvas
 *     viewport?: { width, height }   默认按 wrap data-deck-aspect（4 档预设）
 *     fullPage?: boolean              默认 true（完整可滚动页面）
 *     selector?: string               若给则截匹配的第一个元素 bbox（覆盖 fullPage）
 *     pageIndex?: number              若给则截 section[data-page="N"] 整页（覆盖 fullPage）
 *
 * 返回 CallToolResult：
 *   content: [
 *     { type: 'text', text: 'Screenshot of canvas.html ...' },
 *     { type: 'image', data: base64, mimeType: 'image/png' },
 *   ]
 *
 * 错误处理：
 *   - canvas.html 不存在 → 返回 isError: true + 文本提示
 *   - playwright 启动失败 → 返回 isError: true + 错误信息
 *   - 截图失败 → 同上
 *
 * 性能：
 *   每次调用 spawn 新 chromium ~1-2s。P0+ stage 2 上 pool（chromium
 *   常驻 + page.goto 切换）；这次接受。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveDeckSize, extractDeckAspect } from '../../../shared/deck.js';
import { resolveCanvasTarget, CANVAS_PATH_DESC, KIND_SITE } from '../../../lib/artifact-target.js';

// 截图光栅倍率：布局按 deck 逻辑尺寸，位图按这个倍率出（vision token 按像素计费）
const RASTER_SCALE = 0.6;

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
/** 站点断点档位（跟前端 web/src/lib/board-geometry.js 的 SITE_VIEWPORTS 对齐）*/
const SITE_DEVICE_W = { desktop: 1440, tablet: 834, mobile: 390 };

export function makeScreenshotCanvasTool({ workspaceRoot, sessionId, ctx }) {
  return tool(
    'screenshot_canvas',
    `Take a screenshot of the current canvas.html in this workspace and return it
as an image content block. Use this to visually inspect the design you wrote
— check spacing, contrast, hierarchy, layout, alignment.

Works for both artifact kinds; the tool detects which one you are on.

DECK — default viewport = the deck-aspect declared on canvas wrap (16:9 → 1920×1080,
9:16 → 1080×1920, 16:10 → 1920×1200, 4:3 → 1440×1080). Target one page with pageIndex.

SITE — there is no fixed aspect. Default viewport is desktop 1440×900 and the whole
page is captured (fullPage). Use the device param to check a breakpoint: desktop=1440,
tablet=834, mobile=390. **Checking mobile means rendering AT 390px wide**, not shrinking
a desktop shot — that is the only way to see whether your media queries actually fire.
pageIndex does not apply to sites; pass path to screenshot a specific page file.

**Targeting (cheapest → most expensive)**:
- pageIndex: capture only section[data-page="N"] — **prefer this for per-page checks** (~30-50KB image)
- selector: capture only the first element matching this CSS selector
- (default, no targeting): capture viewport only (~30-50KB)
- fullPage=true: capture full scrollable page — **N× more expensive for N-page deck**
  (~150-300KB for 9 pages). Only use for true deck-wide overview; otherwise prefer
  pageIndex loop or dispatch the vision-checker subagent (subagent context is
  isolated, your main context stays small).

Targeted captures (selector / pageIndex) override fullPage.

Returns: image content block (you see it directly via vision) plus a short
text caption with size info.

Use this tool when:
- You finished writing or editing canvas.html and want to verify it looks right
- The user asks "what does it look like" or "show me the result"
- You suspect a layout bug and want to see the rendered output
- You want a closeup of one specific page or element (use pageIndex / selector)

Do NOT use this tool when:
- canvas.html doesn't exist yet (write it first)
- You haven't actually changed the design since the last screenshot`,
    {
      viewport: z
        .object({
          width: z.number().int().min(320).max(3840),
          height: z.number().int().min(240).max(2160),
        })
        .optional()
        .describe('Browser viewport size; defaults to the deck-aspect declared on canvas wrap (16:9=1920×1080, 9:16=1080×1920, 16:10=1920×1200, 4:3=1440×1080)'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture full scrollable page instead of just viewport (default false — N× more expensive for N-page deck). Ignored if selector or pageIndex is given.'),
      selector: z
        .string()
        .optional()
        .describe('If given, capture only the first element matching this CSS selector (overrides fullPage)'),
      detail: z
        .enum(['normal', 'high'])
        .optional()
        .describe("Raster detail. 'normal' (default) renders at 0.6x pixels — ~45% cheaper in context, enough for layout/spacing/palette checks. 'high' = full resolution, use only when you must read small text."),
      pageIndex: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('DECK ONLY. If given, capture only section[data-page="N"] (overrides fullPage)'),
      device: z
        .enum(['desktop', 'tablet', 'mobile'])
        .optional()
        .describe('SITE ONLY. Render at a real device width to check responsive behaviour: desktop=1440, tablet=834, mobile=390. Ignored for decks.'),
      path: z
        .string()
        .optional()
        .describe(CANVAS_PATH_DESC),
    },
    async ({ viewport, fullPage, selector, pageIndex, detail, device, path: relPath }) => {
      // 任务模型（2026-07-28）：deck 住 tasks/<任务>/canvas.html。寻址统一走
      // canvas-target（显式 path → 本会话当前 deck → cwd/canvas.html → 唯一任务 deck）
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };
      const canvasPath = target.absPath;
      let html;
      try {
        html = await fs.readFile(canvasPath, 'utf8');
      } catch {
        return {
          content: [{ type: 'text', text: `${target.relPath} not found. Write it first before screenshotting.` }],
          isError: true,
        };
      }

      const isSite = target.kind === KIND_SITE;

      // 站点没有"比例"这回事：版面是被视口宽度算出来的，所以档位给的是真实设备
      // 宽度，直接当 viewport 用、不缩放。拿 deck 那套 1920×1080 去截站点，会得到
      // 一张"看起来还行"但跟任何真实设备都对不上的图 —— 断点有没有生效看不出来。
      const vp = viewport
        || (isSite
          ? { width: SITE_DEVICE_W[device || 'desktop'], height: 900 }
          : (() => { const d = resolveDeckSize(extractDeckAspect(html)); return { width: d.width, height: d.height }; })());

      if (isSite && pageIndex) {
        return {
          content: [{
            type: 'text',
            text: `${target.relPath} 是站点页面，没有 <section data-page="N"> 分页。`
              + '站点的"页"是独立文件：用 path 指定要截哪个页面（先 list_pages 看清单），'
              + '用 device 切换 desktop / tablet / mobile 检查断点。',
          }],
          isError: true,
        };
      }

      // 默认 false：fullPage 截图体积是 viewport 的 N× (N=页数)，且会留在 context
      // 多 turn 直到 autoCompact。agent 不显式传就走 viewport 单屏（cheapest），
      // 真要 deck-wide overview 显式 fullPage:true 或派 vision-checker。
      // 站点相反：默认整页 —— 网页本来就是长的，只截首屏等于没看过下面那些。
      const fp = fullPage !== undefined ? fullPage === true : isSite;

      let browser;
      try {
        // 动态 import：playwright 启动慢，模块顶部 import 会拖累其他工具
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        // 位图缩放（2026-07-28 上下文瘦身）：布局仍按 deck 逻辑尺寸排（1920 宽），
        // 但光栅按 RASTER_SCALE 出图。vision token 按像素算（≈ w*h/750），
        // 1920×1080 一张 ≈1.85k tokens，0.6 倍后 ≈1.0k，排版检查完全够看。
        // 要读小字（版权行 / 数据标签）显式传 detail:'high' 走 1.0。
        const rasterScale = detail === 'high' ? 1 : RASTER_SCALE;
        const page = await browser.newPage({ viewport: vp, deviceScaleFactor: rasterScale });

        // 用 file:// scheme 加载 canvas.html
        // waitUntil: 'networkidle' 等所有外部 fetch（CDN 字体 / 图片）完成
        await page.goto(`file://${canvasPath}`, {
          waitUntil: 'networkidle',
          timeout: 15000,
        });

        // selector / pageIndex 优先，命中则截元素 bbox（locator.screenshot），
        // 都不给走 fullPage / viewport。新范式所有 section 默认平铺可见
        // （系统 fit script 包 frame + scroll-snap），locator.screenshot 自动
        // 拿目标 section 的 bbox，不需要再操作 DOM。
        let buf;
        let captureMode;
        const targetSelector = selector
          || (pageIndex ? `section[data-page="${pageIndex}"]` : null);

        if (targetSelector) {
          const locator = page.locator(targetSelector).first();
          const count = await locator.count();
          if (count === 0) {
            return {
              content: [{
                type: 'text',
                text: `Selector matched no elements: ${targetSelector}`,
              }],
              isError: true,
            };
          }
          buf = await locator.screenshot({ type: 'png' });
          captureMode = `selector="${targetSelector}"`;
        } else {
          buf = await page.screenshot({ fullPage: fp, type: 'png' });
          captureMode = isSite
            ? `site ${device || 'desktop'} ${vp.width}px, fullPage=${fp}`
            : `fullPage=${fp}`;
        }

        // emit 让前端可见 agent 在自检
        try {
          ctx?.emit?.({
            type: 'run.screenshot_taken',
            sizeBytes: buf.length,
            viewport: vp,
            mode: captureMode,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [
            {
              type: 'text',
              text: `Screenshot of ${target.relPath} (layout ${vp.width}x${vp.height} @${rasterScale}x raster, ${captureMode}, ${(buf.length / 1024).toFixed(1)} KB)`,
            },
            {
              type: 'image',
              data: buf.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Screenshot failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* ignore close errors */ }
        }
      }
    },
  );
}
