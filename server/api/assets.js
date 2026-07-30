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
import { patchBoard } from '../projects/board-store.js';
import { taskManifest, ENTRY_FILE, KIND_SITE } from '../lib/artifact-target.js';

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
      let stat;
      try {
        stat = await fs.stat(path.join(assetsDir, e.name));
      } catch { continue; }   // 同上：单个文件读不到不该让整份列表失败
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
        // agent 正在写的时候文件可能在 readdir 和 stat 之间消失（重写 / 改名）。
        // 原来这里 stat 抛出会一路冒到路由 → 500 → 前端把画布清空。
        // 单个文件读不到就跳过它，不能因此让整份清单失败。
        let stat;
        try {
          stat = await fs.stat(path.join(dir, e.name));
        } catch { continue; }
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

    // 任务模型（2026-07-28；2026-07-29 多产物平权）：任务=shared/tasks/ 下的
    // 目录（agent 按需自建），目录名即任务名。一个任务可以装**多个平等产物**
    // （tasks[].artifacts，一条一卡）：顶层每个 .html 各是一份 deck、根 index.html
    // =一个站（子页和 style.css 不各自上墙）、无根站时带 index.html 的子目录各
    // 是一个站、_drafts/*.html 各是一个单页。没有主/试作等级。
    const tasks = [];
    const tasksDir = path.join(getSharedDir(req.params.pid), 'tasks');
    const siteTaskNames = new Set();
    try {
      const taskEntries = await fs.readdir(tasksDir, { withFileTypes: true });
      for (const t of taskEntries) {
        if (!t.isDirectory() || t.name.startsWith('.')) continue;
        const tDir = path.join(tasksDir, t.name);
        let tStat;
        try {
          tStat = await fs.stat(tDir);
        } catch { continue; }   // 任务目录扫到一半被删：跳过，别让整份清单 500
        // 形态解析统一走 kinds/ 注册表 —— 前端、感知工具、导出吃同一份 manifest，
        // 不再各自猜文件名（2026-07-29）
        const manifest = await taskManifest(tDir);
        const kind = manifest?.kind || null;

        const task = {
          id: t.name,
          title: t.name,
          kind,                       // 'deck' | 'site' | null（还没写出产物）
          sessionId: manifest?.sessionId
            ?? await (async () => {
              try {
                const raw = JSON.parse(await fs.readFile(path.join(tDir, '.nd-task.json'), 'utf8'));
                return typeof raw?.sessionId === 'string' ? raw.sessionId : null;
              } catch { return null; }
            })(),
          mtime: tStat.mtime.toISOString(),
          exports: manifest?.exportFormats || [],
        };

        // 多产物平权（2026-07-29）：任务的产物是一份平等清单，前端一条一卡。
        // base = 该产物的预览 URL 根（站点是产物根目录；deck / 单页是任务根）
        task.artifacts = (manifest?.artifacts || []).map((a) => ({
          kind: a.kind,
          view: a.view,
          single: !!a.single,
          file: a.file,                // deck / 单页：html 文件（相对任务根）
          root: a.root || '',
          srcRoot: a.srcRoot || '',    // 站点源目录；root≠srcRoot = 构建型（编辑要同步回源）
          entry: a.kind === 'site' && !a.single ? a.entry : a.entryRel,
          entryRel: a.entryRel,
          base: `tasks/${t.name}${a.kind === 'site' && !a.single && a.root ? `/${a.root}` : ''}`,
          pages: a.pages,
          title: a.title,              // null = 用任务名
          exports: a.exportFormats,
        }));
        if ((manifest?.artifacts || []).some(a => a.kind === KIND_SITE && !a.single)) {
          siteTaskNames.add(t.name);
        }

        tasks.push(task);
        await scanDir(tDir, 'task-file', `tasks/${t.name}`);
        // 任务便利贴（2026-07-30）：tasks/<任务>/notes/*.md —— agent 和用户的
        // 共享头脑风暴层（record_decision 的决策贴也写这里）。复用 note kind：
        // 正文解析、zone 归属（naturalZoneOf 按 tasks/<t>/ 前缀）、避让全现成
        await scanDir(path.join(tDir, 'notes'), 'note', `tasks/${t.name}/notes`);
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
 * 任务便利贴路由（2026-07-30）—— tasks/<任务>/notes/*.md 的用户侧写入口。
 * agent 侧不走这里（它直接 Write 文件）；这两条给前端"共享头脑风暴"用：
 * 用户在贴纸阅读浮层里改内容 / 删贴。
 *
 * 校验：任务名和文件名都可能是 CJK（决策.md），不能套 assets/notes 那条
 * `[A-Za-z0-9._-]` 正则。改为否定式（禁路径分隔符 / .. / 隐藏文件）+
 * resolve 后必须留在 shared/tasks 下的双保险。
 */
function safeNoteSegment(s, { md = false } = {}) {
  if (typeof s !== 'string' || !s || s.length > 200) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.startsWith('.')) return false;
  if (md && !s.endsWith('.md')) return false;
  return true;
}

function resolveTaskNote(pid, task, filename) {
  const base = path.join(getSharedDir(pid), 'tasks');
  const file = path.resolve(base, task, 'notes', filename);
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

/** PUT /:pid/task-notes/:task/:filename — 写/改任务便利贴（用户侧编辑） */
router.put('/:pid/task-notes/:task/:filename', express.json(), async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const { task, filename } = req.params;
    if (!safeNoteSegment(task) || !safeNoteSegment(filename, { md: true })) {
      return res.status(400).json({ error: 'invalid task/filename' });
    }
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    if (text.length > 20_000) return res.status(400).json({ error: 'note too long (max 20k chars)' });
    const file = resolveTaskNote(req.params.pid, task, filename);
    if (!file) return res.status(400).json({ error: 'invalid path' });
    try {
      await fs.access(path.join(getSharedDir(req.params.pid), 'tasks', task));
    } catch { return res.status(404).json({ error: 'task not found' }); }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    res.json({ ok: true, path: `tasks/${task}/notes/${filename}` });
  } catch (err) { next(err); }
});

