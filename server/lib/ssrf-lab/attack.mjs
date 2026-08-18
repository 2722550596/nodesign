#!/usr/bin/env node
/**
 * server/lib/ssrf-lab/attack.mjs — 出网闸的攻击矩阵（2026-08-18）
 *
 * 为什么不放进 vitest：这几条**必须真联网**（要一个公网跳板才能测到"跳转的第二跳"），
 * 放进单测会让测试套件依赖外网。单测只钉地址算术（`ssrf-guard.test.js`），
 * 这里钉端到端行为。改动过 `ssrf-guard.js` 就手跑一次：
 *
 *   node server/lib/ssrf-lab/attack.mjs
 *
 * ⚠️ 这份东西存在的理由是：**这道闸的第一版和第二版都是被它攻出漏洞的**——
 *   v1 用 playwright `context.route`：实测**看不到跳转的第二跳**，
 *      `https://跳板/` → `http://127.0.0.1:4001/` 一路畅通。
 *   v2 改 CDP Fetch 但把装闸挂在 `context.on('page')` 里 fire-and-forget：
 *      **初始化竞态**，第一次导航整个穿过第一道闸，实测到达了 169.254.169.254。
 * 读代码两次都看不出来。
 */

import { attachSsrfGuard } from '../ssrf-guard.js';

// 公网跳板：本机起的跳板第一跳就会被闸拦掉，测不到第二跳。
const HOP = (to) => `https://nghttp2.org/httpbin/redirect-to?url=${encodeURIComponent(to)}`;

const CASES = [
  ['直接导航 · 我们自己的 API', 'http://127.0.0.1:4001/api/health', true],
  ['直接导航 · 云元数据', 'http://169.254.169.254/computeMetadata/v1/', true],
  ['直接导航 · file://', 'file:///etc/passwd', true],
  ['直接导航 · IPv4-mapped 绕过', 'http://[::ffff:127.0.0.1]:4001/api/health', true],
  ['⭐ 跳转第二跳 · 云元数据', HOP('http://169.254.169.254/computeMetadata/v1/'), true],
  ['⭐ 跳转第二跳 · 我们的 API（loopback）', HOP('http://127.0.0.1:4001/api/health'), true],
  ['⭐ 跳转第二跳 · 我们的 API（本机 LAN IP）', HOP('http://10.128.0.12:4001/api/health'), true],
  ['反向 · 真公网站点不许被拦死', 'https://example.com/', false],
  ['反向 · 经跳转到真公网', HOP('https://example.com/'), false],
];

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
let pass = 0, fail = 0;

for (const [name, url, shouldBlock] of CASES) {
  const ctx = await browser.newContext();
  const { blocked, armPage } = await attachSsrfGuard(ctx);
  const page = await ctx.newPage();
  await armPage(page);                       // ⭐ 必须 await 完才导航（v2 的竞态就在这儿）
  let navErr = null;
  try { await page.goto(url, { timeout: 25_000, waitUntil: 'domcontentloaded' }); }
  catch (e) { navErr = e.message.split('\n')[0]; }
  const landedInternal = blocked.length > 0;
  const ok = shouldBlock ? landedInternal : (!landedInternal && !page.isClosed() && /^https?:/.test(page.url()));
  console.log(`${ok ? '✅' : '⛔'} ${name}`);
  if (!ok || process.env.VERBOSE) {
    console.log(`      落在: ${page.isClosed() ? '(已掐)' : page.url().slice(0, 70)}`);
    if (navErr) console.log(`      报错: ${navErr.slice(0, 70)}`);
    for (const x of blocked) console.log(`      拦: [${x.stage}] ${x.url.slice(0, 60)} ← ${x.reason.slice(0, 46)}`);
  }
  ok ? pass++ : fail++;
  await ctx.close();
}

// 跨源 iframe（OOPIF）—— chromium 里它是独立 target，页面级 CDP 会话未必看得见
{
  const ctx = await browser.newContext();
  const { blocked, armPage } = await attachSsrfGuard(ctx);
  const page = await ctx.newPage();
  await armPage(page);
  await page.goto('https://example.com/', { timeout: 25_000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate((u) => {
    const f = document.createElement('iframe'); f.src = u; document.body.appendChild(f);
  }, HOP('http://169.254.169.254/computeMetadata/v1/'));
  await page.waitForTimeout(6000);
  const got = blocked.some(x => x.url.includes('169.254'));
  console.log(`${got ? '✅' : '⛔'} ⭐ 跨源 iframe（OOPIF）的跳转目标`);
  got ? pass++ : fail++;
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
