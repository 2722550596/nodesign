/**
 * lib/cover.js — 项目封面（首页卡片缩略图）
 *
 * 为什么是截图而不是 iframe：
 *   首页早期版本用 iframe 直接挂 canvas.html 当封面，且 sandbox 不给 allow-scripts
 *   （一屏十几张卡，放开脚本等于每张卡都跑一遍生成页的动画 / 3D）。代价是**凡是靠
 *   JS 出画面的产物封面全是空白**——站点的滚动揭示、three.js 场景、图表库全中招。
 *   服务端截一次图就没这个矛盾：脚本在 chromium 里真跑，浏览器只收一张 JPEG。
 *
 * 选谁当封面：/artifacts 的口径——任务目录 mtime 新→旧，第一个真有产物的任务的
 * artifacts[0]（形态注册表已经把 canvas.html / 根 index.html 排在别的稿前面）。
 *
 * 取景按形态：
 *   deck — viewport = 真实画幅（16:9 / 16:10 / 9:16 / 4:3），整页入镜
 *   site — 页面高度无上界，按桌面宽 1440 渲染取顶部一屏（首屏即封面）
 *
 * 缓存：<cacheDir>/<pid>/<sha1(任务|入口|mtime|宽)>.jpg。key 带源 mtime，
 * agent 改完产物下次请求自然重截；旧文件留着不清（一个项目也就攒几张几十 KB）。
 * 并发：截图串行（chromium 一次一个），十张卡同时冷启也只排队不炸内存。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { taskManifest } from './kinds/index.js';
import { resolveDeckSize, extractDeckAspect } from '../shared/deck.js';

const SITE_VIEWPORT = { width: 1440, height: 900 };
const OUT_WIDTH = 800;          // 出图宽度（卡片最宽也就 ~400 CSS px，2x 足够）
const CACHE_DIR = path.join(process.cwd(), 'server', '.cache', 'covers');

/** 截图串行闸门 —— 冷启动时十张卡同时请求也只有一个 chromium 在跑 */
let renderChain = Promise.resolve();
function serialize(fn) {
  const next = renderChain.then(fn, fn);
  renderChain = next.catch(() => {});
  return next;
}

/**
 * 选出项目封面产物。
 * @returns {Promise<null | { taskId, kind, view, absPath, relPath, mtimeMs }>}
 */
export async function pickCoverArtifact(sharedDir) {
  const tasksDir = path.join(sharedDir, 'tasks');
  let entries;
  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true });
  } catch { return null; }

  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const st = await fs.stat(path.join(tasksDir, e.name));
      dirs.push({ name: e.name, mtimeMs: st.mtimeMs });
    } catch { /* 扫到一半被删：跳过 */ }
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const d of dirs) {
    const taskDir = path.join(tasksDir, d.name);
    const manifest = await taskManifest(taskDir).catch(() => null);
    const art = manifest?.artifacts?.[0];
    if (!art) continue;
    const absPath = path.join(taskDir, art.entryRel);
    let fileMtime = 0;
    try {
      fileMtime = (await fs.stat(absPath)).mtimeMs;
    } catch { continue; }   // 入口是声明出来的但还没写盘 → 换下一个任务
    return {
      taskId: d.name,
      kind: art.kind,
      view: art.view,
      absPath,
      relPath: `tasks/${d.name}/${art.entryRel}`,
      // 目录 mtime 管增删、文件 mtime 管重写，取大的当缓存 key
      mtimeMs: Math.max(d.mtimeMs, fileMtime),
    };
  }
  return null;
}

/**
 * 真正跑一次 chromium，返回 JPEG buffer。
 * 导出是为了能单独对某个产物验证取景（缓存/选片逻辑之外的那一半）。
 * @param {{ absPath: string, kind: 'deck'|'site' }} cover
 */
