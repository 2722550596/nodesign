/**
 * server/api/assets.js — 上传素材到 project shared workspace
 *
 * POST   /api/projects/:pid/assets             multipart file → 写到 shared/assets/
 * GET    /api/projects/:pid/assets             列 shared/assets/ 下的文件
 * DELETE /api/projects/:pid/assets/:filename   删 shared/assets/<filename>
 *
 * H3 改造：assets 是 project 共享资源（跨 session），落在 shared/assets/。
 * agent 通过 additionalDirectories 跨目录 Read。
 */

import express from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import {
  getSharedDir, ensureProjectWorkspace, removeSessionWorkspace,
} from '../projects/workspace.js';
import { setActiveSession } from '../projects/store.js';
import {
  detectTaskKind, readTaskMarker, listSitePages, ENTRY_FILE, KIND_SITE, KIND_DECK,
} from '../lib/artifact-target.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),  // 先收到内存再写磁盘（方便 sanitize 文件名）
  limits: { fileSize: 16 * 1024 * 1024 },
});

function sanitizeFilename(name) {
  // 只保留 [A-Za-z0-9._-]，替换其它 → '_'。最长 80 字符。
  return (name || 'unnamed')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80);
}

router.post('/:pid/assets', upload.single('file'), async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    if (!req.file) return res.status(400).json({ error: 'no file (field name: file)' });

    await ensureProjectWorkspace(req.params.pid);
    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');

    let filename = sanitizeFilename(req.file.originalname);
    const targetPath = path.join(assetsDir, filename);
    if (await exists(targetPath)) {
      const ts = Date.now().toString(36);
      filename = `${ts}_${filename}`;
    }

    const finalPath = path.join(assetsDir, filename);
    await fs.writeFile(finalPath, req.file.buffer);

    res.status(201).json({
      asset: {
        // path 给 agent Read 用 — 相对 cwd（sessions/<sid>/）走 ../shared/assets/
        // 或者用 SDK additionalDirectories 拿到的绝对路径前缀；前端展示用 name 即可。
        path: `../../shared/assets/${filename}`,
        name: filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:pid/assets', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    let entries;
    try {
      entries = await fs.readdir(assetsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ assets: [] });
      throw err;
    }
    const assets = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const stat = await fs.stat(path.join(assetsDir, e.name));
      assets.push({
        path: `../../shared/assets/${e.name}`,
        name: e.name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
    assets.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ assets });
  } catch (err) { next(err); }
});

// H4b：删 asset 文件
router.delete('/:pid/assets/:filename', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const filename = req.params.filename;
    // 严格防 traversal：只允许 sanitize 后产生的字符集
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const filePath = path.join(assetsDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'asset not found' });
      throw err;
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── 工作台产物墙（2026-07-27 v1）──
// 产物 = 目前是文件（上传素材 + generated 生成图）；未来扩展便签 / 关键帧 /
// 文案 / 时序 / 视频时在这里加 kind。前端 ArtifactBoard 消费。

const ARTIFACT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.zip': 'application/zip',
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
};
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

/**
 * GET /:pid/artifacts — 产物清单（project 级，跨 session）。
 * 返回 { artifacts: [{ kind, name, path, size, mtime, ext, hasThumb }] }
 *   kind: 'generated'（agent 生成图，assets/generated/）| 'upload'（用户上传，assets/ 顶层）
 *   path: agent 视角相对路径（'assets/...'，session cwd 软链下直接可 Read / 引用）
 */
