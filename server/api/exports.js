/**
 * server/api/exports.js — 用户主动导出（H3：session-scoped）
 *
 * 路径全加 sid（H3 改造）：
 *   GET /api/projects/:pid/sessions/:sid/exports                列已生成交付包
 *   GET /api/projects/:pid/sessions/:sid/exports/file/:filename 单文件下载
 *   GET /api/projects/:pid/sessions/:sid/exports/html           导出 canvas.html
 *   GET /api/projects/:pid/sessions/:sid/exports/pdf            playwright print → PDF
 *   GET /api/projects/:pid/sessions/:sid/exports/handoff        JSZip 工程交付包
 *
 * 文件位置：
 *   <workspace>/sessions/<sid>/exports/  ← 已生成的导出包（agent 调
 *                                            mcp__nodesign__export_handoff 也写这）
 *   <workspace>/sessions/<sid>/canvas.html, spec.json
 *   <workspace>/shared/assets/           ← handoff 打包时从这取共享 assets
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import JSZip from 'jszip';
import { validateProjectId, getProject, listRunsForProject } from '../projects/store.js';
import {
  getSessionWorkspace, getSharedDir, validateSessionId,
} from '../projects/workspace.js';
import { DECK, resolveDeckSize, extractDeckAspect } from '../shared/deck.js';
import { fitInjectionBlock } from './standalone-fit.js';
import { buildStandaloneHtml, isHybridHtml, inlineLocalImages } from './exports/build-standalone.js';

const router = express.Router();

function guard(req, res) {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
  } catch (err) {
    res.status(400).json({ error: err.message || 'invalid pid/sid' });
    return null;
  }
  const project = getProject(req.params.pid);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

function safeFilename(name) {
  return (name || 'design').replace(/[^A-Za-z0-9._一-龥-]/g, '_').slice(0, 60);
}

// ── 已生成的交付包列表 ──
router.get('/:pid/sessions/:sid/exports', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const exportsDir = path.join(sessionRoot, 'exports');

    let entries;
    try {
      entries = await fs.readdir(exportsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ files: [] });
      throw err;
    }

    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const stat = await fs.stat(path.join(exportsDir, e.name));
        files.push({ name: e.name, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch { /* skip unreadable */ }
    }
    files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ files });
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/exports/file/:filename', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);

    const filename = req.params.filename;
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const filePath = path.join(sessionRoot, 'exports', filename);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'file not found' });
    }

    const ext = filename.toLowerCase().split('.').pop();
    const mime = ext === 'zip' ? 'application/zip'
      : ext === 'pdf' ? 'application/pdf'
      : ext === 'html' ? 'text/html; charset=utf-8'
      : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const buf = await fs.readFile(filePath);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/exports/html', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    let html;
    try {
      html = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'canvas.html not yet generated' });
      throw err;
    }

    // Hybrid 文件 → 走自包含构建管道（CDN 全 inline，离线可双击打开）
    // 老 deck（无 babel script）→ 降级到 injectViewportFit 文本替换
    // 任一步骤失败也降级——保证用户至少拿到能用的 HTML
    if (isHybridHtml(html)) {
      try {
        // 传 sessionRoot 让 build-standalone 能 inline 本地图片（assets/generated/...）
        html = await buildStandaloneHtml(html, { sessionRoot });
      } catch (err) {
        // standalone 任何一步炸——管道里图片 inline 也不会跑，用户拿到的 HTML
        // 离开 session 目录后 <img src="assets/..."> 全 404。降级路径必须仍把
        // 图片 inline 一遍兜底，否则一次 esbuild 失败 = 整个 deck 图片全丢。
        console.warn('[exports/html] standalone build failed, falling back to viewport-fit:', err.message);
        html = injectViewportFit(html);
        try {
          html = await inlineLocalImages(html, sessionRoot);
        } catch (e2) {
          console.warn('[exports/html] image inline fallback also failed:', e2.message);
        }
      }
    } else {
      html = injectViewportFit(html);
      try {
        html = await inlineLocalImages(html, sessionRoot);
      } catch (e) {
        console.warn('[exports/html] image inline (legacy path) failed:', e.message);
      }
    }

    const filename = `${safeFilename(project.name)}.html`;
    // application/octet-stream 绕过 Cloudflare HTML 处理（Auto Minify / Rocket Loader）
    // 否则 19MB base64 HTML 会被 CF 尝试 parse/minify → 吞吐降到 7KB/s
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.send(html);
  } catch (err) { next(err); }
});

