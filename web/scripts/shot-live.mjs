/**
 * 真服务端截图探针 —— inspect.mjs 的对偶（2026-08-14 用户拍板：查真项目的
 * 问题一律直连真服务端，mock 只留纯 UI 回归）。
 *
 *   node web/scripts/shot-live.mjs /projects/<pid>/work [选项]
 *
 *   --base=https://nodesign.xiaobuyu.trade:8443   入口（默认 exp 8443）
 *   --out=/tmp/shot.png --wait=3000 --viewport=1600x950
 *   --probe="document.querySelectorAll('[data-board-object]').length"
 *
 * 登录：自动读 .env 的 NODESIGN_AUTH_PASSWORD 以 admin 登录拿 nd_auth cookie
 * （也可 ND_TOKEN 环境变量直给）。输出 JSON：{ out, errors, probe } ——
 * errors 收 pageerror / console.error / 所有 4xx+ 响应（带 URL，破案主力）。
 *
 * 已用它破过的案：根站空串 403（artifact-file//index.html）、publish 单点段
 * 被 WHATWG 归一、连线浮层 Enter 焦点被 chip 抢走。配方沉淀：拿不准请求
 * 从哪儿发的，配 CDP Network.requestWillBeSent 的 initiator 栈（见 memory）。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(path.join(ROOT, 'node_modules/playwright/index.js'));

const args = process.argv.slice(2);
const route = args.find((a) => a.startsWith('/')) || '/';
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = opt('base', process.env.ND_BASE || 'https://nodesign.xiaobuyu.trade:8443');
const OUT = opt('out', '/tmp/shot-live.png');
const WAIT = Number(opt('wait', 3000));
const PROBE = opt('probe', null);
const [VW, VH] = opt('viewport', '1600x950').split('x').map(Number);

let token = process.env.ND_TOKEN || null;
if (!token) {
  // 用 .env 的 admin 密码换 cookie（服务端口从 .env PORT 读，默认 4002）
  const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
  const pw = /^NODESIGN_AUTH_PASSWORD=(.*)$/m.exec(env)?.[1];
  const port = /^PORT=(.*)$/m.exec(env)?.[1] || '4002';
  if (!pw) { console.error('拿不到 NODESIGN_AUTH_PASSWORD，也没给 ND_TOKEN'); process.exit(1); }
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: pw }),
  });
  token = /nd_auth=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
  if (!token) { console.error(`登录失败 (${res.status})`); process.exit(1); }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'nd_auth', value: token, url: BASE }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().slice(0, 220)}`); });

await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => errors.push(`goto: ${e.message}`));
await page.waitForTimeout(WAIT);
let probe = null;
if (PROBE) { try { probe = await page.evaluate(PROBE); } catch (e) { probe = `PROBE ERR: ${e.message}`; } }
await page.screenshot({ path: OUT, fullPage: false });
console.log(JSON.stringify({ out: OUT, errors, probe }, null, 2));
await browser.close();
