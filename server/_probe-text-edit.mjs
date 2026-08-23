// 双击一段字 → 改字 → ⌘Enter 落笔 → 量块尺寸 vs 正文（用户报：编辑后块远大于字）
import { chromium } from 'playwright';
import { mintToken, COOKIE_NAME } from './auth/session.js';
const [pid, owner, targetId] = process.argv.slice(2);
const origin = process.env.NODESIGN_WEB_ORIGIN;
const b = await chromium.launch({ args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
await c.addCookies([{ name: COOKIE_NAME, value: mintToken(owner), url: origin }]);
const p = await c.newPage();
await p.goto(`${origin}/projects/${pid}/work?eye=1&view=${process.argv[5] || '0,40,1450,1000'}`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('html[data-eye-ready="1"]', { timeout: 25000 });
const sel = `[data-board-object="${targetId}"]`;
const size = async () => p.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); const inner = el.querySelector('[data-text-body]') || el.firstElementChild; const ir = inner?.getBoundingClientRect(); return { box: [Math.round(r.width), Math.round(r.height)], inner: ir ? [Math.round(ir.width), Math.round(ir.height)] : null, w: el.style.width }; }, sel);
console.log('before', await size());
const el = await p.$(sel); await el.dblclick();
await p.waitForTimeout(400);
const ta = await p.$('textarea');
if (!ta) { console.log('no editor opened'); await b.close(); process.exit(1); }
await ta.press('End'); await ta.type('（改过）');
await ta.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
for (const ms of [30, 120, 400, 1500]) { await p.waitForTimeout(ms); console.log(`+${ms}`, await size()); }
await p.waitForTimeout(1500);
console.log('after measure', await size());
await b.close();
