/**
 * mcp/tools/profile-scroll.js — profile_scroll（2026-08-18）
 *
 * ## 为什么有这个工具
 *
 * 用户说"往下滑动一顿一顿的"，这在设计工具里是最常见的反馈之一。而在这之前
 * 平台给 agent 的全部观测能力是「截一张静态图」—— 帧时、掉帧、图片体积、
 * 长任务一个都看不到。一个 agent 的实际绕路是：起 `python3 -m http.server`
 * → 从仓库 node_modules 直接 import playwright → 手写 rAF 采样器 → 逐项关掉
 * 嫌疑元素做 A/B。它量出来的结论一个都猜不出来：基线 63% 掉帧，单独关视差
 * 64%（没用），单独关全屏胶片颗粒层 40%，两个都关 5% —— 是**叠加效应**，
 * 真凶是「33.7MB 的 PNG + 一个带 mix-blend-mode 的全屏 fixed 层」这对组合。
 * 没有测量，它大概率只会把用户新抱怨的那个功能拆掉交差，剩下 40% 的掉帧
 * 原封不动留在站里。
 *
 * ## 数字怎么读
 *
 * ⚠️ 这台机器 1 vCPU，而且截图 worker 跟 server 抢同一颗核。**绝对值不代表
 * 用户设备上的体验**，它的用处是 A/B：改一处、再量一次、看方向。返回文本里
 * 会重复这句话，别让 agent 拿绝对数字去跟用户汇报。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveCanvasTarget, CANVAS_PATH_DESC, requireBrowsable } from '../../../lib/artifact-target.js';
import { openArtifactPage, FIDELITY_LAUNCH_ARGS } from './helpers/perception-page.js';

const DEVICE_W = { desktop: 1440, tablet: 834, mobile: 390 };
const DEVICE_H = { desktop: 900, tablet: 1112, mobile: 844 };

/**
 * 页面里跑的采样器：**连续**滚一遍 + 逐帧记 rAF 间隔 + 收长任务 + 收图片资源。
 *
 * ⚠️ 第一版是「大跨步 + 每步 sleep 60ms」，结果**测不出坏情况**：合成器在步与
 * 步之间有空闲，一个装了 backdrop-filter + mix-blend-mode 全屏层的页面照样报
 * 3% 掉帧。用户不是这么滚的 —— 他是连续滚。所以滚动动作必须**放进 rAF 里逐帧
 * 小步推**，这才是"每一帧都要重新合成一次"的真实压力。
 * （量具本身要先验一遍：拿一个故意做坏的页面确认它能报警，再信它说的"好"。）
 */
/* eslint-disable no-undef */
function samplerSource(perFrame, maxFrames) {
  return async () => {
    const frames = [];
    const longTasks = [];
    let po = null;
    try {
      po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); });
      po.observe({ entryTypes: ['longtask'] });
    } catch { /* 不支持就没有长任务数据 */ }

    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    await new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      const tick = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        n += 1;
        window.scrollBy(0, perFrame);
        if (n >= maxFrames || window.scrollY >= maxY - 1) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await new Promise(r => setTimeout(r, 120));
    try { po?.disconnect(); } catch { /* */ }

    const imgs = performance.getEntriesByType('resource')
      .filter(e => e.initiatorType === 'img' || /\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/i.test(e.name))
      .map(e => ({ name: e.name.split('/').pop().slice(0, 60), bytes: e.transferSize || e.encodedBodySize || 0 }));
    imgs.sort((a, b) => b.bytes - a.bytes);

    return {
      frames: frames.slice(2),                       // 头两帧含启动抖动
      longTasks,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      reachedY: window.scrollY,
      imgCount: imgs.length,
      imgBytes: imgs.reduce((a, b) => a + b.bytes, 0),
      topImgs: imgs.slice(0, 5),
      layers: (() => {
        // 「合成层嫌疑」：全屏定位 + 带混合模式/滤镜/半透明的那些，
        // 就是那个真实案例里的另一半凶手
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const r = el.getBoundingClientRect();
          const big = r.width * r.height > window.innerWidth * window.innerHeight * 0.5;
          const heavy = cs.mixBlendMode !== 'normal' || cs.filter !== 'none'
            || cs.backdropFilter !== 'none' || (cs.opacity !== '1' && cs.opacity !== '');
          if (big && heavy) {
            const id = el.id ? `#${el.id}` : (typeof el.className === 'string' && el.className.trim()
              ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase());
            out.push(`${id} [${cs.position}, blend=${cs.mixBlendMode}, filter=${cs.filter === 'none' ? '-' : 'yes'}, backdrop=${cs.backdropFilter === 'none' ? '-' : 'yes'}, opacity=${cs.opacity}]`);
          }
          if (out.length >= 5) break;
        }
        return out;
      })(),
    };
  };
}
/* eslint-enable no-undef */

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const kb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`);

export function makeProfileScrollTool({ workspaceRoot, projectId, sessionId }) {
  return tool(
    'profile_scroll',
    `Measure how a page actually performs while scrolling. Loads it over http
