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
page.on('console', m => {
  if (m.type() !== 'error') return;
  // 资源加载失败这类消息正文里没有 URL，出处在 location —— 不带上它，
  // 报告里就只有一句孤零零的 404，不知道是谁的
  const loc = m.location()?.url ? ` [${m.location().url}]` : '';
  const t = m.text() + loc;
  // vite 开发服没有 /ws 端点，WS 握手失败是通道自身的环境噪音（前端有重连
  // 兜底，真后端的 WS 问题这条通道本来就测不到）。别让它污染「errors 必须
  // 为空」这条判据 —— 判据一旦常态性带噪，就没人再看它了。
  if (/WebSocket/i.test(t)) return;
  errors.push(`console: ${t.slice(0, 400)}`);
});

// 预置 localStorage：`--localstorage='key={"json":true}'`（第一个 = 号分界）。
// 验"记住的偏好"这类分支（悬浮卡固定态、面板宽度）——不预置的话每次都是
// 全新浏览器，永远只走默认值那条路。
const LS = opt('localstorage', null);
if (LS) {
  const i = LS.indexOf('=');
  const k = LS.slice(0, i); const v = LS.slice(i + 1);
  await page.addInitScript(([key, val]) => localStorage.setItem(key, val), [k, v]);
}

await page.route('**/api/**', async (r) => {
  const u = new URL(r.request().url());
  const method = r.request().method();
  if (method !== 'GET') {
    let body = null;
    try { body = r.request().postDataJSON(); } catch { body = r.request().postData(); }
    calls.push({ method, path: u.pathname, body });
  }
  let parsed = null;
  try { parsed = r.request().postDataJSON(); } catch { /* 非 JSON */ }
  const hit = resolveFixture(u.pathname, method, parsed);
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

// 按一个键（其它交互之前）：切工具快捷键（V/T/P/C/H）这类
const PRESS = opt('press', null);
if (PRESS) { await page.keyboard.press(PRESS); await page.waitForTimeout(300); }

// 滚轮：`--wheel=dx,dy`（其它交互之前，视口中心）。画布的滚轮=平移、
// Ctrl+滚轮=缩放 —— 验"全向无限"就得能把镜头真的推出内容圈。
const WHEEL = opt('wheel', null);
if (WHEEL) {
  const [wdx, wdy] = WHEEL.split(',').map(Number);
  await page.mouse.move(VW / 2, VH / 2);
  await page.mouse.wheel(wdx, wdy);
  await page.waitForTimeout(600);
}

/**
 * 悬停路径：`--hover=<sel>` 真鼠标挪到元素中心停 350ms；配 `--hover-to=<sel>`
 * 再**步进**挪到第二个元素（hover 显隐出来的按钮）上，停 250ms 报告它还在
 * 不在、然后真点一下。验"悬停出来的按钮能不能点到"必须走真路径 ——
 * locator.click 是瞬移，穿缝卸载（按钮浮在卡外、路上有死缝）这种病测不出来。
 */
const HOVER = opt('hover', null);
const HOVER_TO = opt('hover-to', null);
let hoverReport = null;
if (HOVER) {
  const el = await page.$(HOVER);
  if (!el) errors.push(`--hover 没找到元素: ${HOVER}`);
  else {
    const b = await el.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.waitForTimeout(350);
    if (HOVER_TO) {
      const t = await page.$(HOVER_TO);
      if (!t) { hoverReport = { appeared: false }; errors.push(`--hover-to 悬停后没出现: ${HOVER_TO}`); }
      else {
        const tb = await t.boundingBox();
        await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 10 });
        await page.waitForTimeout(250);
        const still = await page.$(HOVER_TO);
        const sb = still ? await still.boundingBox() : null;
        hoverReport = { appeared: true, survivedTravel: !!sb, box: sb };
        if (sb) { await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.waitForTimeout(600); }
        else errors.push(`--hover-to 挪过去的路上目标卸载了: ${HOVER_TO}`);
      }
    }
  }
}

/**
 * 拖拽：`--drag=<选择器>|<dx>,<dy>`。**必须一步步发 mousemove** ——
 * 画布的拖拽是自己在 pointermove 里积位移的，一步到位的 move 它只会当成
 * 一次抖动（而且落点提示根本来不及算）。
 *
 * `--drag-wheel=dx,dy`：拖到 70% 处滚一把滚轮再继续（验"拖拽中相机动了
 * 卡还钉不钉在光标下"）。结束后输出 `dragEnd`：最终鼠标位置 + 目标元素的
 * 实际矩形 —— 抓点是元素中心，钉住 = 元素中心 ≈ 最终鼠标位置。
 */
