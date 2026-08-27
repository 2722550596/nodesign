// guard-rules（pi 安全闸 + lint 纯判据）：每道闸正反用例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  checkWorkspaceScope,
  checkPerformanceLog,
  lintCanvasFile,
  lintCanvasHtml,
  isCanvasFilePath,
  lintSiteFile,
  lintSiteHtml,
  isSitePagePath,
} from './guard-rules.js';

// ── 闸 ①：项目边界 ──

const dataRoot = '/data/projects-data';
const workspaceRoot = '/data/projects-data/proj_aaa/shared';

describe('checkWorkspaceScope 放行的', () => {
  it('自己工作区里的绝对路径 / 相对路径（读写都放）', () => {
    expect(checkWorkspaceScope({ toolName: 'read', input: { path: `${workspaceRoot}/站点/index.html` }, workspaceRoot, dataRoot })).toBeNull();
    expect(checkWorkspaceScope({ toolName: 'write', input: { path: '站点/index.html' }, workspaceRoot, dataRoot })).toBeNull();
    expect(checkWorkspaceScope({ toolName: 'ls', input: { path: '.' }, workspaceRoot, dataRoot })).toBeNull();
  });
  it('数据根之外的读不归它管（skill 目录、仓库、/tmp 要照读）', () => {
    expect(checkWorkspaceScope({ toolName: 'read', input: { path: '/home/x/projects/Nodesign/server/engine/plugins' }, workspaceRoot, dataRoot })).toBeNull();
    expect(checkWorkspaceScope({ toolName: 'grep', input: { path: '/tmp/whatever.png' }, workspaceRoot, dataRoot })).toBeNull();
  });
  it('没带 path 字段 / 名单外工具（MCP 工具）', () => {
    expect(checkWorkspaceScope({ toolName: 'read', input: { pattern: 'foo' }, workspaceRoot, dataRoot })).toBeNull();
    expect(checkWorkspaceScope({ toolName: 'screenshot_canvas', input: { path: `${dataRoot}/proj_bbb/x` }, workspaceRoot, dataRoot })).toBeNull();
    expect(checkWorkspaceScope({ toolName: 'read', input: undefined, workspaceRoot, dataRoot })).toBeNull();
  });
  it('缺 workspaceRoot / 读侧缺 dataRoot → 放行（fail-open）', () => {
    expect(checkWorkspaceScope({ toolName: 'read', input: { path: `${dataRoot}/proj_bbb/x` }, dataRoot })).toBeNull();
    expect(checkWorkspaceScope({ toolName: 'read', input: { path: `${dataRoot}/proj_bbb/x` }, workspaceRoot })).toBeNull();
  });
});

describe('checkWorkspaceScope 拦下的', () => {
  it('⭐ 别的项目的工作区 —— read/grep/find/ls 都走同一个判据', () => {
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      const r = checkWorkspaceScope({ toolName, input: { path: `${dataRoot}/proj_bbb/shared/秘密.md` }, workspaceRoot, dataRoot });
      expect(r?.block).toBe(true);
      expect(r.reason).toMatch(/别的项目/);
    }
  });
  it('用 ../ 爬出去的相对路径', () => {
    const r = checkWorkspaceScope({ toolName: 'read', input: { path: '../../proj_bbb/shared/x.md' }, workspaceRoot, dataRoot });
    expect(r?.block).toBe(true);
  });
  it('数据根本身（想列所有项目）', () => {
    expect(checkWorkspaceScope({ toolName: 'ls', input: { path: dataRoot }, workspaceRoot, dataRoot })?.block).toBe(true);
  });
  it('前缀相同但不是同一个目录（proj_aaa-evil 不算自己人）', () => {
    expect(checkWorkspaceScope({ toolName: 'read', input: { path: `${dataRoot}/proj_aaa-evil/shared/x` }, workspaceRoot, dataRoot })?.block).toBe(true);
  });
});

