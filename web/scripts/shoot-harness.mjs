/**
 * 拿 Nodesign 自带的 chromium 给渲染检查台截图。
 *
 *   node scripts/shoot-harness.mjs [case] [输出路径]
 *
 * 会自己起一个临时 vite dev server（端口 5199），截完关掉。
 */
import { createServer } from 'vite';
import { createRequire } from 'node:module';

// playwright 装在仓库根（服务端截图那条链在用），这里借它，不另装一份
const { chromium } = createRequire(import.meta.url)('/home/wangang-dev/projects/Nodesign-canvas/node_modules/playwright/index.js');

const CASE = process.argv[2] || 'site';
const OUT = process.argv[3] || `/tmp/harness-${CASE}.png`;
const PORT = 5199;

const server = await createServer({ server: { port: PORT, strictPort: true } });
await server.listen();

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('[probe]')) errors.push(m.text().slice(0, 300)); });

await page.goto(`http://127.0.0.1:${PORT}/harness.html?case=${CASE}`, { waitUntil: 'load' });
// 工具栏的落点在 layout effect + rAF 里算，等一拍再截
await page.waitForTimeout(1200);
// 拖一把试试：dock 模式下不该动
const before = await page.evaluate(() => { const t = document.querySelector('[data-floating-toolbar]'); const r = t.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
const bx = before.x + 8, by = before.y + 8;      // 避开按钮，按在条的左边缘
await page.mouse.move(bx, by);
await page.mouse.down();
await page.mouse.move(bx - 260, by - 200, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.evaluate(() => { const t = document.querySelector('[data-floating-toolbar]'); const r = t.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
const dragged = { before, after, moved: (after.x !== before.x || after.y !== before.y) };
await page.screenshot({ path: OUT });
// 工具栏局部特写：整屏 1440 宽里那条只占一小截，缩略了看不出配色
const tbEl = await page.$('[data-floating-toolbar]');
if (tbEl) await tbEl.screenshot({ path: OUT.replace(/\.png$/, '-toolbar.png') });

// 量一下工具栏到底落在哪 —— 肉眼看图容易把"差 20px"看成"对齐了"
const box = await page.evaluate(() => {
  const tb = document.querySelector('[data-floating-toolbar]');
  const host = tb?.offsetParent || null;          // 锚点算的就是相对它
  const r = (el) => el ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect()) : null;
  const t = r(tb); const c = r(host);
  return {
    toolbar: t, content: c,
    // 对齐判据：工具栏中心 vs 容器中心（差多少像素），以及离底缘多远
    offCenterPx: (t && c) ? Math.round((t.x + t.w / 2) - (c.x + c.w / 2)) : null,
    bottomGapPx: (t && c) ? Math.round((c.y + c.h) - (t.y + t.h)) : null,
  };
});

await browser.close();
await server.close();
console.log(JSON.stringify({ out: OUT, errors: errors.slice(-8), dragged, ...box }, null, 2));