// PDF：跟 PPTX 同款位图方案——截每页 PNG → 拼成 HTML → page.pdf 输出。
//
// 为什么不直接 page.pdf 渲染原 deck？Chromium PDF 后端对 Google Fonts 拆 80+
// 个 unicode-range subset + data URL inline 的 web font 无法做正常字体子集化
// 嵌入，全部退回 Type 3（路径填充）渲染——CJK 字体严重失真，跟 HTML/preview
// 对不上。截图方案把字体烤成像素，绕开 PDF 字体嵌入管道，视觉跟 HTML 1:1。
//
// 代价：PDF 文字不可选/不可搜索（位图）；文件略大（每页一张 PNG）。
// 跟 PPTX 已有方案对齐——用户工作流"看完发邮件/打印"为主，可接受。
router.get('/:pid/sessions/:sid/exports/pdf', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    try {
      await fs.access(file);
    } catch {
      return res.status(404).json({ error: 'canvas.html not yet generated' });
    }

    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      return res.status(500).json({
        error: 'playwright chromium not installed — run `npx playwright install chromium`',
        details: err.message,
      });
    }

    let prepCleanup = async () => {};
    try {
      const { page, ctx, pageSize, cleanup } = await prepareExportPage(browser, file, { sessionRoot });
      prepCleanup = cleanup;

      const sectionHandles = await page.$$('section[data-page]');
      if (sectionHandles.length === 0) {
        await ctx.close();
        return res.status(400).json({
          error: 'canvas.html 没有 <section data-page="N"> 分页结构 — 无法转 PDF',
        });
      }

      // 拿排好序的 section + bbox（跟 PPTX 路径完全一致）
      const pageInfos = [];
      for (const handle of sectionHandles) {
        const pageNum = await handle.getAttribute('data-page');
        const bbox = await handle.boundingBox();
        pageInfos.push({ handle, pageNum: parseInt(pageNum, 10) || 0, bbox });
      }
      pageInfos.sort((a, b) => a.pageNum - b.pageNum);

      // 每页截 PNG（pageSize 已被 prepareExportPage 中和掉 fit transform，原坐标）
      const pngs = [];
      for (const { handle, bbox } of pageInfos) {
        const clipOpts = bbox
          ? { clip: { x: bbox.x, y: bbox.y, width: pageSize.w, height: pageSize.h } }
          : {};
        const buf = await handle.screenshot({ type: 'png', ...clipOpts });
        pngs.push(buf);
      }

      // 拼成多页 HTML：每页一个 .slide 容器 + img 满铺，page-break 控制分页
      const slidesHtml = pngs.map((buf) =>
        `<div class="slide"><img src="data:image/png;base64,${buf.toString('base64')}"/></div>`,
      ).join('\n');

      const composeHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${pageSize.w}px ${pageSize.h}px; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .slide {
    width: ${pageSize.w}px;
    height: ${pageSize.h}px;
    page-break-after: always;
    page-break-inside: avoid;
    break-after: page;
    break-inside: avoid;
    overflow: hidden;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  img { display: block; width: 100%; height: 100%; }
</style></head><body>
${slidesHtml}
</body></html>`;

      // 复用同 page setContent —— 不需要新开 page，省一次 launch 开销
      await page.setContent(composeHtml, { waitUntil: 'load' });

      const pdfBuffer = await page.pdf({
        width: `${pageSize.w}px`,
        height: `${pageSize.h}px`,
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      await ctx.close();

      const filename = `${safeFilename(project.name)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.end(pdfBuffer);
    } finally {
      await browser.close().catch(() => { /* ignore */ });
      await prepCleanup();
    }
  } catch (err) { next(err); }
});

