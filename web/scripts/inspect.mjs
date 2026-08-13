/**
 * 检查通道 —— 把整站拦下来喂假数据，用服务端自带的 chromium 真渲染一遍。
 *
 *   node scripts/inspect.mjs [路由] [选项]
 *
 *   node scripts/inspect.mjs /projects/p_demo/work
 *   node scripts/inspect.mjs /projects/p_demo/work --out=/tmp/board.png --wait=2500
 *   node scripts/inspect.mjs / --viewport=1280x800
 *   node scripts/inspect.mjs /projects/p_demo/work --probe="document.querySelectorAll('[data-board-object]').length"
 *   node scripts/inspect.mjs /projects/p_demo/work --shot=[data-floating-toolbar]
 *
 * ## 为什么要有它
 *
 * 这台机器的浏览器扩展连不上，而画布这类东西的毛病**只有真跑看得见**：
 * 2026-08-13 一天里，工具栏落点被父组件抹掉、`node` 组被过滤、迟到的组
 * 把工具栏挤偏 —— 三个 bug，`vite build` 和 267 个单测一个都没照出来。
 *
 * 8443 有登录墙，拿 playwright 去撞它意味着要处理密码，那条路不走。
 * 所以**把 `/api/**` 全部拦下来喂假数据**：登录墙自然绕过（它也是接口），
 * 数据固定可复现，改动前后两张图能逐像素比。
 *
 * ## 它输出什么
 *
 *   errors     页面异常 + console.error（**空数组才算通过**）
 *   unmatched  没喂到数据的接口 —— 去 fixtures.mjs 补，别改前端迁就它
 *   probe      --probe 里那段 JS 在页面里的求值结果（量位置/数个数就靠它）
 *   out        整页截图；--shot=<选择器> 再加一张局部特写
 *
 * ⚠️ WebSocket 不拦：连不上就连不上，前端本来就有重连兜底。要是哪天需要演
 * agent 的实时事件，在这儿加一个假 WS 服务端比伪造事件流靠谱。
 */

import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { resolve as resolveFixture } from './fixtures.mjs';

// playwright 装在仓库根（服务端截图那条链在用），借它，不另装一份
const { chromium } = createRequire(import.meta.url)(
  '/home/wangang-dev/projects/Nodesign-canvas/node_modules/playwright/index.js',
);

const args = process.argv.slice(2);
const route = args.find(a => a.startsWith('/')) || '/projects/p_demo/work';
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const OUT = opt('out', '/tmp/inspect.png');
const WAIT = Number(opt('wait', 2000));
const [VW, VH] = opt('viewport', '1440x900').split('x').map(Number);
const PROBE = opt('probe', null);
const SHOT = opt('shot', null);
const PORT = Number(opt('port', 5199));

const server = await createServer({ server: { port: PORT, strictPort: true } });
await server.listen();

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });

const errors = [];
const unmatched = [];
/** 前端发出去的写请求（拖拽落盘、改名这类"看不见的动作"靠它验） */
const calls = [];
page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 400)}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`); });

await page.route('**/api/**', async (r) => {
  const u = new URL(r.request().url());
  const method = r.request().method();
  if (method !== 'GET') {
    let body = null;
    try { body = r.request().postDataJSON(); } catch { body = r.request().postData(); }
    calls.push({ method, path: u.pathname, body });
  }
  const hit = resolveFixture(u.pathname, method);
  if (!hit) {
    unmatched.push(`${r.request().method()} ${u.pathname}`);
    // 兜一个空对象：让前端往下走，别在第一个缺的接口就停住
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  return r.fulfill({
    status: hit.status || 200,
    contentType: hit.contentType || 'application/json',
    body: hit.body != null ? hit.body : JSON.stringify(hit.json ?? {}),
  });
});

await page.goto(`http://127.0.0.1:${PORT}${route}`, { waitUntil: 'load' });
await page.waitForTimeout(WAIT);

// 交互：--click / --dblclick 传选择器，发**真事件**（画布很多手势是自己数
// pointerup 的，合成事件糊弄不过去）
/**
 * 拖拽：`--drag=<选择器>|<dx>,<dy>`。**必须一步步发 mousemove** ——
 * 画布的拖拽是自己在 pointermove 里积位移的，一步到位的 move 它只会当成
 * 一次抖动（而且落点提示根本来不及算）。
 */
const DRAG = opt('drag', null);
if (DRAG) {
  const [sel, delta] = DRAG.split('|');
  const [dx, dy] = (delta || '0,0').split(',').map(Number);
  const el = await page.$(sel);
  if (!el) errors.push(`--drag 没找到元素: ${sel}`);
  else {
    const b = await el.boundingBox();
    const sx = b.x + b.width / 2; const sy = b.y + b.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + dx * 0.3, sy + dy * 0.3, { steps: 6 });
    await page.mouse.move(sx + dx * 0.7, sy + dy * 0.7, { steps: 6 });
    await page.mouse.move(sx + dx, sy + dy, { steps: 8 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(900);
  }
}

for (const [flag, how] of [['click', 'click'], ['dblclick', 'dblclick']]) {
  const sel = opt(flag, null);
  if (!sel) continue;
  const el = await page.$(sel);
  if (!el) { errors.push(`--${flag} 没找到元素: ${sel}`); continue; }
  await el[how]();
  await page.waitForTimeout(700);
}

let probe = null;
if (PROBE) {
  try { probe = await page.evaluate(`(() => (${PROBE}))()`); }
  catch (e) { probe = `probe failed: ${String(e).slice(0, 200)}`; }
}

await page.screenshot({ path: OUT, fullPage: false });
let shot = null;
if (SHOT) {
  const el = await page.$(SHOT);
  if (el) { shot = OUT.replace(/\.png$/, '-shot.png'); await el.screenshot({ path: shot }); }
}

await browser.close();
await server.close();

console.log(JSON.stringify({
  route, out: OUT, shot,
  errors,
  unmatched: [...new Set(unmatched)],
  calls,
  probe,
}, null, 2));