describe('checkWorkspaceScope 写工具更严：出了工作区就不许写', () => {
  const w = (p, toolName = 'write') => checkWorkspaceScope({ toolName, input: { path: p }, workspaceRoot, dataRoot });
  it('自己工作区里随便写', () => {
    expect(w('站点/index.html')).toBeNull();
    expect(w(`${workspaceRoot}/a.png`)).toBeNull();
  });
  it('⭐ 家目录 / 别的仓库 —— 读可以，写不行', () => {
    expect(checkWorkspaceScope({ toolName: 'read', input: { path: '/home/x/projects/SillyTavern' }, workspaceRoot, dataRoot })).toBeNull();
    expect(w('/home/x/projects/SillyTavern/server.js')?.reason).toMatch(/只能落在/);
    expect(w('/home/x/随手.txt', 'edit')?.reason).toMatch(/只能落在/);
  });
  it('临时目录放行（agent 写个临时脚本再跑是正常操作）', () => {
    expect(w('/tmp/scratch.sh')).toBeNull();
    expect(w(path.join(os.tmpdir(), 'nd-guard-scratch.txt'))).toBeNull();
  });
});

// ── 闸 ②：演出记录隐私 ──

describe('checkPerformanceLog 演出记录隐私闸', () => {
  let root;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-guard-'));
    await fs.mkdir(path.join(root, '戏'), { recursive: true });
    await fs.writeFile(path.join(root, '戏/编排.yaml'), '历史:\n  文件: 记录.jsonl\n系统层: []\n');
    await fs.writeFile(path.join(root, '戏/对话.jsonl'), '');
    await fs.mkdir(path.join(root, '普通'), { recursive: true });
    await fs.writeFile(path.join(root, '普通/对话.jsonl'), '');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('演出文件夹的固定名与自定义记录名点名读 → 拒；其余文件 → 放行', async () => {
    for (const f of ['戏/对话.jsonl', '戏/摘要.json', '戏/记录.jsonl']) {
      const r = await checkPerformanceLog({ toolName: 'read', input: { path: path.join(root, f) }, workspaceRoot: root });
      expect(r?.block).toBe(true);
      expect(r.reason).toContain('隐私');
    }
    expect(await checkPerformanceLog({ toolName: 'read', input: { path: path.join(root, '戏/编排.yaml') }, workspaceRoot: root })).toBeNull();
    expect(await checkPerformanceLog({ toolName: 'read', input: { path: path.join(root, '戏/index.html') }, workspaceRoot: root })).toBeNull();
  });

  it('同名文件但同目录没有 编排.yaml → 放行（不是演出文件夹）', async () => {
    expect(await checkPerformanceLog({ toolName: 'read', input: { path: path.join(root, '普通/对话.jsonl') }, workspaceRoot: root })).toBeNull();
  });

  it('相对路径按工作区根解析；grep 的 path 字段同判', async () => {
    expect((await checkPerformanceLog({ toolName: 'read', input: { path: '戏/对话.jsonl' }, workspaceRoot: root }))?.block).toBe(true);
    expect((await checkPerformanceLog({ toolName: 'grep', input: { path: '戏/对话.jsonl' }, workspaceRoot: root }))?.block).toBe(true);
  });

  it('目录扫描（find/ls）与写（write）不拦 —— 边界照源闸写死', async () => {
    expect(await checkPerformanceLog({ toolName: 'ls', input: { path: '戏' }, workspaceRoot: root })).toBeNull();
    expect(await checkPerformanceLog({ toolName: 'find', input: { path: '戏' }, workspaceRoot: root })).toBeNull();
    expect(await checkPerformanceLog({ toolName: 'write', input: { path: '戏/对话.jsonl', content: '' }, workspaceRoot: root })).toBeNull();
  });

  it('⚠️ 记录名只认 历史.文件：系统层条目的设定文件不算（正则版误伤事故史）', async () => {
    await fs.mkdir(path.join(root, '城'), { recursive: true });
    await fs.writeFile(path.join(root, '城/编排.yaml'),
      '系统层:\n  - 名字: 身份\n    文件: 叙述者.md\n历史:\n  文件: 对话.jsonl\n');
    await fs.writeFile(path.join(root, '城/叙述者.md'), '# 叙述者\n');
    // 正则版会把 叙述者.md 当成记录名连读都不让读——它就躺在 编排.yaml 边上
    expect(await checkPerformanceLog({ toolName: 'read', input: { path: '城/叙述者.md' }, workspaceRoot: root })).toBeNull();
    expect((await checkPerformanceLog({ toolName: 'read', input: { path: '城/对话.jsonl' }, workspaceRoot: root }))?.block).toBe(true);
  });

  it('半写完的 YAML 解析失败 → 只认固定两个名（fail-open 不误伤）', async () => {
    await fs.mkdir(path.join(root, '坏'), { recursive: true });
    await fs.writeFile(path.join(root, '坏/编排.yaml'), '历史:\n  文件: [没闭合\n');
    expect((await checkPerformanceLog({ toolName: 'read', input: { path: '坏/对话.jsonl' }, workspaceRoot: root }))?.block).toBe(true);
    expect(await checkPerformanceLog({ toolName: 'read', input: { path: '坏/别的.md' }, workspaceRoot: root })).toBeNull();
  });
});