export async function renderCoverShot(cover) {
  const { chromium } = await import('playwright');
  const html = await fs.readFile(cover.absPath, 'utf8').catch(() => '');
  const viewport = cover.kind === 'deck'
    ? (() => { const d = resolveDeckSize(extractDeckAspect(html)); return { width: d.width, height: d.height }; })()
    : SITE_VIEWPORT;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto('file://' + cover.absPath, { waitUntil: 'networkidle', timeout: 20_000 });
    // 字体加载完再截（同导出管线的口径：CJK 子集是 lazy 的，不显式 load 会截到 fallback）
    await page.evaluate(async () => {
      document.body.offsetHeight;
      await Promise.all(Array.from(document.fonts).map(f => f.load().catch(() => {})));
      await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }).catch(() => { /* 页面自己抛错也照样截，截到什么算什么 */ });
    // deck 的 standalone-fit 脚本在真实 viewport 下会再缩一次，抹掉它
    await page.addStyleTag({ content: `
      body { margin: 0 !important; padding: 0 !important; }
      body.__nd-fit-active > .__nd-deck-wrap > .__nd-page-frame {
        width: ${viewport.width}px !important; height: ${viewport.height}px !important;
        display: block !important; overflow: visible !important;
      }
      body.__nd-fit-active section[data-page] { transform: none !important; }
    ` }).catch(() => {});
    await page.waitForTimeout(600);   // 给入场动画 / 首帧渲染一点时间
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...viewport } });
    await ctx.close();

    const { default: sharp } = await import('sharp');
    return await sharp(png)
      .resize({ width: OUT_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * 指定产物的封面目标（橱窗用：某件具体作品，不是"项目最新那件"）。
 * @param {string} relPath  'tasks/<任务>/<入口>'
 */
export async function resolveCoverTarget(sharedDir, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts[0] !== 'tasks' || parts.length < 3 || parts.includes('..')) return null;
  const taskId = parts[1];
  const taskDir = path.join(sharedDir, 'tasks', taskId);
  const absPath = path.join(sharedDir, ...parts);
  if (!absPath.startsWith(taskDir + path.sep)) return null;
  let fileMtime = 0;
  try {
    fileMtime = (await fs.stat(absPath)).mtimeMs;
  } catch { return null; }
  const manifest = await taskManifest(taskDir).catch(() => null);
  const entryRel = parts.slice(2).join('/');
  const art = manifest?.artifacts?.find(a => a.entryRel === entryRel) || manifest?.artifacts?.[0];
  return {
    taskId,
    kind: art?.kind || 'site',   // 认不出来按 site 取景（首屏一屏，比硬套 16:9 安全）
    view: art?.view || 'site',
    absPath,
    relPath: rel,
    mtimeMs: fileMtime,
  };
}

/**
 * 拿项目封面 JPEG（命中缓存直接读盘，否则截一张）。
 * @returns {Promise<null | { buffer, etag, cover }>}  没有任何产物时返回 null
 */
export async function getProjectCover(pid, sharedDir) {
  const cover = await pickCoverArtifact(sharedDir);
  if (!cover) return null;
  return renderOrRead(pid, cover);
}

/** 指定产物的封面（橱窗卡片） */
export async function getArtifactCover(pid, sharedDir, relPath) {
  const cover = await resolveCoverTarget(sharedDir, relPath);
  if (!cover) return null;
  return renderOrRead(pid, cover);
}

async function renderOrRead(pid, cover) {
  const etag = crypto.createHash('sha1')
    .update(`${cover.relPath}|${cover.mtimeMs}|${OUT_WIDTH}`)
    .digest('hex');
  const file = path.join(CACHE_DIR, pid, `${etag}.jpg`);

  try {
    return { buffer: await fs.readFile(file), etag, cover };
  } catch { /* 未命中 → 截 */ }

  const buffer = await serialize(async () => {
    // 排队期间可能已经被前一个同 key 的请求截好了，再看一眼再动手
    try { return await fs.readFile(file); } catch { /* */ }
    const buf = await renderCoverShot(cover);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
    return buf;
  });
  return { buffer, etag, cover };
}
