/**
 * mcp/tools/screenshot-url.js — screenshot_url MCP tool（2026-07-29）
 *
 * 对任意外部 URL 截图。诞生背景：explorer 找视觉参考只能 WebFetch 拿文本，
 * 再用文字向主 agent 转述"这个站是深色的、图占主导"—— 找视觉参考却看不见
 * 视觉。这个工具让 explorer / 主 agent 直接看到参考站长什么样。
 *
 * 安全：
 *   - 只放 http/https（file:// 会变成任意本地文件读取，硬拒）
 *   - 拒绝内网/环回/link-local 字面量（localhost / 127.* / 10.* / 172.16-31.* /
 *     192.168.* / 169.254.* / *.local / [::1]）—— explorer 会读不可信网页内容，
 *     prompt injection 不该能借它窥探内网服务。DNS rebinding 不在防御范围
 *     （截图只回图片，风险面已经很小）。
 *
 * 加载策略：外站经常永远到不了 networkidle（分析脚本长轮询），goto 超时不算
 * 失败 —— 部分渲染的参考图也比纯文字转述强，超时记进 caption。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { attachPageDiagnostics, runBeforeShot } from './screenshot.js';

const RASTER_SCALE = 0.6;
const DEVICE_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

const PRIVATE_HOST_RE = new RegExp(
  '^(localhost|0\\.0\\.0\\.0|127\\.|10\\.|192\\.168\\.|169\\.254\\.'
  + '|172\\.(1[6-9]|2[0-9]|3[01])\\.'
  + '|\\[::1\\]|\\[fc|\\[fd|\\[fe80)'
  , 'i',
);

function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, message: `not a valid URL: ${raw}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: `only http/https URLs are allowed (got ${u.protocol})` };
  }
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host) || host.endsWith('.local')) {
    return { ok: false, message: `refusing to screenshot private/internal address: ${host}` };
  }
  return { ok: true, url: u };
}

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeScreenshotUrlTool({ ctx } = {}) {
  return tool(
    'screenshot_url',
    `Take a screenshot of any external web page (http/https) and return it as an
image you can see via vision. THE tool for gathering visual design references —
when researching how other sites handle layout, typography, color, or imagery,
look at them instead of reading their HTML and imagining.

- device: render at a real device width (desktop=1440, tablet=834, mobile=390)
- fullPage=true captures the whole scrollable page (auto-scrolls first so
  lazy-loaded images and scroll reveals are triggered); default captures the
  first viewport only — usually enough to judge a site's character, and much
  cheaper in context
- The caption reports console errors / failed resources of the target page —
  ignore those unless they explain a broken-looking render.

External pages can be slow; if the network never settles the shot is taken
anyway after 12s and the caption says so. Only http/https and public hosts.`,
    {
      url: z.string().describe('The http/https URL to screenshot'),
      device: z
        .enum(['desktop', 'tablet', 'mobile'])
        .optional()
        .describe('Viewport width preset: desktop=1440 (default), tablet=834, mobile=390'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scrollable page (auto-scrolls through it first to trigger lazyload). Default false = first viewport only, much cheaper.'),
      detail: z
        .enum(['normal', 'high'])
        .optional()
        .describe("Raster detail. 'normal' (default) = 0.6x pixels, enough for layout/palette judgment. 'high' = full resolution, only when you must read small text."),
    },
    async ({ url: rawUrl, device, fullPage, detail }) => {
      const check = validateUrl(rawUrl);
      if (!check.ok) {
        return { content: [{ type: 'text', text: check.message }], isError: true };
      }

      const vp = DEVICE_VIEWPORTS[device || 'desktop'];
      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const rasterScale = detail === 'high' ? 1 : RASTER_SCALE;
        const page = await browser.newPage({ viewport: vp, deviceScaleFactor: rasterScale });
        const diag = attachPageDiagnostics(page);

        let gotoNote = null;
        try {
          await page.goto(check.url.href, { waitUntil: 'networkidle', timeout: 12000 });
        } catch (err) {
          // 超时（页面已部分渲染）→ 照截；真导航失败（DNS/refused）→ 报错
          if (!/Timeout/i.test(String(err?.message))) {
            return {
              content: [{ type: 'text', text: `Failed to load ${rawUrl}: ${err?.message || err}` }],
              isError: true,
            };
          }
          gotoNote = 'network never settled (12s) — captured current render state';
        }

        if (fullPage) {
          // 滚一遍触发 lazyload / scroll reveal，再回顶整页截
          await runBeforeShot(page, 'scrollToBottom');
        }
        const buf = await page.screenshot({ fullPage: fullPage === true, type: 'png' });

        try {
          ctx?.emit?.({
            type: 'run.screenshot_taken',
            sizeBytes: buf.length,
            viewport: vp,
            mode: `url=${check.url.hostname}`,
          });
        } catch { /* emit fail-safe */ }

        const title = await page.title().catch(() => '');
        const finalUrl = page.url();
        const captionParts = [
          `Screenshot of ${finalUrl}${title ? ` — "${title}"` : ''} (${device || 'desktop'} ${vp.width}x${vp.height} @${rasterScale}x, fullPage=${fullPage === true}, ${(buf.length / 1024).toFixed(1)} KB)`,
        ];
        if (gotoNote) captionParts.push(gotoNote);
        captionParts.push(diag.summary());

        return {
          content: [
            { type: 'text', text: captionParts.join('\n') },
            { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `screenshot_url failed: ${err?.message || String(err)}` }],
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