// ── lint ①：canvas（deck）三条硬规则 ──

describe('lintCanvasFile / lintCanvasHtml deck 三规则', () => {
  const deckWrap = '<div id="__nd-deck-wrap"></div>';

  it('规则 1 反例：data-anchor 重名 → 报冲突 + 页号', () => {
    const html = `${deckWrap}
      <section data-page="1" data-layout-role="text-led"><h2 data-anchor="cover">A</h2></section>
      <section data-page="2" data-layout-role="text-led"><h2 data-anchor="cover">B</h2></section>`;
    const r = lintCanvasHtml(html);
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/data-anchor 重名 1 处/);
    expect(r[0].detail).toContain('"cover"');
  });
  it('规则 1 正例：anchor 唯一 → 干净；HTML 注释里的范例 anchor 不算（strip 防误伤）', () => {
    const html = `${deckWrap}
      <!-- 骨架范例：<h2 data-anchor="cover">…</h2> -->
      <section data-page="1" data-layout-role="text-led"><h2 data-anchor="cover">A</h2></section>`;
    expect(lintCanvasHtml(html)).toEqual([]);
  });

  it('规则 2 反例：data-layout 命中触发表但 babel 段没有推荐组件 → 报', () => {
    const html = `${deckWrap}
      <section data-page="1" data-layout="feature-cards" data-layout-role="text-led"></section>
      <script type="text/babel">const App = () => <div>plain</div>;</script>`;
    const r = lintCanvasHtml(html);
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/漏用推荐组件/);
    expect(r[0].detail).toContain('feature-cards');
  });
  it('规则 2 正例：babel 段用了 <Card> → 干净；触发表外的 layout 不管', () => {
    const html = `${deckWrap}
      <section data-page="1" data-layout="feature-cards" data-layout-role="text-led"></section>
      <section data-page="2" data-layout="custom-thing" data-layout-role="hybrid"></section>
      <script type="text/babel">const App = () => <Card><CardTitle>t</CardTitle></Card>;</script>`;
    expect(lintCanvasHtml(html)).toEqual([]);
  });

  it('规则 3 反例：section 缺 data-layout-role → 报页号', () => {
    const html = `${deckWrap}
      <section data-page="1" data-layout-role="image-led"></section>
      <section data-page="2"></section>`;
    const r = lintCanvasHtml(html);
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/1 个 section 缺 data-layout-role/);
    expect(r[0].detail).toContain('Page 2');
  });
  it('规则 3 正例：每个 section 都标了 role → 干净', () => {
    const html = `${deckWrap}
      <section data-page="1" data-layout-role="image-led"></section>
      <section data-page="2" data-layout-role="data-led"></section>`;
    expect(lintCanvasHtml(html)).toEqual([]);
  });

  it('lintCanvasFile 认定闸：canvas.html 名字或 __nd-deck-wrap 标记才算 deck', () => {
    const bad = '<section data-page="1"></section>';   // 缺 role，真 deck 会报
    expect(lintCanvasFile('canvas.html', bad)).toHaveLength(1);
    expect(lintCanvasFile('我的演示.html', `<div id="__nd-deck-wrap"></div>${bad}`)).toHaveLength(1);
    expect(lintCanvasFile('我的演示.html', bad)).toEqual([]);   // 无标记 → 不是 deck
    expect(lintCanvasFile('notes.md', bad)).toEqual([]);        // 非 html
    expect(isCanvasFilePath('canvas.html', '')).toBe(true);
    expect(isCanvasFilePath('site/about.html', '')).toBe(false);
  });
});