const DRAG = opt('drag', null);
const DRAG_WHEEL = opt('drag-wheel', null);
let dragEnd = null;
if (DRAG) {
  const [sel, delta] = DRAG.split('|');
  const [dx, dy] = (delta || '0,0').split(',').map(Number);
  // `--drag='@x,y|dx,dy'` 按坐标起拖（画一笔涂鸦这类"从空白处开始"的手势
  // 没有元素可选）；选择器形式照旧
  const byCoord = sel.startsWith('@');
  const el = byCoord ? null : await page.$(sel);
  if (!byCoord && !el) errors.push(`--drag 没找到元素: ${sel}`);
  else {
    let sx; let sy;
    if (byCoord) { [sx, sy] = sel.slice(1).split(',').map(Number); }
    else {
      const b = await el.boundingBox();
      sx = b.x + b.width / 2; sy = b.y + b.height / 2;
    }
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + dx * 0.3, sy + dy * 0.3, { steps: 6 });
    await page.mouse.move(sx + dx * 0.7, sy + dy * 0.7, { steps: 6 });
    if (DRAG_WHEEL) {
      const [a, c] = DRAG_WHEEL.split(',').map(Number);
      await page.mouse.wheel(a, c);
      await page.waitForTimeout(250);
      // 滚轮不产生 pointermove —— 这里补一次 1px 的挪动再挪回来，
      // 模拟真人手上永远存在的微动（纯滚轮期间的钉住由 cam effect 兜）
      await page.mouse.move(sx + dx * 0.7 + 1, sy + dy * 0.7, { steps: 1 });
    }
    await page.mouse.move(sx + dx, sy + dy, { steps: 8 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(900);
    const after = byCoord ? null : await page.$(sel);
    const bb = after ? await after.boundingBox() : null;
    dragEnd = { mouse: { x: sx + dx, y: sy + dy }, box: bb };
  }
}

// 右键：先于 click 跑，这样能"右键 → 点菜单项"连成一串。
// `--rightclick-at=x,y` 按坐标点 —— 想点**空白画布**只能这样，按选择器会
// 落在容器中心，那儿多半压着一张卡（右键菜单是按命中对象换内容的）。
const RIGHT_AT = opt('rightclick-at', null);
const RIGHT = opt('rightclick', null);
if (RIGHT_AT) {
  const [rx, ry] = RIGHT_AT.split(',').map(Number);
  await page.mouse.click(rx, ry, { button: 'right' });
  await page.waitForTimeout(500);
} else if (RIGHT) {
  const el = await page.$(RIGHT);
  if (!el) errors.push(`--rightclick 没找到元素: ${RIGHT}`);
  else { await el.click({ button: 'right' }); await page.waitForTimeout(500); }
}

// 按文字点按钮（菜单项这种没有稳定选择器的）
const CLICK_TEXT = opt('click-text', null);
if (CLICK_TEXT) {
  const btn = page.locator(`button:has-text("${CLICK_TEXT}")`).first();
  // 用真鼠标点它的中心，而不是 locator.click —— 后者被"点别处关掉"的透明幕布
  // 拦下时会重试到超时，而 force 又会把事件发给幕布，两种都不是用户在做的事
  if (await btn.count()) {
    const b = await btn.boundingBox();
    // 点**左侧靠内**一点而不是正中：菜单右半截可能压在别的浮层底下
    if (b) { await page.mouse.click(b.x + 16, b.y + b.height / 2); await page.waitForTimeout(900); }
    else errors.push(`--click-text 量不到位置: ${CLICK_TEXT}`);
  }
  else errors.push(`--click-text 没找到按钮: ${CLICK_TEXT}`);
}

// 可以传多个 --click / --dblclick，**按命令行顺序逐个执行** ——
// 以前走 opt() 只认第一个，第二个静默不跑：测试脚本以为点了两下，
// 其实第二下从没发生，测出来的是别的东西（真踩过）。
for (const a of args) {
  const m = a.match(/^--(click|dblclick)=(.+)$/);
  if (!m) continue;
  const el = await page.$(m[2]);
  if (!el) { errors.push(`--${m[1]} 没找到元素: ${m[2]}`); continue; }
  await el[m[1]]();
  await page.waitForTimeout(700);
}

// 往当前聚焦的输入框里打字并回车（就地改名这类）
const TYPE = opt('type', null);
if (TYPE) {
  await page.keyboard.press('Control+A');
  await page.keyboard.type(TYPE, { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
}

// 事后移动：`--move=x,y[;x,y…]`（分号分航点，每站步进真移动 + 停 700ms）。
// 放在所有点击之后 —— 验"鼠标离开后自动收起""贴屏缘唤出"这类位置驱动的
// 时序，点完按钮鼠标停在原地是测不出来的。
const MOVE = opt('move', null);
if (MOVE) {
  for (const wp of MOVE.split(';')) {
    const [mx, my] = wp.split(',').map(Number);
    await page.mouse.move(mx, my, { steps: 10 });
    await page.waitForTimeout(700);
  }
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
  dragEnd,
  hoverReport,
  probe,
}, null, 2));
