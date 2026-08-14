/**
 * server/api/exports.js — 用户主动导出
 *
 * 路径（2026-08-13 起**项目级**，会话级留作 alias —— 同 pending-changes.js）：
 *   GET  /api/projects/:pid/exports                列已生成交付包
 *   GET  /api/projects/:pid/exports/file/:filename 单文件下载
 *   GET  /api/projects/:pid/exports/items          可单独导出的东西
 *   POST /api/projects/:pid/exports/pick           下载勾选的东西
 *   GET  /api/projects/:pid/exports/html           导出 canvas.html
 *   GET  /api/projects/:pid/exports/pdf            playwright print → PDF
 *   GET  /api/projects/:pid/exports/pptx           截图 → pptxgenjs
 *   GET  /api/projects/:pid/exports/site           整站打包
 *   GET  /api/projects/:pid/exports/handoff        JSZip 工程交付包
 *   （/:pid/sessions/:sid/exports/... 同 handler 双挂载。老 sid 路由**永远保留**：
 *     jsonl 历史里持久化了绝对 URL —— export-handoff.js:104 拼出来发给用户的
 *     下载链接就是这个形状，砍掉 alias 等于让所有历史消息里的链接变 404。）
 *
 * 文件位置（扁平化后全在项目工作区根）：
 *   <workspace>/exports/      ← 已生成的导出包（agent 调
 *                                 mcp__nodesign__export_handoff 也写这）
 *   <workspace>/canvas.html, spec.json
 *   <workspace>/assets/       ← handoff 打包时从这取共享 assets
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import JSZip from 'jszip';
import { validateProjectId, getProject, listRunsForProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import {
  getSessionWorkspace, getSharedDir, getWorkspaceRoot, validateSessionId,
} from '../projects/workspace.js';
import { DECK, resolveDeckSize, extractDeckAspect } from '../shared/deck.js';
import { fitInjectionBlock } from './standalone-fit.js';
import { buildStandaloneHtml, isHybridHtml, inlineLocalImages } from './exports/build-standalone.js';
import {
  resolveCanvasTarget, KIND_SITE, ENTRY_FILE, formatAllowed,
} from '../lib/artifact-target.js';
import { walkTaskFiles, loadIgnore } from '../lib/task-scan.js';

const router = express.Router();

function guard(req, res) {
  // sid 只在走老 alias 时存在 —— 有就校验形状，没有就是项目级路由
  if (req.params.sid !== undefined) {
    try {
      validateSessionId(req.params.sid);
    } catch (err) {
      res.status(400).json({ error: err.message || 'invalid pid/sid' });
      return null;
    }
  }
  // pid 校验 + 存在性 + 归属（2026-07-30 多用户）统一走 guardProject
  return guardProject(req, res);
}

/**
 * 两条挂载共用：alias 带 sid 走原路，项目级直接取工作区根。
 * 导出全是读操作，不 ensure —— 工作区还不存在的话本来也没什么可导。
 * resolveCanvasTarget 的第三参（sid）照传 req.params.sid：undefined 时它只是
 * 跳过"当前会话正在做哪份产物"的记忆，落回全工作区寻址，正是项目级想要的。
 */
function rootOf(req) {
  return req.params.sid !== undefined
    ? getSessionWorkspace(req.params.pid, req.params.sid)
    : getWorkspaceRoot(req.params.pid);
}

function safeFilename(name) {
  return (name || 'design').replace(/[^A-Za-z0-9._一-龥-]/g, '_').slice(0, 60);
}

