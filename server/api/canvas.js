/**
 * server/api/canvas.js — Canvas + Spec read/write/history/revert（H3：session-scoped）
 *
 * 路径全加 sid（H3 改造）：
 *   GET    /api/projects/:pid/sessions/:sid/canvas              → text/html
 *   PUT    /api/projects/:pid/sessions/:sid/canvas              { html, source? }
 *   GET    /api/projects/:pid/sessions/:sid/canvas/history      git log
 *   POST   /api/projects/:pid/sessions/:sid/canvas/revert       { commit }
 *   POST   /api/projects/:pid/sessions/:sid/canvas/undo
 *   GET    /api/projects/:pid/sessions/:sid/spec                spec.json（agent 私域档案）
 *
 * 文件实际位置：
 *   <project_workspace>/sessions/<sid>/canvas.html
 *   <project_workspace>/sessions/<sid>/spec.json
 *   <project_workspace>/sessions/<sid>/.git/                  （per-session history）
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import {
  getSessionWorkspace, ensureSessionWorkspace, validateSessionId,
  commitWorkspace, listHistory, revertWorkspace,
} from '../projects/workspace.js';
import { fitInjectionBlock } from './standalone-fit.js';
import { resolveDeckSize, extractDeckAspect } from '../shared/deck.js';
import { kindOfPath } from '../lib/artifact-target.js';

const router = express.Router();

const MAX_HTML_BYTES = 8 * 1024 * 1024; // 8MB

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

// 单文件 GET（assets/* 子树）—— 让 iframe 里 <img src="assets/generated/x.jpg">
// 自然解析 + chat 渲染 image content block 缩略图也走这个 endpoint。
// 走 sessions/<sid>/assets softlink 透到 shared/assets，路径限 assets/* 子树
// 防 traversal。MIME 按扩展名定。
const ASSET_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
/**
 * thumbnail 路径模式：assets/generated/.thumbnails/<name>.thumb.jpg
 * 文件不存在时尝试找原图 assets/generated/<name>.<ext>（任一支持后缀）作 fallback。
 * 用途：① 老图（generate_image 加 thumbnail 流程之前生成的）没 thumb → 用原图
 * ② thumbnail 生成失败 → 用原图。preview 体验降级而非破图。
 *
 * @returns {Promise<string|null>} 原图绝对路径，找不到时 null
 */
async function findOriginalForThumbnail(absThumbPath) {
  const m = absThumbPath.match(/^(.*)\/\.thumbnails\/(.+)\.thumb\.jpg$/);
  if (!m) return null;
  const [, parentDir, baseName] = m;
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const candidate = path.join(parentDir, baseName + ext);
    try {
      const s = await fs.stat(candidate);
      if (s.isFile()) return candidate;
    } catch { /* try next ext */ }
  }
  return null;
}

router.get('/:pid/sessions/:sid/assets/*subPath', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    // Express 5 named wildcard：req.params.subPath 是 string[] 或 string
    const raw = req.params.subPath;
    const subPath = Array.isArray(raw) ? raw.join('/') : (raw || '');
    if (!subPath) return res.status(400).json({ error: 'asset path required' });

    let absPath = path.resolve(sessionRoot, 'assets', subPath);
    const assetsRoot = path.resolve(sessionRoot, 'assets');
    // 防 traversal：resolve 后必须在 sessions/<sid>/assets/ 下
    if (absPath !== assetsRoot && !absPath.startsWith(assetsRoot + path.sep)) {
      return res.status(403).json({ error: 'path escapes assets/' });
    }

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // ENOENT 兜底：thumbnail 路径不存在 → fallback 到原图（老图 / 生成失败 case）
      if (absPath.includes(`${path.sep}.thumbnails${path.sep}`) && absPath.endsWith('.thumb.jpg')) {
        const original = await findOriginalForThumbnail(absPath);
        if (original) {
          absPath = original;
          stat = await fs.stat(original);
        } else {
          return res.status(404).json({ error: 'thumbnail and original both missing' });
        }
      } else {
        return res.status(404).json({ error: 'asset not found' });
      }
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });

    const ext = path.extname(absPath).toLowerCase();
    const mime = ASSET_MIME[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, max-age=300');  // 5 分钟 cache，HMR / iframe reload 友好
    const buf = await fs.readFile(absPath);
    res.end(buf);
  } catch (err) { next(err); }
});

