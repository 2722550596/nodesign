/**
 * kinds 注册表冒烟（多产物平权版，2026-07-29）。
 * 跑法：node lib/kinds/_kinds-check.mjs（在 server/ 下）
 * 纯文件系统 fixture，不起服务。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { taskManifest, artifactOfPath } from './index.js';
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
  // 扁平化口径：workspaceRoot 就是任务目录本身（老写法拿总夹具根当工作区，
  // 是任务时代的问法，2026-08-24 修正——之前一直 FAIL 没人看）
  const t = await resolveArtifactTarget(path.join(ws, 'tasks/t-twins'), 'v2/index.html', null);
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

{
  const deckM = await taskManifest(path.join(ws, 'tasks/t-deck'));
  const siteM = await taskManifest(path.join(ws, 'tasks/t-built'));
  const mixedM = await taskManifest(path.join(ws, 'tasks/t-mixed'));
  check('deck 判定不被别的形态抢走', deckM.kind === 'deck');
  check('site 判定不被别的形态抢走', siteM.kind === 'site');
  check('混合任务 deck 打头且 site 并列', mixedM.kind === 'deck' && mixedM.artifacts.some(a => a.kind === 'site'));
}

// ── fixture 6：现代构建工程（08-24 案）──
// 源 index.html 与 dist/index.html 并存：源引用 /src/main.tsx（构建源证据），
// 产物根必须落 dist，源入口不能被当成可预览产物（白屏案）
const VITE_SRC = '<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head><body></body></html>';
await mk('tasks/t-vite/index.html', VITE_SRC);
await mk('tasks/t-vite/src/main.tsx', 'export {}');
await mk('tasks/t-vite/dist/index.html');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-vite'));
  const site = m.artifacts.find(a => a.kind === 'site' && !a.single);
  check('源与产物并存时产物根=dist', site?.root === 'dist' && site.entryRel === 'dist/index.html');
}
// 还没 build 出产物时：退回任务根（寻址不落空），build 完自动切换
await mk('tasks/t-vite-fresh/index.html', VITE_SRC);
await mk('tasks/t-vite-fresh/src/main.tsx', 'export {}');
{
  const m = await taskManifest(path.join(ws, 'tasks/t-vite-fresh'));
  const site = m.artifacts.find(a => a.kind === 'site' && !a.single);
  check('构建源未 build 时退回任务根', site?.root === '');
}

// ── fixture 7：构建型**子目录**站（08-24 案）──
// 站住自己的文件夹，源 + dist 都在夹内；子目录自己的 marker 也要被读到
await mk('tasks/t-sub/mysite/index.html', VITE_SRC);
await mk('tasks/t-sub/mysite/src/main.tsx', 'export {}');
await mk('tasks/t-sub/mysite/dist/index.html');
await mk('tasks/t-sub/marked/source/entry.html');   // 无常规产物证据，纯靠 marker
await mk('tasks/t-sub/marked/.nd-project.json', JSON.stringify({ root: 'source' }));
{
  const m = await taskManifest(path.join(ws, 'tasks/t-sub'));
  const sites = m.artifacts.filter(a => a.kind === 'site' && !a.single);
  const built = sites.find(s => s.srcRoot === 'mysite');
  const marked = sites.find(s => s.srcRoot === 'marked');
  check('子目录构建站产物根=夹内 dist', built?.root === 'mysite/dist' && built.entryRel === 'mysite/dist/index.html' && built.pages.includes('index.html'));
  check('子目录自己的 marker 被读到', marked?.root === 'marked/source');
  const t = await resolveArtifactTarget(path.join(ws, 'tasks/t-sub'), 'index.html', null);
  check('产物根相对路径回退补前缀', t.ok && t.relPath === 'mysite/dist/index.html');
}

console.log(`\n${pass}/${pass + fail} passed`);
await fs.rm(ws, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
