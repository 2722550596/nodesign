/**
 * kinds 注册表冒烟（多产物平权版，2026-07-29）。
 * 跑法：node lib/kinds/_kinds-check.mjs（在 server/ 下）
 * 纯文件系统 fixture，不起服务。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { taskManifest, artifactOfPath } from './index.js';
import world from './world.js';
import { resolveArtifactTarget } from '../artifact-target.js';

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-kinds-'));
const mk = async (rel, content = '<!doctype html><title>x</title>') => {
  const p = path.join(ws, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
};

// ── fixture 1：纯 deck 任务，两份平等 deck ──
await mk('tasks/t-deck/canvas.html', '<div class="canvas-wrap"><section data-page="1"></section><section data-page="2"></section></div>');
await mk('tasks/t-deck/proto-B.html');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-deck'));
  check('deck 任务 2 份平等产物', m.artifacts.length === 2 && m.artifacts.every(a => a.kind === 'deck'));
  check('canvas 排头但无等级字段', m.artifacts[0].file === 'canvas.html' && !('main' in m.artifacts[0]));
  check('proto-B 归自己', artifactOfPath(m, 'proto-B.html')?.file === 'proto-B.html');
}

// ── fixture 2：根站 + canvas.html 混合任务 ──
await mk('tasks/t-mixed/index.html');
await mk('tasks/t-mixed/about.html');
await mk('tasks/t-mixed/style.css', 'body{}');
await mk('tasks/t-mixed/canvas.html', '<section data-page="1"></section>');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-mixed'));
  const site = m.artifacts.find(a => a.kind === 'site' && !a.single);
  const deck = m.artifacts.find(a => a.kind === 'deck');
  check('混合任务 site+deck 并存', !!site && !!deck);
  check('站点页面不含 canvas.html', site.pages.includes('about.html') && !site.pages.includes('canvas.html'));
  check('canvas.html 归 deck', artifactOfPath(m, 'canvas.html')?.kind === 'deck');
  check('style.css 归根站', artifactOfPath(m, 'style.css')?.kind === 'site');
}

// ── fixture 3：无根站，两个平行子目录站 ──
await mk('tasks/t-twins/v1/index.html');
await mk('tasks/t-twins/v1/style.css', 'body{}');
await mk('tasks/t-twins/v2/index.html');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-twins'));
  const sites = m.artifacts.filter(a => a.kind === 'site' && !a.single);
  check('两个平行站各自成家', sites.length === 2 && sites.map(s => s.root).sort().join() === 'v1,v2');
  check('子目录站标题=目录名', sites.every(s => s.title === s.root));
  check('v1/style.css 归 v1 站', artifactOfPath(m, 'v1/style.css')?.root === 'v1');
  const t = await resolveArtifactTarget(ws, 'tasks/t-twins/v2/index.html', null);
  check('寻址 v2 产物根正确', t.ok && t.kind === 'site' && t.artifactDir.endsWith('t-twins/v2'));
}

// ── fixture 4：构建型根站 + 单页 ──
await mk('tasks/t-built/src/index.md', '# src');
await mk('tasks/t-built/dist/index.html');
await mk('tasks/t-built/dist/blog/a.html');
await mk('tasks/t-built/_drafts/alt.html');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-built'));
  const site = m.artifacts.find(a => a.kind === 'site' && !a.single);
  const single = m.artifacts.find(a => a.single);
  check('构建站产物根 dist', site.root === 'dist' && site.pages.includes('blog/a.html'));
  check('源文件归根站（root 兜底）', artifactOfPath(m, 'src/index.md')?.root === 'dist');
  check('单页平等且不给整站导出', !!single && !single.exportFormats.includes('site') && single.exportFormats.includes('html'));
  check('单页归自己', artifactOfPath(m, '_drafts/alt.html')?.single === true);
}

// ── fixture 5：兼容字段 ──
{
  const m = await taskManifest(path.join(ws, 'tasks/t-deck'));
  check('兼容 kind/entryRel', m.kind === 'deck' && m.entryRel === 'canvas.html');
  await fs.mkdir(path.join(ws, 'tasks/t-empty'), { recursive: true });
  const empty = await taskManifest(path.join(ws, 'tasks/t-empty'));
  check('无产物无 marker → null', empty === null);
}

// ── fixture 6：world 形态（2026-08-01 阶段 0）──
// 重点全在**抢跑**：world 任务里迟早会有 .html（导出的仿书、预览页、试作），
// deck 认顶层任意 .html、site 认 index.html 和 dist/，两个都会把世界抢走。
await mk('tasks/t-world/世界.md', '# 雾都\n设定若干');
await mk('tasks/t-world/世界/王城/地点.md', '# 王城');
await mk('tasks/t-world/世界/王城/艾琳/角色.md', '# 艾琳');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-world'));
  check('world 判定 + 独占', m.kind === 'world' && m.artifacts.length === 1);
  check('world 入口是世界.md', m.entryRel === '世界.md' && m.artifacts[0].root === '');
  check('world 不给整站导出', !m.exportFormats.includes('site'));
  check('world 任务内路径归这个世界', artifactOfPath(m, '世界/王城/艾琳/角色.md')?.kind === 'world');
}

// 散装 .html + index.html + dist/ 三种抢跑证据同时出现，仍然必须是 world
await mk('tasks/t-world/预览.html');
await mk('tasks/t-world/index.html');
await mk('tasks/t-world/dist/index.html');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-world'));
  check('world 不被 deck/site 抢走', m.kind === 'world' && m.artifacts.length === 1,
    `实得 kind=${m.kind} artifacts=${m.artifacts.map(a => a.kind).join(',')}`);
  check('world 命中时不派生 deck/site 卡', !m.artifacts.some(a => a.kind !== 'world'));
}

// marker 兜底：世界书还没写出来的窗口期（agent 刚认领任务），也得判成 world，
// 否则那个散装 .html 会让它变成 deck
await mk('tasks/t-world-new/.nd-task.json', JSON.stringify({ kind: 'world' }));
await mk('tasks/t-world-new/草稿.html');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-world-new'));
  check('marker 声明的 world 不被散装 html 抢走', m.kind === 'world' && m.artifacts.length === 1);
}

// 根下角色：还没建任何地点就先建了人（世界/<角色>/角色.md，parent=null）。
// 合法的起步状态，describe 必须扛得住 —— 曾因 parent.split 不判空在这里抛异常，
// hooks 把它兜成「读不到」，世界的每轮注入清单整个静默丢失
await mk('tasks/t-world-rootchar/世界.md', '# 荒原');
await mk('tasks/t-world-rootchar/世界/流浪者/角色.md', '# 流浪者');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-world-rootchar'));
  const art = m.artifacts[0];
  check('根下角色成节点且 parent=null',
    art.nodes.length === 1 && art.nodes[0].type === 'character' && art.nodes[0].parent === null);
  let desc = null;
  let threw = null;
  try { desc = await world.describe(path.join(ws, 'tasks/t-world-rootchar'), art); } catch (e) { threw = e; }
  check('根下角色 describe 不抛异常', !threw, threw?.message);
  check('根下角色算在场', !!desc && desc.includes('流浪者'));
}

// 已声明为别的形态的任务，光多出一份 世界.md 不能翻案（2026-08-01 复查加）：
// 写小说设定的 deck 任务 agent 顺手写份「世界.md」很自然，翻成 world 会让
// 画布上的 deck 卡静默消失，且 marker 被回填成 world 加深粘性
await mk('tasks/t-deck-with-世界/canvas.html', '<section data-page="1"></section>');
await mk('tasks/t-deck-with-世界/世界.md', '# 这只是设定稿');
await mk('tasks/t-deck-with-世界/.nd-task.json', JSON.stringify({ kind: 'deck' }));
{
  const m = await taskManifest(path.join(ws, 'tasks/t-deck-with-世界'));
  check('已声明 deck + 一份世界.md + 无地图 → 仍是 deck', m.kind === 'deck', `实得 ${m.kind}`);
}
// 但建出 `世界/` 就是最明确的文件证据，改造得认
await mk('tasks/t-deck-with-世界/世界/王城/地点.md', '# 王城');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-deck-with-世界'));
  check('建出 世界/ 后翻成 world（改造路径没被堵死）', m.kind === 'world', `实得 ${m.kind}`);
}
// 没有 marker 的新任务不受这条影响
await mk('tasks/t-world-fresh/世界.md', '# 新世界');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-world-fresh'));
  check('无 marker 的新任务光靠 世界.md 就认', m.kind === 'world');
}

// 深度截断要报出来，不能静默少一块世界
{
  const deep = 'tasks/t-world-deep/世界/' + Array.from({ length: 10 }, (_, i) => `L${i}`).join('/');
  await mk('tasks/t-world-deep/世界.md', '# 深');
  await mk(`${deep}/角色.md`, '# 深处的人');
  const m = await taskManifest(path.join(ws, 'tasks/t-world-deep'));
  const art = m.artifacts[0];
  check('超深嵌套被截断且记了下来', art.truncated.length > 0, JSON.stringify(art.truncated));
  const d = await world.describe(path.join(ws, 'tasks/t-world-deep'), art);
  check('describe 点名截断', d.includes('截断'), d);
}

// 反向：没有 world 证据的任务不能被 world 误吞（KIND_ORDER 把它放最前的代价）
{
  const deckM = await taskManifest(path.join(ws, 'tasks/t-deck'));
  const siteM = await taskManifest(path.join(ws, 'tasks/t-built'));
  const mixedM = await taskManifest(path.join(ws, 'tasks/t-mixed'));
  check('world 前置不误伤 deck', deckM.kind === 'deck');
  check('world 前置不误伤 site', siteM.kind === 'site');
  check('world 前置不误伤混合任务', mixedM.kind === 'deck' && mixedM.artifacts.some(a => a.kind === 'site'));
}

console.log(`\n${pass}/${pass + fail} passed`);
await fs.rm(ws, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