// ── 已生成的交付包列表 ──
router.get(['/:pid/exports', '/:pid/sessions/:sid/exports'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
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

router.get(['/:pid/exports/file/:filename', '/:pid/sessions/:sid/exports/file/:filename'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);

    // 文件名只禁路径分隔与上跳；中文名要能下（agent 交付的包常叫「终焉之莉莉-交付.zip」）
    const filename = req.params.filename;
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
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

/**
 * GET /:pid/sessions/:sid/exports/items —— 当前任务里可以单独导出的东西
 *
 * 用户视角的"这次任务做出来的内容"：任务目录下的文件 + deck 真正引用到的图。
 * 不做整包，让用户勾选（?path= 指定别的 deck；缺省走统一寻址）。
 */
router.get(['/:pid/exports/items', '/:pid/sessions/:sid/exports/items'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    const items = [];
    const seen = new Set();
    const add = async (rel, kind) => {
      if (seen.has(rel)) return;
      const abs = path.resolve(sessionRoot, rel);
      if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) return;
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return;
        seen.add(rel);
        items.push({ path: rel, name: path.basename(rel), size: st.size, kind });
      } catch { /* 读不到就不列 */ }
    };

    // 产物自己的文件（统一扫描规则 task-scan.js：硬清单 + .ndignore 生效，
    // `_drafts/` 试作照列 —— 用户可能就想下某一版）。
    //
    // ⚠️ 扁平模型改造（2026-08-14）：老判据是 `target.task && target.taskDir`，
    // 而 artifact-target 在任务层拆掉后 task 恒 null（兼容字段）—— 那条
    // walkTaskFiles 分支从扁平化起就是死路，站点导出清单只剩入口页 + 引用图，
    // 子页 / 样式表 / 试作**全部静默缺席**。现按产物根收：
    //   - 住文件夹的站/世界：整个产物目录（maxDepth 4）
    //   - 根站（artifactRel='.'）：工作区根还住着 notes/ assets/ 别的产物，
    //     全扫会把别家打包进去 —— 只收根层散文件（.md 除外，同前端
    //     resolveObjectId 的认领规则）+ `_drafts/`；引用图由下面的扫描补
    //   - deck / 单页站：本体一份（扁平后它住的文件夹是用户的收纳空间，
    //     可能装着不相干的东西，不能整夹打包）
    const isSite = target.ok && target.kind === KIND_SITE;
    const isDirArtifact = target.ok && (isSite || target.kind === 'world') && !target.artifact?.single;
    if (isDirArtifact) {
      const rootRel = target.artifactRel === '.' ? '' : target.artifactRel;
      const files = await walkTaskFiles(target.artifactDir, {
        maxDepth: rootRel ? 4 : 3,
        includeDrafts: true,
      });
      for (const f of files) {
        if (!rootRel) {
          const rootLevel = !f.rel.includes('/');
          const isDraft = f.rel.startsWith('_drafts/');
          if (!rootLevel && !isDraft) continue;
          if (rootLevel && /\.md$/i.test(f.name)) continue;
        }
        const rel = rootRel ? `${rootRel}/${f.rel}` : f.rel;
        const kind = /\.html?$/i.test(f.name)
          ? (f.rel.startsWith('_drafts/') ? 'draft' : (isSite ? 'site-page' : 'deck'))
          : 'file';
        await add(rel, kind);
      }
    } else if (target.ok) {
      await add(target.relPath, isSite ? 'site-page' : 'deck');
    }

    // 产物引用到的图（相对它自己的目录解，落成 workspace 相对路径）。
    // 站点扫全部页面 —— 只扫入口页会漏掉子页独有的图，用户下下来是裂的。
    if (target.ok) {
      // 站点：所有 .html + .css 都可能引图；deck：就它自己那一份
      const sources = isSite
        ? items.filter(i => /\.(html?|css)$/i.test(i.path)).map(i => path.resolve(sessionRoot, i.path))
        : [target.absPath];
      for (const src of sources) {
        try {
          const html = await fs.readFile(src, 'utf8');
          const base = path.dirname(src);
          const refs = new Set();
          for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) refs.add(m[1] || m[2]);
          for (const m of html.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+?))\s*\)/gi)) refs.add((m[1] || m[2] || m[3] || '').trim());
          for (const r of refs) {
            if (!r || /^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i.test(r) || path.isAbsolute(r)) continue;
            const abs = path.resolve(base, r);
            if (!abs.startsWith(sessionRoot + path.sep)) continue;
            await add(path.relative(sessionRoot, abs).split(path.sep).join('/'), 'image');
          }
        } catch { /* 读不到就跳过这一份 */ }
      }
    }

    res.json({
      deck: target.ok ? target.relPath : null,
      kind: target.ok ? target.kind : null,
      task: target.ok ? target.task : null,
      items,
    });
  } catch (err) { next(err); }
});