/**
 * Preview-only：把 canvas.html 里 <img src="assets/generated/<name>.<ext>"> 透明
 * 重写成 src="assets/generated/.thumbnails/<name>.thumb.jpg"。仅 GET /canvas serve
 * 时改输出，**不动** agent 写的源文件。
 *
 * 理由：单图原始 6-8MB（Gemini 默认 1080×1920+ PNG），iframe 缩放（zoom=transform
 * scale）+ 多图同时渲染让 GPU/RAM 暴涨，preview 体感卡。thumbnail 长边 512 / ~50KB
 * 足够 preview 看清布局。导出走 build-standalone 仍 inline 原图，最终交付不损质量。
 *
 * 也覆盖 CSS 内 url(...) 引用的图片（agent 用 background-image 时常见）。
 *
 * thumbnail 不存在时 asset endpoint 会自动 fallback 到原图（见下方 ENOENT 分支），
 * 老图（thumbnail 没生成的）/ 生成失败的都能正常显示。
 */
/**
 * 注入唯一权威 fit injection block（<script> + <style>）到 </body> 前。
 *
 * preview iframe 路径跟离线 / 导出 HTML 走同一份 standalone-fit，确保渲染一致：
 * 每 section 包 100vw×100vh frame + scroll-snap + CSS min() 缩放。
 *
 * 已含 __nd-standard-fit script 的跳过（重启场景：HTML 已经 saved 了）。
 */
function injectFitBlock(html) {
  if (/__nd-standard-fit\b/.test(html)) return html;
  const block = fitInjectionBlock();
  if (html.includes('</body>')) return html.replace('</body>', block + '\n</body>');
  if (html.includes('</html>')) return html.replace('</html>', block + '\n</html>');
  return html + block;
}

function rewriteImagesToThumbnails(html) {
  const imgRe = /(<img\b[^>]*\bsrc\s*=\s*["'])assets\/generated\/(?!\.thumbnails\/)([^"']+?)\.(png|jpg|jpeg|webp|gif)(["'])/gi;
  const cssUrlRe = /(url\(\s*["']?)assets\/generated\/(?!\.thumbnails\/)([^"')]+?)\.(png|jpg|jpeg|webp|gif)(["']?\s*\))/gi;
  return html
    .replace(imgRe, (_m, prefix, name, _ext, suffix) =>
      `${prefix}assets/generated/.thumbnails/${name}.thumb.jpg${suffix}`)
    .replace(cssUrlRe, (_m, prefix, name, _ext, suffix) =>
      `${prefix}assets/generated/.thumbnails/${name}.thumb.jpg${suffix}`);
}

router.get('/:pid/sessions/:sid/canvas', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    try {
      let content = await fs.readFile(file, 'utf8');
      // 注入 <base href>：让 iframe 内 <img src="assets/...">/url("assets/...") 等
      // 相对资源解析显式锚到 sessions/<sid>/，不依赖 iframe.src 的隐式 base URL
      // （src 带 ?v=xxx query / 部署 redirect 等都可能让浏览器解析跑偏）。
      // 已含 <base> 时跳过；正则只匹配开始 <head> tag。
      if (!/<base\s+href=/i.test(content)) {
        const baseHref = `/api/projects/${encodeURIComponent(req.params.pid)}/sessions/${encodeURIComponent(req.params.sid)}/`;
        content = content.replace(/<head([^>]*)>/i, `<head$1>\n  <base href="${baseHref}">`);
      }
      // 透明替换 generated 图片为 thumbnail（preview 流畅；导出 / agent 看到的源
      // 文件不动）。env NODESIGN_DISABLE_THUMBNAIL_REWRITE=1 关掉这行为（应急）。
      if (process.env.NODESIGN_DISABLE_THUMBNAIL_REWRITE !== '1') {
        content = rewriteImagesToThumbnails(content);
      }
      // 注入唯一权威 fit script（每 section 自动包 100vw×100vh frame + scroll-snap）
      // preview iframe 跟离线打开 / 导出 HTML 共享同一 fit 行为，渲染一致
      content = injectFitBlock(content);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 还没生成（session 刚建，agent 没跑过）—— 占位 HTML
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(EMPTY_CANVAS_HTML);
      } else {
        throw err;
      }
    }
  } catch (err) { next(err); }
});