/** DELETE /:pid/task-notes/:task/:filename — 删任务便利贴 */
router.delete('/:pid/task-notes/:task/:filename', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    const { task, filename } = req.params;
    if (!safeNoteSegment(task) || !safeNoteSegment(filename, { md: true })) {
      return res.status(400).json({ error: 'invalid task/filename' });
    }
    const file = resolveTaskNote(req.params.pid, task, filename);
    if (!file) return res.status(400).json({ error: 'invalid path' });
    try {
      await fs.unlink(file);
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

    // fs.rm force:true 对不存在的目录静默成功 —— 删除语义幂等：目录早没了也照样
    // 把 zone 行清掉（孤儿 zone「删不了」的根因之一，2026-07-30）
    await fs.rm(taskDir, { recursive: true, force: true });

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
    // 桌面 zone 行是持久化的（board.json），任务没了它不会自己消失 ——
    // 2026-07-30 前这里从来不清，每删一个任务留一个僵尸文件夹
    try {
      await patchBoard(req.params.pid, { zones: { [`task/${name}`]: null } });
    } catch (err) {
      console.warn('[delete task] 清 board zone 失败:', err.message);
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
    // ⚠️ Cache-Control 必须先设、且错误路径也要带（2026-07-29 SPiCa 裸奔事故）：
    // Cloudflare 对 .css/.js/.png 等扩展名按后缀边缘缓存，源站 `no-cache` 会被
    // 改写成浏览器 max-age=14400（4 小时），**404 响应同样被缓存 4 小时** ——
    // agent 先写 index.html 后写 style.css 的间隙里用户加载一次，浏览器就把
    // "css 404" 缓存 4 小时，之后怎么刷新都裸奔。实测 `no-store` / `private`
    // 会让 CF 判为 DYNAMIC 原样透传（同路由的 .html 就是这么幸免的）。
    // 所以：默认 no-store 兜底一切错误路径，成功路径按类型再覆盖。
    res.setHeader('Cache-Control', 'no-store');
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
    // 站点在编辑中要看到最新的那一份：图片可以浏览器缓存 5 分钟（private 让 CF
    // 不边缘缓存），html/css/js 一律 no-store —— no-cache 不够，CF 会对这些扩展
    // 名边缘缓存 + 把浏览器 TTL 改写成 4 小时（见路由入口注释）。
    const editable = ext === '.html' || ext === '.htm' || ext === '.css' || ext === '.js';
    res.setHeader('Cache-Control', editable ? 'no-store' : 'private, max-age=300');
    res.end(await fs.readFile(servePath));
  } catch (err) { next(err); }
});

export default router;