// PPTX：playwright 截每个 section[data-page] PNG → pptxgenjs 嵌图
// MVP 位图方案：用户拿到的 PPTX 文字不可编辑（每页是图），但视觉 1:1 还原
// 16:9 默认 layout（10" × 5.625"）匹配 deck 1920×1080 比例（pageSize.h/pageSize.w * 10 公式自动算）
router.get('/:pid/sessions/:sid/exports/pptx', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    try {
      await fs.access(file);
    } catch {
      return res.status(404).json({ error: 'canvas.html not yet generated' });
    }

    const { chromium } = await import('playwright');
    const PptxGenJS = (await import('pptxgenjs')).default;

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      return res.status(500).json({
        error: 'playwright chromium not installed — run `npx playwright install chromium`',
        details: err.message,
      });
    }

    let prepCleanup = async () => {};
    try {
      const { page, ctx, pageSize, cleanup } = await prepareExportPage(browser, file, { sessionRoot });
      prepCleanup = cleanup;

      const sectionHandles = await page.$$('section[data-page]');
      if (sectionHandles.length === 0) {
        await ctx.close();
        return res.status(400).json({
          error: 'canvas.html 没有 <section data-page="N"> 分页结构 — 无法转 PPTX',
        });
      }

      const pageInfos = [];
      for (const handle of sectionHandles) {
        const pageNum = await handle.getAttribute('data-page');
        const bbox = await handle.boundingBox();
        pageInfos.push({ handle, pageNum: parseInt(pageNum, 10) || 0, bbox });
      }
      pageInfos.sort((a, b) => a.pageNum - b.pageNum);

      const slideW = 10;
      const slideH = pageSize.h / pageSize.w * slideW;
      const pres = new PptxGenJS();
      pres.defineLayout({ name: 'DECK', width: slideW, height: slideH });
      pres.layout = 'DECK';
      pres.title = safeFilename(project.name);

      for (const { handle, pageNum, bbox } of pageInfos) {
        const clipOpts = bbox
          ? { clip: { x: bbox.x, y: bbox.y, width: pageSize.w, height: pageSize.h } }
          : {};
        const buf = await handle.screenshot({ type: 'png', ...clipOpts });
        const slide = pres.addSlide();
        slide.addImage({
          data: `data:image/png;base64,${buf.toString('base64')}`,
          x: 0, y: 0, w: slideW, h: slideH,
        });
        slide.addNotes(`Page ${pageNum} — exported from NoDesign canvas.html`);
      }
      await ctx.close();

      // pptxgenjs write 到 nodebuffer
      const pptxBuffer = await pres.write({ outputType: 'nodebuffer' });
      const filename = `${safeFilename(project.name)}.pptx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Length', pptxBuffer.length);
      res.end(pptxBuffer);
    } finally {
      await browser.close().catch(() => { /* ignore */ });
      await prepCleanup();
    }
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/exports/handoff', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const sharedRoot = getSharedDir(req.params.pid);
    const runs = listRunsForProject(req.params.pid);

    const zipBuffer = await buildHandoffZip(sessionRoot, sharedRoot, {
      projectId: project.id,
      projectName: project.name,
      skillId: project.skillId,
      sessionId: req.params.sid,
      runs,
    });

    const filename = `${safeFilename(project.name)}-handoff.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.end(zipBuffer);
  } catch (err) { next(err); }
});

/**
 * 共享 handoff 打包逻辑 —— HTTP 路由 + MCP tool（export_handoff）共用。
 *
 * @param {string} sessionRoot  sessions/<sid>/ 绝对路径（canvas/spec 在这）
 * @param {string} sharedRoot   shared/ 绝对路径（assets 在这）
 */