/**
 * POST /:pid/sessions/:sid/exports/pick —— 下载勾选的东西
 * body: { paths: string[], filename?: string }
 * 单个文件直接流回；多个打成 zip。
 */
router.post(['/:pid/exports/pick', '/:pid/sessions/:sid/exports/pick'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter(p => typeof p === 'string') : [];
    if (paths.length === 0) return res.status(400).json({ error: 'paths required' });

    const files = [];
    for (const rel of paths) {
      const abs = path.resolve(sessionRoot, rel);
      if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) {
        return res.status(400).json({ error: `path escapes workspace: ${rel}` });
      }
      try {
        const st = await fs.stat(abs);
        if (st.isFile()) files.push({ rel, abs, size: st.size });
      } catch {
        return res.status(404).json({ error: `not found: ${rel}` });
      }
    }
    if (files.length === 0) return res.status(404).json({ error: 'nothing to export' });

    if (files.length === 1) {
      const only = files[0];
      const buf = await fs.readFile(only.abs);
      const name = path.basename(only.rel);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    // 包内路径：剥掉所有勾选项的公共目录前缀。deck 场景（全在同一个任务目录里）
    // 结果还是平铺的文件名；站点勾了子目录里的页面时保留 `css/style.css` 这层结构 ——
    // 一律 basename 会让 `pages/a.html` 和 `posts/a.html` 在包里撞成一个。
    const segs = files.map(f => f.rel.split('/').slice(0, -1));
    let common = segs[0] || [];
    for (const s of segs) {
      let i = 0;
      while (i < common.length && i < s.length && common[i] === s[i]) i++;
      common = common.slice(0, i);
    }
    const strip = common.length ? common.join('/') + '/' : '';
    const zip = new JSZip();
    for (const f of files) {
      zip.file(f.rel.startsWith(strip) ? f.rel.slice(strip.length) : f.rel, await fs.readFile(f.abs));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const name = `${safeFilename(req.body?.filename || project.name)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) { next(err); }
});

router.get(['/:pid/exports/html', '/:pid/sessions/:sid/exports/html'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    // 导出哪一份走统一寻址（?path= 显式 → 本会话当前 deck → 本会话名下的任务 deck
    // → cwd/canvas.html）。任务模型下 deck 不在 cwd，写死 cwd 会永远导出空（2026-07-28）
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    const file = target.absPath;
    let html;
    try {
      html = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'canvas.html not yet generated' });
      throw err;
    }

    // **fit script 只给 deck**（2026-07-28）：那段脚本把每个 section 包成
    // 100vw×100vh 的 frame + scroll-snap，是幻灯片范式。站点是自然滚动的长页，
    // 注进去等于把用户的网站改造成翻页器 —— 而且是导出物，坏了还带不回来。
    // 顺带 stripFitScripts 也要跳过：它按启发式删"像 fit 的脚本"，站点里正当的
    // `transform: scale(` 动画会被误删。
    const injectFit = target.kind !== KIND_SITE;

    // Hybrid 文件 → 走自包含构建管道（CDN 全 inline，离线可双击打开）
    // 老 deck（无 babel script）→ 降级到 injectViewportFit 文本替换
    // 任一步骤失败也降级——保证用户至少拿到能用的 HTML
    if (isHybridHtml(html)) {
      try {
        // baseDir = deck 自己的目录：任务 deck 写的是 ../../assets/generated/x.png
        html = await buildStandaloneHtml(html, { sessionRoot, baseDir: path.dirname(file), injectFit });
      } catch (err) {
        // standalone 任何一步炸——管道里图片 inline 也不会跑，用户拿到的 HTML
        // 离开 session 目录后 <img src="assets/..."> 全 404。降级路径必须仍把
        // 图片 inline 一遍兜底，否则一次 esbuild 失败 = 整个 deck 图片全丢。
        console.warn('[exports/html] standalone build failed, falling back to viewport-fit:', err.message);
        if (injectFit) html = injectViewportFit(html);
        try {
          html = await inlineLocalImages(html, path.dirname(file), sessionRoot);
        } catch (e2) {
          console.warn('[exports/html] image inline fallback also failed:', e2.message);
        }
      }
    } else {
      if (injectFit) html = injectViewportFit(html);
      try {
        html = await inlineLocalImages(html, path.dirname(file), sessionRoot);
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
router.get(['/:pid/exports/pdf', '/:pid/sessions/:sid/exports/pdf'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (rejectFormat(res, target, 'pdf', 'PDF')) return;
    const file = target.absPath;

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

      // 每页截图（pageSize 已被 prepareExportPage 中和掉 fit transform，原坐标）。
      // 用 JPEG 不用 PNG：图片自包含之后每页都是整幅照片级画面，PNG 无损一页
      // 就 5-8MB，7 页的 PDF 能到 60MB —— 发不出去的东西等于没导出。
      // q=88 的 JPEG 在同画面下小一个数量级，肉眼看不出差别（deck 本来就是看的）。
      const pngs = [];
      for (const { handle, bbox } of pageInfos) {
        const clipOpts = bbox
          ? { clip: { x: bbox.x, y: bbox.y, width: pageSize.w, height: pageSize.h } }
          : {};
        const buf = await handle.screenshot({ type: 'jpeg', quality: 88, ...clipOpts });
        pngs.push(buf);
      }

      // 拼成多页 HTML：每页一个 .slide 容器 + img 满铺，page-break 控制分页
      const slidesHtml = pngs.map((buf) =>
        `<div class="slide"><img src="data:image/jpeg;base64,${buf.toString('base64')}"/></div>`,
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
router.get(['/:pid/exports/pptx', '/:pid/sessions/:sid/exports/pptx'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (rejectFormat(res, target, 'pptx', 'PPTX')) return;
    const file = target.absPath;

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
        // 同 PDF：JPEG 不用 PNG，否则一份 7 页 deck 的 pptx 能到几十 MB
        const buf = await handle.screenshot({ type: 'jpeg', quality: 88, ...clipOpts });
        const slide = pres.addSlide();
        slide.addImage({
          data: `data:image/jpeg;base64,${buf.toString('base64')}`,
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

/**
 * 形态 × 格式守卫（注册表驱动）：不适用的格式提前 400，不白烧 playwright /
 * esbuild。以前是 if kind === site 的散装判断，第三种形态进来就得再改一轮 ——
 * 现在各形态可用的格式表在 kinds/ 注册条目里，这里只查表。
 */
function rejectFormat(res, target, formatId, label) {
  if (formatAllowed(target.kind, formatId)) return false;
  res.status(400).json({
    error: `${target.relPath} 是 ${target.kind} —— ${label} 导出不适用于这种形态。`
      + (target.kind === KIND_SITE ? '站点请用「整站打包」（/exports/site）或导出菜单里的站点 zip。' : ''),
  });
  return true;
}

/**
 * GET /:pid/sessions/:sid/exports/site —— 整站打包
 *
 * 打的是**产物根**（手写站点 = 任务根，构建型站点 = dist/ 之类），不是源目录 ——
 * 用户要的是能直接发布的站，不是构建脚本和 md。扫描走统一规则（task-scan.js）：
 * 硬清单 + .ndignore + 跳 `_drafts/`，node_modules 打进 zip 这种事故从根上没了。
 *
 * 原样保留目录结构和文件名（相对链接才不会断），不注入 fit、不改写结构、不重命名。
 * 唯一的改写是**素材路径归一**：站点引用项目共享素材写的是 `../../assets/x.png`
 * （相对它在 workspace 里的位置），包里没有 workspace 这层，所以把素材拷进
 * `site/assets/` 并按每个文件自己的深度重写前缀 —— 子目录里的页面要 `../assets/`，
 * 写死成 `assets/` 就又裂一次。任务本地 assets/（推荐写法）本来就在包里，零改写。
 */
router.get(['/:pid/exports/site', '/:pid/sessions/:sid/exports/site'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (!formatAllowed(target.kind, 'site')) {
      return res.status(400).json({ error: `${target.relPath} 是 ${target.kind}，不是站点 —— 用 /exports/html 或 /exports/handoff。` });
    }
    if (target.artifact?.single) {
      return res.status(400).json({ error: `${target.relPath} 是单页产物，没有"整站"可打包 —— 用 /exports/html 导出这一页。` });
    }
    if (!target.taskDir) return res.status(400).json({ error: 'site must live in a task folder' });

    const zip = new JSZip();
    const referenced = new Map();   // workspace 相对路径 → 包内相对 site/ 的落点
    const baseDir = target.artifactDir || target.taskDir;
    const files = await walkTaskFiles(baseDir, {
      maxDepth: 6,
      ignore: await loadIgnore(target.taskDir),
      ignoreBase: target.taskDir,
    });

    for (const f of files) {
      if (!/\.(html?|css)$/i.test(f.name)) {
        try { zip.file(`site/${f.rel}`, await fs.readFile(f.abs)); } catch { /* 中途被删就跳过 */ }
        continue;
      }
      let text;
      try { text = await fs.readFile(f.abs, 'utf8'); } catch { continue; }
      // 先按原文收集引用（改写之后就找不回原路径了）
      for (const r of localRefsOf(text)) {
        const refAbs = path.resolve(path.dirname(f.abs), r);
        if (!refAbs.startsWith(sessionRoot + path.sep)) continue;
        if (refAbs.startsWith(target.taskDir + path.sep)) continue;   // 站内文件整目录已经打包了
        const wsRel = path.relative(sessionRoot, refAbs).split(path.sep).join('/');
        if (wsRel.startsWith('assets/')) referenced.set(wsRel, wsRel);
      }
      // `../../assets/…` → 按本文件深度重算前缀（根层是 `assets/`，一层子目录是 `../assets/`）
      const depth = f.rel.split('/').length;
      const up = '../'.repeat(depth - 1);
      zip.file(`site/${f.rel}`, text.replace(/(["'(])(?:\.\.\/)+assets\//g, `$1${up}assets/`));
    }

    for (const [wsRel, dst] of referenced) {
      try {
        zip.file(`site/${dst}`, await fs.readFile(path.resolve(sessionRoot, wsRel)));
      } catch { /* 引用了不存在的文件：页面里本来就是裂的，不因此让打包失败 */ }
    }

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const filename = `${safeFilename(target.task || project.name)}-site.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) { next(err); }
});

/** html/css 里引用的本地相对路径（排除 http(s):// data: 和绝对路径） */
function localRefsOf(text) {
  const refs = new Set();
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) refs.add(m[1] || m[2]);
  for (const m of text.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+?))\s*\)/gi)) refs.add((m[1] || m[2] || m[3] || '').trim());
  return [...refs].filter(r => r && !/^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i.test(r) && !path.isAbsolute(r));
}