/**
 * GET /:pid/sessions/:sid/canvas/deck-meta —— 返 deck 比例信息
 *
 * 读 canvas.html wrap data-deck-aspect 属性 → resolve 到 4 档预设
 * （16:9 / 16:10 / 9:16 / 4:3），返 { aspect, width, height }。
 *
 * 用途：前端 Home 缩略图 / Workspace ThumbnailBox 需要在挂载前知道 deck
 * 比例才能正确设容器 aspectRatio + iframe size。Canvas 主路径自己会读
 * data-deck-aspect 不需要这个 endpoint。
 *
 * canvas.html 还没生成 → 返默认 16:9（让前端能用 fallback 占位）
 */
router.get('/:pid/sessions/:sid/canvas/deck-meta', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    // ?path= 让任务 deck 也能问自己的比例（缺省旧式 cwd/canvas.html）
    const rel = typeof req.query.path === 'string' && req.query.path ? req.query.path : 'canvas.html';
    const file = path.resolve(sessionRoot, rel);
    let html = '';
    if (file === sessionRoot || file.startsWith(sessionRoot + path.sep)) {
      try { html = await fs.readFile(file, 'utf8'); } catch { /* canvas 还没生成 → 默认 16:9 fallback */ }
    }
    // kind 一起返回：站点没有"比例"这回事（响应式、高度不定），前端拿到
    // kind='site' 就别用下面这组数去套固定画框。不返 kind 的话前端只能拿到
    // 静默 fallback 的 16:9，把一个网站塞进 1920×1080 的信箱框里。
    const kind = await kindOfPath(sessionRoot, rel);
    const aspect = extractDeckAspect(html);
    const { width, height } = resolveDeckSize(aspect);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ kind, aspect, width, height });
  } catch (err) { next(err); }
});

/**
 * PUT /:pid/sessions/:sid/canvas —— 落库用户在画布上的直接编辑
 *
 * body.path（2026-07-28）：任务模型下 deck 住 tasks/<任务>/canvas.html，
 * 不带这个字段就会把用户的改动写进 sessions/<sid>/canvas.html —— 前端显示
 * "已保存"，用户看的那份却纹丝不动。缺省仍是旧式 cwd/canvas.html。
 */
router.put('/:pid/sessions/:sid/canvas', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const { html, source = 'user', path: relPath } = req.body || {};
    if (typeof html !== 'string' || html.length === 0) {
      return res.status(400).json({ error: 'html string required' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      return res.status(413).json({ error: 'html too large (>8MB)' });
    }

    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.resolve(sessionRoot, typeof relPath === 'string' && relPath ? relPath : 'canvas.html');
    if (file !== sessionRoot && !file.startsWith(sessionRoot + path.sep)) {
      return res.status(400).json({ error: 'path escapes workspace' });
    }
    if (!file.endsWith('.html')) {
      return res.status(400).json({ error: 'path must be an .html file' });
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html, 'utf8');

    const ts = new Date().toISOString();
    const commit = await commitWorkspace(
      req.params.pid, req.params.sid,
      `${source}-edit: ${ts}`,
      { author: source === 'agent' ? 'agent' : 'user' },
    );
    res.json({ ok: true, commit });
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/canvas/history', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await listHistory(req.params.pid, req.params.sid, { limit });
    res.json({ entries });
  } catch (err) { next(err); }
});