router.get('/:pid/artifacts', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const artifacts = [];

    const scanDir = async (dir, kind, relPrefix) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (e.name.startsWith('.')) continue;
        const ext = path.extname(e.name).toLowerCase();
        const stat = await fs.stat(path.join(dir, e.name));
        const item = {
          kind,
          name: e.name,
          path: `${relPrefix}/${e.name}`,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ext,
          isImage: IMAGE_EXTS.has(ext),
          hasThumb: kind === 'generated' && IMAGE_EXTS.has(ext)
            ? await exists(path.join(dir, '.thumbnails', `${e.name.slice(0, -ext.length)}.thumb.jpg`))
            : false,
        };
        // 语义元数据（generate-image.js 落 .meta/<base>.json sidecar：prompt /
        // assetRole / provider / aspectRatio / sessionId / runId）—— 物件不只是
        // 文件，带着它的来历上墙
        if (kind === 'generated') {
          try {
            const metaRaw = await fs.readFile(
              path.join(dir, '.meta', `${e.name.slice(0, -ext.length)}.json`), 'utf8');
            item.meta = JSON.parse(metaRaw);
          } catch { /* 无 sidecar（旧图）→ 无 meta */ }
        }
        // 便签直接把正文带给前端渲卡片（≤4KB 截断，完整内容走 artifact-file）。
        // frontmatter 里的 session 字段是分区归属（agent 写便签时按约定带上）。
        if (kind === 'note' && ext === '.md') {
          try {
            const raw = await fs.readFile(path.join(dir, e.name), 'utf8');
            const { body, sessionId } = parseNoteFrontmatter(raw);
            item.text = body.length > 4096 ? body.slice(0, 4096) + '…' : body;
            if (sessionId) item.sessionId = sessionId;
          } catch { /* */ }
        }
        artifacts.push(item);
      }
    };

    await scanDir(assetsDir, 'upload', 'assets');
    await scanDir(path.join(assetsDir, 'generated'), 'generated', 'assets/generated');
    await scanDir(path.join(assetsDir, 'notes'), 'note', 'assets/notes');

    // 任务模型（2026-07-28）：任务=shared/tasks/ 下的目录（agent 按需自建）。
    // 目录名即任务名。**任务有形态**（2026-07-28 加站点起）：
    //   deck —— canvas.html 是主 deck，同目录其余 .html 是试作，各自一张卡
    //   site —— index.html 是入口，整个目录是**一个**站点物件，子页和 style.css
    //           不各自上墙（否则用户看到的是一堆卡而不是一个站）
    const tasks = [];
    const tasksDir = path.join(getSharedDir(req.params.pid), 'tasks');
    const siteTaskNames = new Set();
    try {
      const taskEntries = await fs.readdir(tasksDir, { withFileTypes: true });
      for (const t of taskEntries) {
        if (!t.isDirectory() || t.name.startsWith('.')) continue;
        const tDir = path.join(tasksDir, t.name);
        const tStat = await fs.stat(tDir);
        // 任务=会话一对一：.nd-task.json 是 PostToolUse 落的归属标记
        const marker = await readTaskMarker(tDir);
        const boundSession = typeof marker?.sessionId === 'string' ? marker.sessionId : null;
        const kind = await detectTaskKind(tDir);

        const task = {
          id: t.name,
          title: t.name,
          kind,                       // 'deck' | 'site' | null（还没写出产物）
          sessionId: boundSession,
          mtime: tStat.mtime.toISOString(),
        };

        if (kind === KIND_SITE) {
          siteTaskNames.add(t.name);
          const pages = await listSitePages(tDir);
          task.site = { entry: ENTRY_FILE[KIND_SITE], pages };
          task.hasDeck = false;
          task.decks = [];
        } else {
          // 一个任务可以有多份 deck：canvas.html 是主 deck，
          // 其余 .html 是试作 / 备选（风格原型探索阶段并排放着让用户挑）
          let decks = [];
          try {
            const inner = await fs.readdir(tDir, { withFileTypes: true });
            decks = inner
              .filter(f => f.isFile() && f.name.toLowerCase().endsWith('.html') && !f.name.startsWith('.'))
              .map(f => ({ file: f.name, main: f.name === ENTRY_FILE[KIND_DECK] }))
              .sort((a, b) => (b.main - a.main) || a.file.localeCompare(b.file));
          } catch { /* 目录读不到就当没 deck */ }
          task.hasDeck = decks.some(d => d.main);
          task.decks = decks;
        }

        tasks.push(task);
        await scanDir(tDir, 'task-file', `tasks/${t.name}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // deck 任务里的 .html 不当普通文件卡上墙（由 tasks[].decks 派生成 deck 物件）；
    // 站点任务整个目录都不散着上墙（由 tasks[].site 派生成一个站点物件）
    const filtered = artifacts.filter((a) => {
      if (a.kind !== 'task-file') return true;
      const owner = a.path.split('/')[1];
      if (siteTaskNames.has(owner)) return false;
      return !a.name.toLowerCase().endsWith('.html');
    });

    filtered.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    tasks.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ artifacts: filtered, tasks });
  } catch (err) { next(err); }
});

/**
 * POST /:pid/notes — 新建灵感便签（第一个非文件上传类产物 kind）。
 * body: { text, title? } → 写 shared/assets/notes/<ts>-<slug>.md。
 * 便签就是 markdown 文件：agent 可 Read（assets/notes/ 在 cwd 软链下），
 * 加入上下文托盘走和图片相同的 attachment 管道。
 */
router.post('/:pid/notes', express.json(), async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 20_000) return res.status(400).json({ error: 'note too long (max 20k chars)' });
    const sessionId = typeof req.body?.sessionId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(req.body.sessionId)
      ? req.body.sessionId : null;

    await ensureProjectWorkspace(req.params.pid);
    const notesDir = path.join(getSharedDir(req.params.pid), 'assets', 'notes');
    await fs.mkdir(notesDir, { recursive: true });

    // slug：CJK 标题 sanitize 后是一串下划线，折叠+去边；没剩下有效字符就叫 note
    const slug = sanitizeFilename(String(req.body?.title || text.slice(0, 24)))
      .replace(/\.+$/, '').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'note';
    const filename = `${Date.now().toString(36)}-${slug}.md`;
    // session 归属写进 frontmatter —— 前端按它把便签自动摆进对应工作区
    const content = sessionId ? `---\nsession: ${sessionId}\n---\n\n${text}` : text;
    await fs.writeFile(path.join(notesDir, filename), content, 'utf8');

    res.status(201).json({
      artifact: {
        kind: 'note', name: filename, path: `assets/notes/${filename}`,
        size: Buffer.byteLength(content), mtime: new Date().toISOString(),
        ext: '.md', isImage: false, text,
        ...(sessionId ? { sessionId } : {}),
      },
    });
  } catch (err) { next(err); }
});

/** 便签 frontmatter：只认最简单的 `---\nsession: xxx\n---` 头，其余原样当正文 */
function parseNoteFrontmatter(raw) {
  const m = /^---\n([\s\S]{0,500}?)\n---\n?/.exec(raw);
  if (!m) return { body: raw, sessionId: null };
  const sm = /(?:^|\n)session:\s*([A-Za-z0-9-]{8,64})\s*(?:\n|$)/.exec(m[1]);
  return { body: raw.slice(m[0].length).replace(/^\n+/, ''), sessionId: sm ? sm[1] : null };
}

/** DELETE /:pid/notes/:filename — 删便签（仅 notes/ 目录，字符集严格校验） */
router.delete('/:pid/notes/:filename', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const filename = req.params.filename;
    if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) {
      return res.status(400).json({ error: 'invalid note filename' });
    }
    const filePath = path.join(getSharedDir(req.params.pid), 'assets', 'notes', filename);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
      throw err;
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * GET /:pid/artifact-file/*subPath — project 级文件服务（shared/assets 子树）。
 * 工作台缩略图 / 大图用，不依赖 session（canvas.js 的同款路由是 session 级的）。
 * 防 traversal 同 canvas.js：resolve 后必须留在 shared/assets 下。
 */
/**
 * DELETE /:pid/tasks/:name —— 删任务文件夹
 *
 * 任务和会话一对一：删任务连它的会话一起删（.nd-task.json 记着 sessionId）。
 * 反过来删会话也会连带删任务（server/api/sessions.js）。两者不独立存在。
 * 返回 { removedTask, removedSession }。
 */
router.delete('/:pid/tasks/:name', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const name = String(req.params.name || '');
    if (!name || name.includes('/') || name.includes('..') || name.startsWith('.')) {
      return res.status(400).json({ error: 'invalid task name' });
    }
    const taskDir = path.join(getSharedDir(req.params.pid), 'tasks', name);
    let boundSession = null;
    try {
      boundSession = JSON.parse(await fs.readFile(path.join(taskDir, '.nd-task.json'), 'utf8'))?.sessionId || null;
    } catch { /* 旧任务没标记 */ }

    try {
      await fs.rm(taskDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'task not found' });
      throw err;
    }

    // 连带删会话：走 sessions 路由同一条实现（HTTP self-call 太绕，直接复用逻辑）
    let removedSession = null;
    if (boundSession) {
      try {
        await removeSessionByTask(req.params.pid, boundSession);
        removedSession = boundSession;
      } catch (err) {
        console.warn('[delete task] 连带删会话失败:', err.message);
      }
    }
    res.json({ removedTask: name, removedSession });
  } catch (err) { next(err); }
});

/** 删任务时连带删它的会话目录（SDK jsonl 由 sessions 路由那条负责，这里只清工作区）*/
async function removeSessionByTask(pid, sid) {
  await removeSessionWorkspace(pid, sid);
  const project = getProject(pid);
  if (project?.activeSessionId === sid) {
    try { setActiveSession(pid, null); } catch { /* ignore */ }
  }
}

router.get('/:pid/artifact-file/*subPath', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const raw = req.params.subPath;
    let subPath = Array.isArray(raw) ? raw.join('/') : (raw || '');
    if (!subPath) return res.status(400).json({ error: 'file path required' });
    // 兼容旧形态：无前缀 = assets/ 相对路径（2026-07-28 前 api.js 会剥前缀）
    if (!subPath.startsWith('assets/') && !subPath.startsWith('tasks/')) {
      subPath = `assets/${subPath}`;
    }

    // 可服务根：assets/（素材）+ tasks/（任务产出，含任务 deck 的 canvas.html）。
    // subPath 必须带前缀落在其一之内，防穿越
    const sharedRoot = path.resolve(getSharedDir(req.params.pid));
    const absPath = path.resolve(sharedRoot, subPath);
    const inRoot = (root) => absPath === root || absPath.startsWith(root + path.sep);
    const assetsRoot = path.join(sharedRoot, 'assets');
    const tasksRoot = path.join(sharedRoot, 'tasks');
    if (!inRoot(assetsRoot) && !inRoot(tasksRoot)) {
      return res.status(403).json({ error: 'path escapes assets/ or tasks/' });
    }

    let stat;
    let servePath = absPath;
    try {
      stat = await fs.stat(servePath);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      throw err;
    }
    // 目录 → 找 index.html（站点常见的 `href="about/"` 写法；deck 场景用不到但无害）
    if (stat.isDirectory()) {
      const indexPath = path.join(servePath, ENTRY_FILE[KIND_SITE]);
      try {
        const s = await fs.stat(indexPath);
        if (s.isFile()) { servePath = indexPath; stat = s; }
      } catch { /* 没有 index.html 就按下面的 not a file 处理 */ }
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });

    const ext = path.extname(servePath).toLowerCase();
    res.setHeader('Content-Type', ARTIFACT_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    // 站点在编辑中要看到最新的那一份：deck 的图片可以缓存 5 分钟，html/css/js
    // 不能 —— agent 改完 style.css 用户按刷新还是旧样式，会以为改动没生效。
    const editable = ext === '.html' || ext === '.htm' || ext === '.css' || ext === '.js';
    res.setHeader('Cache-Control', editable ? 'no-cache' : 'private, max-age=300');
    res.end(await fs.readFile(servePath));
  } catch (err) { next(err); }
});

export default router;
