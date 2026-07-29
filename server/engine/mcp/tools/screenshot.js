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

// ── 页面诊断收集（2026-07-29）──
// 背景：agent 塞了 GSAP/Lenis CDN 却不知道有没有加载成功——截图上看不出来。
// 挂 4 个 playwright listener，截图 caption 里回传 console 错误 + 加载失败资源。
// 上限/截断防止一个疯狂报错的页面把 caption 撑爆。
const DIAG_MAX_ENTRIES = 15;
const DIAG_MAX_TEXT = 300;

export function attachPageDiagnostics(page) {
  const consoleEntries = [];   // { type, text }
  const failedRequests = [];   // { method, url, detail }
  const seenConsole = new Map();  // text → count（同文重复只记一条 + 计数）

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = String(msg.text() || '').slice(0, DIAG_MAX_TEXT);
    const prev = seenConsole.get(text);
    if (prev) { prev.count += 1; return; }
    const entry = { type, text, count: 1 };
    seenConsole.set(text, entry);
    if (consoleEntries.length < DIAG_MAX_ENTRIES) consoleEntries.push(entry);
  });
  page.on('pageerror', (err) => {
    const text = String(err?.message || err).slice(0, DIAG_MAX_TEXT);
    if (consoleEntries.length < DIAG_MAX_ENTRIES) {
      consoleEntries.push({ type: 'pageerror', text, count: 1 });
    }
  });
  page.on('requestfailed', (req) => {
    if (failedRequests.length >= DIAG_MAX_ENTRIES) return;
    failedRequests.push({
      method: req.method(),
      url: req.url().slice(0, DIAG_MAX_TEXT),
      detail: req.failure()?.errorText || 'failed',
    });
  });
  page.on('response', (res) => {
    if (res.status() < 400 || failedRequests.length >= DIAG_MAX_ENTRIES) return;
    failedRequests.push({
      method: res.request().method(),
      url: res.url().slice(0, DIAG_MAX_TEXT),
      detail: `HTTP ${res.status()}`,
    });
  });

  return {
    /** 汇成 caption 附加段。干净时给正向确认（"不知道有没有挂"跟"确认没挂"是两回事）。 */
    summary() {
      if (!consoleEntries.length && !failedRequests.length) {
        return 'console clean, all requests OK';
      }
      const lines = [];
      if (consoleEntries.length) {
        lines.push(`console (${consoleEntries.length}):`);
        for (const e of consoleEntries) {
          lines.push(`  [${e.type}] ${e.text}${e.count > 1 ? ` (×${e.count})` : ''}`);
        }
      }
      if (failedRequests.length) {
        lines.push(`failed requests (${failedRequests.length}):`);
        for (const f of failedRequests) {
          lines.push(`  ${f.method} ${f.url} — ${f.detail}`);
        }
      }
      return lines.join('\n');
    },
  };
}

/**
 * beforeShot 执行（2026-07-29）：截图环境不滚动 → ScrollTrigger/IO 入场动画永远
 * 不触发 → agent 为"能被截图"反过来阉割设计。给截图前跑一段交互的能力。
 *  - 'scrollToBottom'：分步滚到底再回顶（所有 scroll-linked 动画都触发过一遍）
 *  - 其他字符串：当 JS 片段在页面上下文执行（支持 await），5s 超时兜底
 */
export async function runBeforeShot(page, beforeShot) {
  if (!beforeShot) return null;
  try {
    if (beforeShot === 'scrollToBottom') {
      await page.evaluate(async () => {
        const doc = document.scrollingElement || document.documentElement;
        const step = Math.max(200, window.innerHeight * 0.8);
        for (let y = 0; y <= doc.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, doc.scrollHeight);
        await new Promise((r) => setTimeout(r, 250));
        window.scrollTo(0, 0);
      });
      // 回顶后给 reveal/settle 动画一点时间
      await page.waitForTimeout(400);
    } else {
      await Promise.race([
        page.evaluate(`(async () => { ${beforeShot} })()`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('beforeShot timeout (5s)')), 5000)),
      ]);
      await page.waitForTimeout(200);
    }
    return null;
  } catch (err) {
    // beforeShot 挂了不挡截图 —— 把错误带回 caption 让 agent 知道
    return `beforeShot error: ${err?.message || err}`;
  }
}

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

Returns: image content block (you see it directly via vision) plus a text caption
with size info AND page diagnostics: console errors/warnings and failed resource
loads (CDN scripts, fonts, images). "console clean, all requests OK" means your
CDN libs actually loaded — no more guessing whether GSAP/Lenis are alive.

beforeShot: the screenshot environment never scrolls, so scroll-linked animations
(ScrollTrigger, IntersectionObserver reveals) leave elements at opacity:0 and they
vanish from the shot. Pass beforeShot:"scrollToBottom" to scroll through the whole
page and back to top first — every scroll trigger fires, then the shot is taken.
Or pass a JS snippet (async/await OK) to click/hover/setup any state before capture.
Do NOT delete entrance animations just to make screenshots work — use beforeShot.

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
      beforeShot: z
        .string()
        .optional()
        .describe("Run before capture: 'scrollToBottom' scrolls through the page and back (fires all scroll-linked animations — ScrollTrigger / IntersectionObserver reveals), or pass a JS snippet evaluated in page context (await supported, 5s timeout). Errors don't block the shot, they're reported in the caption."),
      path: z
        .string()
        .optional()
        .describe(CANVAS_PATH_DESC),
    },
    async ({ viewport, fullPage, selector, pageIndex, detail, device, beforeShot, path: relPath }) => {
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
        const diag = attachPageDiagnostics(page);

        // 用 file:// scheme 加载 canvas.html
        // waitUntil: 'networkidle' 等所有外部 fetch（CDN 字体 / 图片）完成。
        // networkidle 超时不再整个失败 —— 慢 CDN / 长轮询页面照样截，超时记进诊断。
        let gotoNote = null;
        try {
          await page.goto(`file://${canvasPath}`, {
            waitUntil: 'networkidle',
            timeout: 15000,
          });
        } catch (err) {
          if (!/Timeout/i.test(String(err?.message))) throw err;
          gotoNote = 'networkidle not reached in 15s (slow/looping network activity) — captured anyway';
        }

        const beforeShotNote = await runBeforeShot(page, beforeShot);

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

        const captionParts = [
          `Screenshot of ${target.relPath} (layout ${vp.width}x${vp.height} @${rasterScale}x raster, ${captureMode}, ${(buf.length / 1024).toFixed(1)} KB)`,
        ];
        if (gotoNote) captionParts.push(gotoNote);
        if (beforeShotNote) captionParts.push(beforeShotNote);
        captionParts.push(diag.summary());

        return {
          content: [
            {
              type: 'text',
              text: captionParts.join('\n'),
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