export async function buildHandoffZip(sessionRoot, sharedRoot, { projectId, projectName, skillId, sessionId, runs = [] } = {}) {
  const zip = new JSZip();

  try {
    const html = await fs.readFile(path.join(sessionRoot, 'canvas.html'), 'utf8');
    zip.file('design/canvas.html', html);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    zip.file('design/canvas.html', '<!-- canvas.html not yet generated -->');
  }

  try {
    const spec = await fs.readFile(path.join(sessionRoot, 'spec.json'), 'utf8');
    zip.file('design/spec.json', spec);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // assets 来自 shared/（跨 session 共享）—— 递归走子目录，
  // 主要是 assets/generated/（generate_image MCP 落档处）必须进 zip，
  // 否则 canvas.html 里的 <img src="assets/generated/..."> 在打开导出时全 404。
  const assetsDir = path.join(sharedRoot, 'assets');
  await zipDirRecursive(zip, assetsDir, 'design/assets');

  const chatHistory = (runs || []).map((row) => ({ runId: row.id }));
  zip.file('chat-history.json', JSON.stringify({ projectId, sessionId, runs: chatHistory }, null, 2));

  zip.file('prompt.txt', '');
  zip.file('README.md', renderReadme({ id: projectId, name: projectName, skillId, sessionId }));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * 递归把 srcDir 下所有文件加进 zip（保留相对路径），dst 是 zip 内根前缀。
 * srcDir 不存在时静默 noop（fail-soft）。子目录中的 dotfile / 软链按需可扩展。
 */
async function zipDirRecursive(zip, srcDir, dstPrefix) {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const srcAbs = path.join(srcDir, e.name);
    const dstRel = `${dstPrefix}/${e.name}`;
    if (e.isDirectory()) {
      await zipDirRecursive(zip, srcAbs, dstRel);
      continue;
    }
    if (!e.isFile()) continue;  // 跳软链 / fifo 等
    const buf = await fs.readFile(srcAbs);
    zip.file(dstRel, buf);
  }
}

function renderReadme(project) {
  return `# ${project.name}

NoDesign 工程交付包。

## 文件结构

- \`design/canvas.html\` — 单文件 self-contained HTML，主产物
- \`design/spec.json\` — 设计意图档案（agent 私域记忆）
- \`design/assets/\` — 项目共享素材
- \`chat-history.json\` — runs 摘要
- \`prompt.txt\` — 占位

## 怎么用

直接在浏览器打开 \`design/canvas.html\` 看 deck。
导出 PDF：用浏览器打印（${DECK.width}×${DECK.height} 视口最佳）。

---
导出时间：${new Date().toISOString()}
项目 ID：${project.id}
Session ID：${project.sessionId}
Skill：${project.skillId}
`;
}

/**
 * 共用导出准备：启 Playwright page、等字体/图片就绪、注入基线 reset、探测实际 section 尺寸。
 * 返回 { page, ctx, pageSize: { w, h } }。
 *
 * 多比例支持：先读 canvas.html 抽 wrap data-deck-aspect → 设对应 viewport
 * （16:9=1920×1080 / 9:16=1080×1920 / 4:3=1440×1080）。
 */
async function prepareExportPage(browser, filePath, opts = {}) {
  const dpr = opts.dpr ?? 2;

  // 读文件抽 deck 比例 → 决定 viewport
  const html = await fs.readFile(filePath, 'utf8').catch(() => '');
  const aspect = extractDeckAspect(html);
  const dims = resolveDeckSize(aspect);

  // 跑跟 /exports/html 同款 standalone 管道——把 Google Fonts / 本地图片 / CDN
  // 全 inline，写到 tmp 文件让 Playwright 从那加载。这样 PDF/PPT 用的字体跟
  // HTML 下载产物 1:1，不再依赖 server 能否 reach fonts.googleapis.com（国内
  // 网络 / firewall 直接封死的话原方案 PDF 字体会无声 fallback 到系统字体）。
  // hybrid 检测失败或 build 失败 → fallback 到原 file://，至少导出能跑通。
  let loadPath = filePath;
  let cleanup = async () => {};
  if (isHybridHtml(html)) {
    try {
      const baked = await buildStandaloneHtml(html, { sessionRoot: opts.sessionRoot });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-export-'));
      const tmpFile = path.join(tmpDir, 'baked.html');
      await fs.writeFile(tmpFile, baked, 'utf8');
      loadPath = tmpFile;
      cleanup = async () => { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); };
    } catch (err) {
      console.warn('[prepareExportPage] standalone bake failed, loading raw canvas.html:', err.message);
    }
  }

  const ctx = await browser.newContext({
    viewport: { width: dims.width, height: dims.height },
    deviceScaleFactor: dpr,
  });
  const page = await ctx.newPage();
  await page.goto('file://' + loadPath, { waitUntil: 'networkidle', timeout: 30_000 });

  // 字体强等待——比 await document.fonts.ready 严格得多。
  //
  // 背景：Google Fonts 把 CJK 字体（Noto Sans SC）拆成 80+ 个 unicode-range
  // 子集，每个子集 + 每个 weight 是独立 @font-face。HTML 用 font-display: swap
  // 的话浏览器先用 fallback 字体绘制，字体异步加载完后 swap。
  //
  // document.fonts.ready 只等"已经 pending 的"face——CSS 引用了但还没被使用
  // 过的 face 不算 pending（lazy load 机制）。截图时若某个 weight × range
  // 子集还没被触发，PDF/PPT 就截到 swap 前的 fallback 字体（preview 走 macOS
  // 系统字体看着对，PPT/PDF 走 Linux Chromium 默认字体看着错）。
  //
  // 4 步保 ready：
  //   1. 强制 layout（让所有字体使用注册到 FontFaceSet）
  //   2. 显式 .load() 所有声明的 face（含未被使用的 weight × range 子集）
  //   3. await document.fonts.ready（兜底等剩余 pending）
  //   4. 双 rAF 等 paint 真正应用 swap
  await page.evaluate(async () => {
    document.body.offsetHeight;  // force layout
    const faces = Array.from(document.fonts);
    await Promise.all(faces.map((f) => f.load().catch(() => {})));
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(200);  // 短兜底（rAF 后再给 paint 一帧时间）

  // 抹掉 body margin + 砍掉 fit-active 视觉缩放（如果 file:// 加载的 canvas.html
  // 有 standalone-fit script，frame 包装 + section transform: scale 会让 boundingBox
  // 拿到的不是设计稿原坐标）。Playwright viewport 已经 = deck 比例，原生渲染。
  await page.addStyleTag({ content: `
    body { margin: 0 !important; padding: 0 !important; }
    body.__nd-fit-active > .__nd-deck-wrap > .__nd-page-frame {
      width: ${dims.width}px !important; height: ${dims.height}px !important;
      display: block !important; overflow: visible !important;
    }
    body.__nd-fit-active section[data-page] { transform: none !important; }
  ` });

  const fallback = { w: dims.width, h: dims.height };
  const pageSize = await page.evaluate((fb) => {
    const first = document.querySelector('section[data-page]');
    if (!first) return fb;
    const rect = first.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  }, fallback);

  return { page, ctx, pageSize, cleanup };
}

/**
 * 导出 HTML 时注入 viewport 自适应脚本（服务端兜底）。
 *
 * 逻辑：scale(viewportWidth / DECK.width) 让任意视口宽都满铺 + 完整。
 * 仅在独立打开时生效（iframe 内 window!==top 早退，前端 CanvasFrame 自算 scale）。
 *
 * 行为升级（2026-05-08）：内部改调 server/api/standalone-fit.js 的 fitInjectionBlock()，
 * 升级到 4 mode 感知（stack/ppt/carousel/custom）+ transform-origin: top left。
 * 调用方零改动，老 deck（无 data-deck-mode attr）自动按 stack 兜底。
 */
function injectViewportFit(html) {
  // 1. 替换 agent 写的固定 viewport meta → 响应式 viewport（让 fit script 控）
  if (/<meta\s+name=["']viewport["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<meta\s+name=["']viewport["'][^>]*>/i,
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
    );
  } else if (html.includes('</head>')) {
    html = html.replace(
      '</head>',
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n</head>',
    );
  }

  // 2. 调 standalone-fit 拼完整 fit injection block 注入
  const block = fitInjectionBlock();
  if (html.includes('</body>')) {
    return html.replace('</body>', block + '\n</body>');
  }
  if (html.includes('</html>')) {
    return html.replace('</html>', block + '\n</html>');
  }
  return html + block;
}

export default router;