router.get(['/:pid/exports/handoff', '/:pid/sessions/:sid/exports/handoff'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const sharedRoot = getSharedDir(req.params.pid);
    const runs = listRunsForProject(req.params.pid);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);

    const zipBuffer = await buildHandoffZip(sessionRoot, sharedRoot, {
      projectId: project.id,
      projectName: project.name,
      skillId: project.skillId,
      // 项目级挂载没有 sid —— README 里那行落 null，不硬造一个
      sessionId: req.params.sid ?? null,
      runs,
      deckPath: target.ok ? target.relPath : ENTRY_FILE.deck,
      kind: target.ok ? target.kind : null,
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
export async function buildHandoffZip(sessionRoot, sharedRoot, { projectId, projectName, skillId, sessionId, runs = [], deckPath = 'canvas.html', kind = null } = {}) {
  const zip = new JSZip();
  const isSite = kind === KIND_SITE;

  if (isSite) {
    // 站点：产物根整个进 design/，保留文件名与子目录 —— 只留入口页并改名叫
    // canvas.html 的话，子页和 style.css 全丢，页间相对链接必然断。
    // dirname(入口) 就是产物根（手写 = 任务根，构建型 = dist/）；忽略规则
    // 从任务根读（.ndignore 住那），试作 `_drafts/` 不进交付包。
    const artifactDirAbs = path.dirname(path.resolve(sessionRoot, deckPath));
    // 忽略规则（.ndignore）住工作区根；构建型站点的产物根是 dist/，
    // 规则却写在源那边，所以这两个目录必须分开取
    const taskRootAbs = path.resolve(sessionRoot);
    const siteFiles = await walkTaskFiles(artifactDirAbs, {
      maxDepth: 6,
      ignore: await loadIgnore(taskRootAbs),
      ignoreBase: taskRootAbs,
    });
    for (const f of siteFiles) {
      try { zip.file(`design/${f.rel}`, await fs.readFile(f.abs)); } catch { /* 中途被删就跳过 */ }
    }
    // 站内 html/css 的 `../../assets/` 归一（zip 布局是 design/<页面> + design/assets/）
    for (const rel of Object.keys(zip.files)) {
      if (zip.files[rel].dir || !/\.(html?|css)$/i.test(rel)) continue;
      const depth = rel.split('/').length - 2;             // design/ 之下还有几层
      const up = '../'.repeat(Math.max(0, depth));
      const text = await zip.files[rel].async('string');
      zip.file(rel, text.replace(/(["'(])(?:\.\.\/)+assets\//g, `$1${up}assets/`));
    }
  } else {
    try {
      // deckPath 相对 sessionRoot（任务模型下是 tasks/<任务>/canvas.html）
      const raw = await fs.readFile(path.resolve(sessionRoot, deckPath), 'utf8');
      // zip 里的布局是 design/canvas.html + design/assets/…，而任务 deck 写的是
      // `../../assets/generated/x.png`（相对它在 workspace 里的位置）—— 不改写的话
      // 解压出来图全裂。统一压成 `assets/…`。
      const html = raw.replace(/(["'(])(?:\.\.\/)+assets\//g, '$1assets/');
      zip.file('design/canvas.html', html);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      zip.file('design/canvas.html', '<!-- canvas.html not yet generated -->');
    }
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
  zip.file('README.md', renderReadme({ id: projectId, name: projectName, skillId, sessionId, kind }));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * 递归把 srcDir 下所有文件加进 zip（保留相对路径），dst 是 zip 内根前缀。
 * srcDir 不存在时静默 noop（fail-soft）。子目录中的 dotfile / 软链按需可扩展。
 */
async function zipDirRecursive(zip, srcDir, dstPrefix, { skipDotfiles = false } = {}) {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (skipDotfiles && e.name.startsWith('.')) continue;
    const srcAbs = path.join(srcDir, e.name);
    const dstRel = `${dstPrefix}/${e.name}`;
    if (e.isDirectory()) {
      await zipDirRecursive(zip, srcAbs, dstRel, { skipDotfiles });
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

${project.kind === 'site' ? `- \`design/\` — 站点全部文件（保留原目录结构与文件名）
- \`design/${'index.html'}\` — 入口页
- \`design/assets/\` — 站点引用到的项目素材` : `- \`design/canvas.html\` — 单文件 self-contained HTML，主产物
- \`design/assets/\` — 项目共享素材`}
- \`design/spec.json\` — 设计意图档案（agent 私域记忆）
- \`chat-history.json\` — runs 摘要
- \`prompt.txt\` — 占位

## 怎么用

${project.kind === 'site' ? `把 \`design/\` 整个目录当站点根目录发布（任何静态托管都行），或者直接双击
\`design/index.html\` 在本地浏览 —— 页面之间是相对链接，不依赖服务器。` : `直接在浏览器打开 \`design/canvas.html\` 看 deck。
导出 PDF：用浏览器打印（${'${DECK.width}'}×${'${DECK.height}'} 视口最佳）。`}

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
      const baked = await buildStandaloneHtml(html, { sessionRoot: opts.sessionRoot, baseDir: path.dirname(filePath) });
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
