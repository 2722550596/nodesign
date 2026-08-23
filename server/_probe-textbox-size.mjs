// 量一下画布上文字节点：DOM 占位 vs 正文实际尺寸 vs board.json 存的 w/h
import { chromium } from 'playwright';
import { mintToken, COOKIE_NAME } from './auth/session.js';
const [pid, owner] = process.argv.slice(2);
const origin = process.env.NODESIGN_WEB_ORIGIN;
const b = await chromium.launch({ args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
await c.addCookies([{ name: COOKIE_NAME, value: mintToken(owner), url: origin }]);
const p = await c.newPage();
await p.goto(`${origin}/projects/${pid}/work?eye=1`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('html[data-eye-ready="1"]', { timeout: 25000 });
const rows = await p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-board-object]')) {
    const id = el.getAttribute('data-board-object');
    if (!/^text:/.test(id)) continue;
    const r = el.getBoundingClientRect();
    const inner = el.querySelector('[data-text-body]') || el.firstElementChild;
    const ir = inner ? inner.getBoundingClientRect() : null;
    // 正文真实宽：取最宽的一行（range）
    let textW = 0;
    if (inner) {
      const range = document.createRange(); range.selectNodeContents(inner);
      for (const rc of range.getClientRects()) textW = Math.max(textW, rc.right - ir.left);
    }
    out.push({ id, box: [Math.round(r.width), Math.round(r.height)], inner: ir ? [Math.round(ir.width), Math.round(ir.height)] : null, textW: Math.round(textW), style: el.style.width + '/' + el.style.height });
  }
  return out;
});
const zoom = await p.evaluate(() => parseFloat(document.documentElement.dataset.eyeView?.match(/zoom ([\d.]+)/)?.[1] || '1'));
console.log('zoom', zoom);
for (const r of rows) console.log(r.id, 'DOM', r.box.map(v => Math.round(v / zoom)), 'inner', r.inner?.map(v => Math.round(v / zoom)), 'textW', Math.round(r.textW / zoom), 'style', r.style);
await b.close();
