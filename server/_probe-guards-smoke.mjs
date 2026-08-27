// guards.ts 冒烟探针：jiti 加载（对齐 pi 的 -e 挂载路径）+ stub pi 驱动全部 handler。
// 临时文件，验完即删。
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire('/home/yoshix7ti/projects/pi-rp/packages/coding-agent/package.json');
const { createJiti } = require('jiti');

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-guards-probe-'));
// 数据根放 tmpdir 之外 —— ws 本身在 tmpdir 里，越界写判据对临时目录放行，
// 若 dataRoot 也在 tmpdir 内则"越界写"会被临时目录豁免误判为放行
const dataRoot = '/data/projects-data';

// 本地 sidecar：收 /emit
const emits = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    emits.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.NODESIGN_WORKSPACE = ws;
process.env.NODESIGN_DATA_ROOT = dataRoot;
process.env.NODESIGN_MAIN_URL = `http://127.0.0.1:${port}/__nd-sidecar`;
process.env.NODESIGN_TOKEN = 'tok-1';
process.env.NODESIGN_SID = 'sid-1';
process.env.NODESIGN_PROJECT = 'pid-1';

const jiti = createJiti(import.meta.url, { interopDefault: true });
const setup = jiti('/home/yoshix7ti/projects/Nodesign/server/engine/pi/extensions/guards.ts').default;

const handlers = {};
const stubPi = { on: (ev, h) => { handlers[ev] = h; } };
setup(stubPi);

let fails = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };

ok(typeof setup === 'function', 'default export 是工厂函数');
ok(handlers.tool_call && handlers.tool_result && handlers.session_start && handlers.before_agent_start, '四个事件全注册');

// ── tool_call：越界写拦 / 工作区内放 / 演出记录点名读拦 / handler 异常 fail-open ──
const otherWs = path.join(dataRoot, 'proj_bbb', 'shared');
const r1 = await handlers.tool_call({ toolName: 'write', input: { path: path.join(otherWs, 'x.md') } }, {});
ok(r1?.block === true && /只能落在/.test(r1.reason), '越界写 → block');
const r2 = await handlers.tool_call({ toolName: 'write', input: { path: 'notes/a.md' } }, {});
ok(r2 === undefined, '工作区内写 → 放行');
const r3 = await handlers.tool_call({ toolName: 'read', input: { path: path.join(otherWs, 'x.md') } }, {});
ok(r3?.block === true && /别的项目/.test(r3.reason), 'dataRoot 内越界读 → block');
const r4 = await handlers.tool_call({ toolName: 'screenshot_canvas', input: { path: otherWs } }, {});
ok(r4 === undefined, 'MCP 工具不归闸管');

// 演出文件夹
await fs.mkdir(path.join(ws, '戏'), { recursive: true });
await fs.writeFile(path.join(ws, '戏/编排.yaml'), '历史:\n  文件: 记录.jsonl\n');
const r5 = await handlers.tool_call({ toolName: 'read', input: { path: '戏/对话.jsonl' } }, {});
ok(r5?.block === true && /隐私/.test(r5.reason), '演出记录点名读 → block');
const r6 = await handlers.tool_call({ toolName: 'ls', input: { path: '戏' } }, {});
ok(r6 === undefined, '演出目录 ls（目录扫描）→ 放行');

// ── tool_result：write 后 lint 追加 / isError 跳过 / 干净文件不动 ──
const badDeck = '<div id="__nd-deck-wrap"></div><section data-page="1"></section>';
await fs.writeFile(path.join(ws, 'canvas.html'), badDeck);
const lr1 = await handlers.tool_result({
  toolName: 'write', input: { path: 'canvas.html' },
  content: [{ type: 'text', text: 'wrote canvas.html' }], isError: false,
}, {});
ok(Array.isArray(lr1?.content) && lr1.content.length === 2
  && lr1.content[0].text === 'wrote canvas.html'
  && /\[canvas-validate\]/.test(lr1.content[1].text)
  && /data-layout-role/.test(lr1.content[1].text),
  'deck lint 命中 → 原 content + lint 文本整体替换');

await fs.writeFile(path.join(ws, 'canvas.html'), '<div id="__nd-deck-wrap"></div><section data-page="1" data-layout-role="text-led"></section>');
const lr2 = await handlers.tool_result({
  toolName: 'write', input: { path: 'canvas.html' },
  content: [{ type: 'text', text: 'ok' }], isError: false,
}, {});
ok(lr2 === undefined, '干净 deck → 不改写结果');

const lr3 = await handlers.tool_result({
  toolName: 'write', input: { path: 'canvas.html' },
  content: [{ type: 'text', text: 'err' }], isError: true,
}, {});
ok(lr3 === undefined, 'isError → 跳过 lint');

// 站点页 lint
await fs.mkdir(path.join(ws, '站点'), { recursive: true });
await fs.writeFile(path.join(ws, '站点/index.html'), '<html><head></head><body><a href="/x">x</a></body></html>');
const lr4 = await handlers.tool_result({
  toolName: 'edit', input: { path: '站点/index.html' },
  content: [{ type: 'text', text: 'edited' }], isError: false,
}, {});
ok(lr4?.content?.length === 2 && /viewport/.test(lr4.content[1].text) && /根路径/.test(lr4.content[1].text),
  '站点页两规则（viewport + 根路径）都报');

// 读不到文件静默跳过
const lr5 = await handlers.tool_result({
  toolName: 'write', input: { path: '不存在.html' },
  content: [{ type: 'text', text: 'x' }], isError: false,
}, {});
ok(lr5 === undefined, '文件不存在 → 静默跳过');

// ── session_start：/emit 收 INIT_CONTRACT 心跳 ──
await handlers.session_start({ type: 'session_start', reason: 'new' }, {});
await new Promise((r) => setTimeout(r, 100));
const e1 = emits.find((e) => e.body?.event?.code === 'INIT_CONTRACT');
ok(!!e1, 'session_start → sidecar /emit 收到 INIT_CONTRACT');
ok(e1?.url === '/__nd-sidecar/emit', 'emit URL = MAIN_URL + /emit');
ok(e1?.auth === 'Bearer tok-1', 'Authorization: Bearer <NODESIGN_TOKEN>');
ok(e1?.body?.sid === 'sid-1' && e1?.body?.pid === 'pid-1', 'body 带 sid/pid');
ok(e1?.body?.event?.type === 'run.error' && /装配状态/.test(e1.body.event.message), 'event = 非终态 run.error + 装配状态');

// ── before_agent_start：缺 prelude H1 → 警告上报；含 → 静默 ──
await handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: 'pi-default only, no prelude' }, {});
await new Promise((r) => setTimeout(r, 100));
const e2 = emits.filter((e) => /装配断言失败/.test(e.body?.event?.message || ''));
ok(e2.length === 1, 'systemPrompt 缺 prelude H1 → 上报断言失败');

// preludeChecked 已置位：第二次（哪怕这次带 H1）不再报
await handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: '# NoDesign 平台协议' }, {});
await new Promise((r) => setTimeout(r, 100));
ok(emits.filter((e) => /装配断言失败/.test(e.body?.event?.message || '')).length === 1, '断言只跑一次（首回合）');

server.close();
await fs.rm(ws, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
