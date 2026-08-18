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
import { withBrowser, closeFor } from '../../engine/browse/registry.js';
import { blockedCount, blockedSince } from '../browse-proxy.js';
import { primeOwnAddresses } from '../ssrf-guard.js';

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
  // ⚠️ 别用固定 6 秒等：这一格排在 9 个跳板请求之后，公网跳板慢一点就读成
  // "闸没拦住"——**安全实验里的假警报会训练人忽略警报**。改成轮询到出结果为止。
  let got = false;
  for (let i = 0; i < 30 && !got; i += 1) {
    await page.waitForTimeout(500);
    got = blocked.some(x => x.url.includes('169.254'));
  }
  console.log(`${got ? '✅' : '⛔'} ⭐ 跨源 iframe（OOPIF）的跳转目标`
    + (got ? '' : '（等满 15 秒没见到拦记录 —— 先确认跳板站是不是在限速，别急着当漏洞）'));
  got ? pass++ : fail++;
  await ctx.close();
}

await browser.close();

// ── 第二组：**代理层**的闸（2026-08-18 第二遍）──
//
// 上面那组打的是 CDP 那道。审查攻出来四条它根本看不见的路（WebSocket 握手、
// `<link rel=prefetch>`、sendBeacon、还没装上闸的弹窗），以及一条判据在云上不成立
// （1:1 NAT 下本机公网 IP 不在任何网卡上）。闸因此挪到了代理层。
// 这一组走**真实的浏览通道**（带 --proxy-server 的常驻浏览器）。
console.log('\n── 代理层闸（走真实浏览通道）──');
const myIp = await primeOwnAddresses();
console.log(`   本机公网 IP: ${myIp || '(取不到，跳过那一格)'}`);
const PID = process.env.ND_LAB_PID || 'proj_msxlv88m_lfde';
const n0 = blockedCount();
try {
  const R = await withBrowser(PID, async ({ page }) => {
    const out = {};
    // ⚠️ 顺序有讲究：**先落到公网页**再试被拦的那些。反过来的话被拦的导航会留下
    // 一张 chrome 错误页，紧接着的 goto 被它打断 —— 那是探针的竞态，不是产品的问题
    // （第一版矩阵就因此报了一条假失败）。产品里 browser_navigate 有预检 + 退回原处。
    try { const r = await page.goto('https://example.com/', { timeout: 25000, waitUntil: 'domcontentloaded' }); out['反向·公网正事'] = r.status() === 200; }
    catch { out['反向·公网正事'] = false; }
    try { await page.goto('http://169.254.169.254/', { timeout: 8000 }); out['顶层导航内网'] = false; }
    catch { out['顶层导航内网'] = true; }
    // 再回公网页，后面的页内攻击才有个正常的落脚点
    await page.goto('https://example.com/', { timeout: 25000, waitUntil: 'domcontentloaded' }).catch(() => {});
    if (!page.isClosed()) {
      Object.assign(out, await page.evaluate(async (ip) => ({
        'fetch 元数据': await fetch('http://169.254.169.254/x').then(() => false).catch(() => true),
        'WebSocket 打本机': await new Promise((res) => {
          try { const w = new WebSocket('ws://127.0.0.1:4001/ws/projects/x/browser');
            w.onopen = () => res(false); w.onerror = () => res(true); setTimeout(() => res(true), 3000);
          } catch { res(true); } }),
        'link rel=prefetch': await new Promise((res) => {
          const l = document.createElement('link'); l.rel = 'prefetch';
          l.href = 'http://127.0.0.1:4001/api/health';
          l.onerror = () => res(true); l.onload = () => res(false);
          document.head.appendChild(l); setTimeout(() => res(true), 2000); }),
        'img 打内网 LAN': await new Promise((res) => { const i = new Image();
          i.onload = () => res(false); i.onerror = () => res(true);
          i.src = 'http://10.128.0.12:4001/api/health'; setTimeout(() => res(true), 2500); }),
        '打自己的公网 IP': ip ? await fetch(`https://${ip}:8443/`).then(() => false).catch(() => true) : true,
      }), myIp));
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 4000 }).catch(() => null),
        page.evaluate(() => { try { window.open('http://169.254.169.254/popup', '_blank'); } catch {} }),
      ]);
      await page.waitForTimeout(1200);
      out['未装闸弹窗'] = !popup || popup.isClosed();
    }
    return out;
  });
  for (const [k, ok] of Object.entries(R)) {
    console.log(`${ok ? '✅' : '⛔'} ${k}`);
    ok ? pass++ : fail++;
  }
  const nb = blockedSince(n0);
  console.log(`   代理记账 ${nb.length} 条`);
} catch (err) {
  console.log('⛔ 代理层那组没跑起来:', err.message);
  fail++;
} finally {
  await closeFor(PID, 'lab done').catch(() => {});
}

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