(same origin as the user preview), scrolls programmatically, and returns frame
timing, dropped-frame ratio, long tasks, total image bytes and the heaviest
images, plus any full-screen fixed/sticky layers with blend modes or filters.

Use this the moment a user says scrolling feels heavy, janky, laggy or "one
frame at a time" — do NOT start deleting features to guess which one it is.
The one real case on record: baseline 63% dropped frames; killing the parallax
alone changed nothing (64%); killing the full-screen grain layer alone got it to
40%; killing both got 5%; hiding images got 3%. It was an additive effect
between 33.7MB of PNGs and one blended full-screen layer. Guessing would have
removed the wrong thing and left most of the jank in place.

Also worth running before you hand over any image-heavy page: total image bytes
is the single most common cause, and generate_image now writes a .webp sibling
next to every PNG for exactly this reason.

⚠️ This machine has 1 vCPU and the browser competes with the server for it. The
absolute numbers are NOT what the user's device will see. Use them for A/B:
measure, change one thing, measure again, compare direction. Never report the
raw percentage to the user as if it were their experience.`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
      device: z.enum(['desktop', 'tablet', 'mobile']).optional()
        .describe('Viewport preset (default desktop 1440×900). Mobile is where jank shows up worst.'),
      frames: z.number().int().min(30).max(300).optional()
        .describe('How many animation frames to scroll across (default 120 ≈ a 2-second continuous scroll). The scroll advances inside requestAnimationFrame, one small step per frame — that is what a real scroll does to the compositor.'),
    },
    async ({ path: relPath, device, frames: framesArg }) => {
      const asText = (text) => ({ content: [{ type: 'text', text }] });
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target) return { content: [{ type: 'text', text: 'No page found to profile.' }], isError: true };
      const guard = requireBrowsable(target);
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

      const dev = device || 'desktop';
      const viewport = { width: DEVICE_W[dev], height: DEVICE_H[dev] };
      const nFrames = framesArg ?? 120;

      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true, args: FIDELITY_LAUNCH_ARGS });
        const opened = await openArtifactPage(browser, {
          projectId, workspaceRoot, absPath: target.absPath, viewport,
        });
        await opened.goto();
        const page = opened.page;

        const docH = await page.evaluate(() => document.documentElement.scrollHeight);
        // 逐帧推进量：把整页在 nFrames 帧里滚完（默认 120 帧 ≈ 2 秒连续滚动）。
        // 下限 6px —— 太小的话短页面滚不到底，样本全是静止帧。
        const perFrame = Math.max(6, Math.round((docH - viewport.height) / nFrames));
        const r = await page.evaluate(
          `(${samplerSource.toString()})(${perFrame}, ${nFrames})()`,
        );

        const frames = r.frames.filter(f => f > 0 && f < 2000);
        const dropped = frames.filter(f => f > 16.7 * 1.5).length;
        const dropRatio = frames.length ? (dropped / frames.length) * 100 : 0;

        const lines = [
          `profile_scroll — ${target.relPath} @ ${dev} ${viewport.width}×${viewport.height}`,
          `page height ${r.scrollHeight}px, continuous scroll ${perFrame}px/frame, reached y=${Math.round(r.reachedY)}`,
          '',
          `frame time  p50 ${pct(frames, 50).toFixed(1)}ms  p90 ${pct(frames, 90).toFixed(1)}ms  p99 ${pct(frames, 99).toFixed(1)}ms  (16.7ms = 60fps)`,
          `dropped     ${dropRatio.toFixed(0)}% of ${frames.length} frames took >25ms`,
          `long tasks  ${r.longTasks.length}${r.longTasks.length ? ` (worst ${Math.max(...r.longTasks).toFixed(0)}ms)` : ''}`,
          '',
          `images      ${r.imgCount} files, ${kb(r.imgBytes)} total`,
          ...(r.topImgs.length
            ? [`heaviest    ${r.topImgs.map(i => `${i.name} ${kb(i.bytes)}`).join('  ·  ')}`]
            : []),
          ...(r.layers.length
            ? ['', `full-screen composited layers (a classic other half of the problem):`,
              ...r.layers.map(l => `  ${l}`)]
            : []),
          '',
          r.imgBytes > 5 * 1024 * 1024
            ? `⚠ ${kb(r.imgBytes)} of images is the first thing to fix — reference the .webp siblings instead of the PNG masters.`
            : null,
          dropRatio > 25 && r.layers.length
            ? '⚠ Both heavy layers and dropped frames present. These are usually ADDITIVE — test removing them one at a time AND together before concluding.'
            : null,
          '',
          'Numbers are for A/B comparison on this 1-vCPU box, not the user\'s device.',
        ].filter(l => l !== null);
        return asText(lines.join('\n'));
      } catch (err) {
        return { content: [{ type: 'text', text: `profile_scroll failed: ${err?.message || String(err)}` }], isError: true };
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  );
}
