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
await page.screenshot({ path: OUT });

// 量一下工具栏到底落在哪 —— 肉眼看图容易把"差 20px"看成"对齐了"
const box = await page.evaluate(() => {
  // 工具栏没有稳定的 data 属性，按"里面有按钮的绝对定位浮层"找，并把它是谁打出来
  const all = [...document.querySelectorAll('div')].filter(d => {
    const st = getComputedStyle(d);
    return st.position === 'absolute' && d.querySelector('button') && d.offsetWidth > 200 && d.offsetHeight < 80;
  });
  const tb = all[0] || null;
  const host = document.querySelector('[data-site-window]')?.parentElement;
  const r = (el) => el ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect()) : null;
  return { toolbar: r(tb), content: r(host), tbHtml: tb ? tb.outerHTML.slice(0, 120) : null, candidates: all.length };
});

await browser.close();
await server.close();
console.log(JSON.stringify({ out: OUT, errors: errors.slice(-8), ...box }, null, 2));
