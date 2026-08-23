// 视点上报端到端：真浏览器开画布页（非眼睛模式）→ 服务端 GET /viewpoint 能读到
//   node --env-file=.env server/_probe-viewpoint.mjs <pid> <ownerId>
import { chromium } from 'playwright';
import { mintToken, COOKIE_NAME } from './auth/session.js';
const [pid, owner] = process.argv.slice(2);
const origin = process.env.NODESIGN_WEB_ORIGIN; const api = `http://127.0.0.1:${process.env.PORT || 4002}`;
const tok = mintToken(owner);
const b = await chromium.launch({ args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
await c.addCookies([{ name: COOKIE_NAME, value: tok, url: origin }]);
const p = await c.newPage();
await p.goto(`${origin}/projects/${pid}/work`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
const get = async () => (await (await fetch(`${api}/api/projects/${pid}/viewpoint`, { headers: { cookie: `nd_auth=${tok}` } })).json()).viewpoint;
console.log('after load:', JSON.stringify(await get()));
// 滚轮缩放 + 双击一张卡（开窗）
await p.mouse.move(700, 450); await p.mouse.wheel(0, -600); await p.waitForTimeout(2000);
console.log('after zoom:', JSON.stringify((await get())?.camera), (await get())?.zoom);
const card = await p.$('[data-board-object]');
if (card) { await card.dblclick(); await p.waitForTimeout(2500); console.log('after dblclick:', (await get())?.openWindow); }
await b.close();