router.post('/:pid/sessions/:sid/canvas/revert', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const { commit } = req.body || {};
    if (!commit || typeof commit !== 'string') {
      return res.status(400).json({ error: 'commit hash required' });
    }
    const newCommit = await revertWorkspace(req.params.pid, req.params.sid, commit);
    res.json({ ok: true, commit: newCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/:pid/sessions/:sid/canvas/undo', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const entries = await listHistory(req.params.pid, req.params.sid, { limit: 5 });
    if (!entries || entries.length < 2) {
      return res.status(400).json({
        error: 'no previous version to undo to',
        code: 'NO_PREV_COMMIT',
      });
    }
    const prevCommit = entries[1].commit || entries[1].hash || entries[1].sha;
    if (!prevCommit) {
      return res.status(500).json({ error: 'history entry missing commit hash' });
    }
    const newCommit = await revertWorkspace(req.params.pid, req.params.sid, prevCommit);
    res.json({ ok: true, commit: newCommit, revertedTo: prevCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * GET /:pid/sessions/:sid/spec —— 读 sessions/<sid>/spec.json（agent 私域档案）
 *
 * 不存在或解析失败时返回 {} —— 让前端不会因 spec 缺失崩。
 * 这是只读 endpoint —— spec.json 完全由 agent 维护。
 */
router.get('/:pid/sessions/:sid/spec', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'spec.json');
    try {
      const raw = await fs.readFile(file, 'utf8');
      let spec = {};
      try { spec = JSON.parse(raw); } catch { spec = {}; }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) spec = {};
      res.json({ spec });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ spec: {} });
      throw err;
    }
  } catch (err) { next(err); }
});

// GET /plan endpoint 已删（Phase 4）：业务层 design-plan.md modal 路径下线，
// 统一走 SDK 原生 plan mode（PlanReviewCard）。design-plan.md 文件作为
// SDK plan-approve 的产物保留（turn.js 落档），但前端不再有只读 modal。
// vision-checker 子代理仍可 Read design-plan.md，走子代理的 cwd Read 路径。

/**
 * GET /:pid/sessions/:sid/config —— 读 session-config.json（用户/前端拥有的 session 配置）
 *
 * 跟 spec.json 区分：
 *   - spec.json = agent 私域档案（agent 通过 record_decision/expose_tweaks/PostCompact 写）
 *   - session-config.json = 用户/前端 session 偏好（前端 toggle 状态、UI 偏好）
 *
 * 当前字段：
 *   - tweaks_mode_enabled: bool   是否启用 Tweaks 模式（agent 主动暴露微调参数）
 *
 * 文件不存在时返回默认 config。
 */
router.get('/:pid/sessions/:sid/config', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    res.json({ config: await readSessionConfig(sessionRoot) });
  } catch (err) { next(err); }
});

/**
 * PATCH /:pid/sessions/:sid/config —— 部分更新 session-config.json
 *
 * body: 任意 partial config（只覆盖传进来的字段）
 * 返回：merge 后的完整 config
 */
router.patch('/:pid/sessions/:sid/config', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'body must be object' });
    }
    const current = await readSessionConfig(sessionRoot);
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await fs.writeFile(
      path.join(sessionRoot, 'session-config.json'),
      JSON.stringify(merged, null, 2),
      'utf8',
    );
    res.json({ config: merged });
  } catch (err) { next(err); }
});

const DEFAULT_SESSION_CONFIG = Object.freeze({
  tweaks_mode_enabled: true,
});

async function readSessionConfig(sessionRoot) {
  try {
    const raw = await fs.readFile(path.join(sessionRoot, 'session-config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...DEFAULT_SESSION_CONFIG };
    return { ...DEFAULT_SESSION_CONFIG, ...cfg };
  } catch {
    return { ...DEFAULT_SESSION_CONFIG };
  }
}

const EMPTY_CANVAS_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>NoDesign canvas</title>
<style>html,body{margin:0;height:100%;font-family:system-ui;background:#F9F8F6}
.placeholder{display:flex;align-items:center;justify-content:center;height:100%;
color:#3a2a18aa;font-size:14px;letter-spacing:.02em}</style></head>
<body><div class="placeholder">canvas.html 还没生成 · 等 agent 跑一次 turn</div></body></html>
`;

export default router;