// ── lint ②：站点页两条硬规则 ──

describe('lintSiteFile / lintSiteHtml 站点两规则', () => {
  const W = '/ws';
  const ok = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="style.css"></head>
<body><a href="about.html">关于</a><img src="assets/x.png"><a href="//cdn.example.com/x.js">cdn</a>
<!-- <a href="/commented-out">x</a> --><script>const s = '/not-markup';</script></body></html>`;

  it('规则 1 反例：缺 viewport 报一条', () => {
    const r = lintSiteHtml(ok.replace(/<meta name="viewport"[^>]*>/, ''));
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/viewport/);
  });
  it('规则 1 正例：干净页面零问题；注释/脚本里的根路径不算', () => {
    expect(lintSiteHtml(ok)).toEqual([]);
  });

  it('规则 2 反例：根路径 href/src 报一条并列出样本；协议相对不算', () => {
    const r = lintSiteHtml(ok.replace('href="about.html"', 'href="/about.html"').replace('src="assets/x.png"', 'src="/assets/x.png"'));
    expect(r).toHaveLength(1);
    expect(r[0].title).toMatch(/根路径链接 2 处.*\/about\.html.*\/assets\/x\.png/);
  });
  it('规则 2 正例：站内相对路径不报', () => {
    expect(lintSiteHtml(ok)).toEqual([]);
  });

  it('isSitePagePath：子目录里的 html 算站点页；根上的 deck、exports、_drafts、非 html 不算', () => {
    expect(isSitePagePath(W, '/ws/观察日志/index.html')).toBe(true);
    expect(isSitePagePath(W, '观察日志/about.html')).toBe(true);
    expect(isSitePagePath(W, '/ws/deck.html')).toBe(false);
    expect(isSitePagePath(W, '/ws/exports/site/index.html')).toBe(false);
    expect(isSitePagePath(W, '/ws/_drafts/单页.html')).toBe(false);
    expect(isSitePagePath(W, '/ws/观察日志/style.css')).toBe(false);
    expect(isSitePagePath(W, '/elsewhere/x/index.html')).toBe(false);
  });

  it('lintSiteFile 非站点路径不 lint（根 deck / exports / 工作区外 → 空）', () => {
    const bad = ok.replace(/<meta name="viewport"[^>]*>/, '').replace('href="about.html"', 'href="/about.html"');
    expect(lintSiteFile('/ws/deck.html', bad, W)).toEqual([]);
    expect(lintSiteFile('/ws/exports/site/index.html', bad, W)).toEqual([]);
    expect(lintSiteFile('/ws/_drafts/单页.html', bad, W)).toEqual([]);
    expect(lintSiteFile('/elsewhere/x/index.html', bad, W)).toEqual([]);
    expect(lintSiteFile('观察日志/index.html', bad, W)).toHaveLength(2);   // 站点页照 lint
  });

  it('lintSiteFile 排除收进文件夹的 deck（__nd-deck-wrap 标记）', () => {
    const bad = '<div id="__nd-deck-wrap"></div><html><body><a href="/x">x</a></body></html>';
    expect(lintSiteFile('观察日志/canvas.html', bad, W)).toEqual([]);
  });
});
