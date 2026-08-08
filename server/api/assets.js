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
import { guardProject } from './_guard.js';
import {
  getSharedDir, ensureProjectWorkspace, removeSessionWorkspace,
} from '../projects/workspace.js';
import { setActiveSession } from '../projects/store.js';
import { patchBoard, readBoard, reconcileBoardRenames } from '../projects/board-store.js';
import { taskManifest, ENTRY_FILE, KIND_SITE } from '../lib/artifact-target.js';
import { RESERVED_DIRS, HARD_IGNORE_DIRS, DRAFTS_DIR, isReservedFile } from '../lib/task-scan.js';
import { getProjectCover } from '../lib/cover.js';
import {
  sendImage, isThumbPath, findOriginalForThumbnail, imageCacheControl,
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY,
} from '../lib/image-variant.js';
import { injectSrcset } from '../lib/html-srcset.js';
import { sendVideo, isVideo } from '../lib/video-variant.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),  // 先收到内存再写磁盘（方便 sanitize 文件名）
  limits: { fileSize: 16 * 1024 * 1024 },
});

/**
 * 文件名净化 —— 保留原名的可读性，只挡掉真正危险的字符。
 *
 * 老版本是 ASCII 白名单（`[^A-Za-z0-9._-]` → '_'），中文名进来整个变成一串
 * 下划线：「品牌规范-2026.pdf」落盘成「_____-2026.pdf」。文件名是 agent 判断
 * 素材是什么的第一手信号（turn 的 assets 提示里就是列文件名给它看），抹掉等于
 * 每次上传都丢一层语义。
 *
 * 现在按"排除法"：路径分隔符、Windows 保留字符、控制字符、空白 → '_'（agent 会在
 * Bash 里引用这些路径，带空格容易出事）；开头的点去掉（防隐藏文件）；长度按码点
 * 截断（别把 UTF-8 从中间切断）。连字符和中文原样留着。
 * 落盘后仍然只在 assets/ 一层里用，路径逃逸由调用处的 resolve 前缀校验兜底。
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .normalize('NFC')
    .replace(UNSAFE_NAME_CHARS, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return 'unnamed';
  const chars = [...cleaned];
  if (chars.length <= 80) return cleaned;
  // 超长时保住扩展名 —— 后面的 mime 判断 / 是否当图上墙全看它
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(cleaned)?.[0] || '';
  return chars.slice(0, 80 - ext.length).join('') + ext;
}

/**
 * multer 按 RFC 7578 把 multipart 的 filename 当 latin1 读，中文名到手就是
 * 「æµè¯.txt」这种乱码。浏览器实际发的是 UTF-8 字节，按 latin1 还原成 Buffer
 * 再用 UTF-8 解一次就对了。解出来不是合法 UTF-8 时保留原值。
 */
function decodeUploadName(raw) {
  const name = String(raw || '');
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('\uFFFD') ? name : fixed;
  } catch { return name; }
}

/** 单层文件名：不许带路径、不许 '..'、不许以点开头（隐藏文件） */
function safeSegment(s) {
  return typeof s === 'string' && !!s && s.length <= 200
    && !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.startsWith('.');
}

router.post('/:pid/assets', upload.single('file'), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    if (!req.file) return res.status(400).json({ error: 'no file (field name: file)' });

    await ensureProjectWorkspace(req.params.pid);
    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');

    const originalName = decodeUploadName(req.file.originalname);
    let filename = sanitizeFilename(originalName);
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
        originalName,
        size: req.file.size,
        mime: req.file.mimetype,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:pid/assets', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;

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
    if (!guardProject(req, res)) return;

    const filename = req.params.filename;
    // 防 traversal：单层文件名 + resolve 后必须还在 assets/ 里
    // （不能用 ASCII 白名单——中文名的素材会删不掉）
    if (!safeSegment(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const filePath = path.resolve(assetsDir, filename);
    if (!filePath.startsWith(assetsDir + path.sep)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
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
 * 文件夹递归深度上限。
 *
 * 3 层是给用户的（prelude 里也是这么跟 agent 说的："层级别超过两三层"）——
 * 再深就得点进去好几下才看得见东西，桌面这个隐喻本身就失效了。这不是防御性
 * 的深度限制，构建目录 / node_modules 那类由 RESERVED_DIRS + HARD_IGNORE_DIRS
 * 挡在外面，跟深度无关。
 */
const FOLDER_MAX_DEPTH = 3;

/**
 * GET /:pid/artifacts — 产物清单（project 级，跨 session）。
 * 返回 { artifacts: [{ kind, name, path, size, mtime, ext, hasThumb }] }
 *   kind: 'generated'（agent 生成图，assets/generated/）| 'upload'（用户上传，assets/ 顶层）
 *   path: agent 视角相对路径（'assets/...'，session cwd 软链下直接可 Read / 引用）
 */
router.get('/:pid/artifacts', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;

    // 结构迁移挂在这里而不是只挂在「发消息 / 上传」上：这是**打开项目必调**的
    // 那个接口，而迁移一旦晚于第一次渲染，用户会先看到一个叫 `tasks` 的文件夹
    // 套着他的文件夹。跑过之后是三次 stat 的事（幂等早退），不值得省。
    await ensureProjectWorkspace(req.params.pid);
    // 跟上 agent 在画布背后做的改名（`mv` 之后卡片 id 就变了）。同上：挂在这里
    // 是为了让用户看到的第一帧就是对齐过的。没有新 commit 时是一次 rev-parse。
    await reconcileBoardRenames(req.params.pid).catch(
      (err) => console.warn('[board] 改名对账失败:', err.message));

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const artifacts = [];

    /**
     * 任务目录里**不该被当成收纳文件夹**的那些子目录。
     *
     * 任务目录是有槽位约定的：构建产物在 dist/out/build/_site/public，站点试作在
     * _drafts/，便利贴在 notes/（它单独扫、有自己的形态）。这些都由各自的 kind
     * 解析器管，递归进去只会把构建中间物倒到画布上。
     */
    const NOT_A_FOLDER = new Set([
      'dist', 'out', 'build', '_site', 'public',   // 构建产物（site.js 的 OUTPUT_DIRS）
      '_drafts',                                    // 站点试作（各自是独立产物）
      'notes',                                      // 便利贴（单独扫成 note 形态）
      'node_modules',
      // 扁平化之后扫描根变成整个工作区，这两个是基础设施不是收纳文件夹：
      // assets/ 上面已经按 upload / generated / note 三种语义单独扫过一遍，
      // 不挡的话每张图会以两个不同的 path 上墙两次。
      'assets', 'exports',
    ]);

    /**
     * @param {number} depth 还能往下几层。收纳只做**一层** —— 再深就不是"收纳"
     *   而是目录树了，画布上表达不了，也不是用户要的东西。
     */
    // 工作区根的 relPrefix 是空串，`${prefix}/${name}` 会拼出 `/canvas.html`
    // 这种带头斜杠的路径 —— 它会一路当成物件 id 传到画布和 artifact-file 路由。
    const joinRel = (prefix, name) => (prefix ? `${prefix}/${name}` : name);

    const scanDir = async (dir, kind, relPrefix, depth = 0) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          // 收纳文件夹（2026-08-07）：agent 用 mkdir + mv 把同主题的东西归到
          // 一起，画布把它显示成一组。它是**真目录**，不是画布上的虚拟分组 ——
          // 「文件系统即真相」这条不能因为加了个分组就破。
          if (depth <= 0) continue;
          if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
          if (NOT_A_FOLDER.has(e.name)) continue;
          await scanDir(path.join(dir, e.name), kind, joinRel(relPrefix, e.name), depth - 1);
          continue;
        }
        if (!e.isFile()) continue;
        if (e.name.startsWith('.')) continue;
        // 基础设施不上墙（board.json 是画布自己的布局档、*.template.* 是起手模板）
        if (isReservedFile(e.name)) continue;
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
          path: joinRel(relPrefix, e.name),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ext,
          isImage: IMAGE_EXTS.has(ext),
          // 不再探盘：缩略图地址对任何 generated 图都一定能出图（artifact-file
          // 缺文件时回原图现编一张，见 lib/image-variant.js）。原来那次 exists()
          // 探的是 .thumb.jpg，改名成 .thumb.webp 之后它会对老图一律返 false，
          // 让产物墙退回去加载 3MB 原图 —— 正好是这轮要消灭的东西。
          hasThumb: kind === 'generated' && IMAGE_EXTS.has(ext),
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

    // ── 项目产物（2026-08-07 扁平化）────────────────────────────────────
    //
    // 产物直接住工作区根，一个项目可以并排放**多个平等产物**：顶层每个 .html
    // 各是一份 deck、根 index.html = 一个站（子页和 style.css 不各自上墙）、
    // 无根站时带 index.html 的子目录各是一个站、_drafts/*.html 各是一个单页。
    // 没有主 / 试作等级。
    //
    // ── 文件夹枚举（2026-08-08）──────────────────────────────────────────
    //
    // 工作区就是一张桌面：产物可以摊在根上，也可以收进文件夹，文件夹还能套
    // 文件夹。所以解析器要**按文件夹跑**，一个文件夹一份 manifest。
    //
    // 字段名仍叫 `tasks`（前端的取数路径不用动），但语义已经是「文件夹」：
    // `id` 是**工作区相对路径**，根用 `''`。所有 id 都是路径，画布上的身份和
    // 磁盘上的位置是同一个字符串 —— 这样 agent `mv` 一个文件之后，git 的改名
    // 检测能直接翻译成画布 id 的改名（见 board-store 的 reconcileBoardRenames）。
    const workspaceRoot = getSharedDir(req.params.pid);
    const tasks = [];
    let hasRootSite = false;

    /** manifest 里的路径是相对**它那个目录**的，挂到工作区坐标系上要加前缀 */
    const under = (base, p) => (!p ? p : (base ? `${base}/${p}` : p));
    // 文件夹清单跟产物清单分开：**空文件夹也要出现在桌面上**（你刚建的那个
    // 还没往里放东西的文件夹，不该等有了产物才显形）
    const folders = [];

    const collect = async (dir, rel, depth) => {
      let stat;
      try { stat = await fs.stat(dir); } catch { return; }

      const manifest = await taskManifest(dir);
      const list = manifest?.artifacts || [];
      if (!rel) hasRootSite = list.some(a => a.kind === KIND_SITE && !a.single && !a.srcRoot);

      if (list.length) {
        tasks.push({
          id: rel,
          title: rel ? rel.split('/').pop() : (project.name || '产物'),
          kind: manifest.kind,
          sessionId: null,          // 产物与会话脱钩（2026-08-07）
          mtime: stat.mtime.toISOString(),
          exports: manifest.exportFormats || [],
          artifacts: list.map((a) => ({
            kind: a.kind,
            view: a.view,
            single: !!a.single,
            file: under(rel, a.file),        // deck / 单页：html 文件（相对工作区根）
            root: under(rel, a.root) || rel,
            srcRoot: under(rel, a.srcRoot),  // 站点源目录；root≠srcRoot = 构建型
            // entry 是**相对 base 的**，base + '/' + entry 必须永远拼得出真实路径。
            // 单页站点以前 base 给空、entry 给全路径，前端拿不到 base 就回退成
            // 文件夹名，拼出 `rin/rin/_drafts/…` 这种双前缀（实测 404）。
            // 现在单页也给 base（= 入口文件所在目录），两种站点一个拼法。
            entry: a.single ? path.basename(a.entryRel || '') : a.entry,
            entryRel: under(rel, a.entryRel),
            base: a.single
              ? under(rel, path.dirname(a.entryRel || '.')).replace(/^\.$/, rel)
              : (under(rel, a.root) || rel),
            pages: a.pages,                  // 站点内部路径，相对站根，不加前缀
            title: a.title,
            exports: a.exportFormats,
            // world 的地图（`世界/` 递归扫出的嵌套节点平列表，带 parent）。
            // 其余形态没有这个字段，前端按 kind 分支取用。
            nodes: a.nodes,
            truncated: a.truncated,   // 撞深度上限被截断的目录，要让人看见
          })),
        });
      }

      if (depth >= FOLDER_MAX_DEPTH) return;

      // 这个目录里，哪些子目录**已经被上面那份 manifest 认领**了。
      //
      // 一个站点目录既能被父目录扫成一件产物（`site:伊蕾娜手账研究站`），又能被
      // 当成一个文件夹递归进去 —— 不去重的话它在桌面上出现两次：一张站点卡 +
      // 一张同名文件夹卡，点哪个都对一半。认领了就跳过：**它是产物，不是容器**，
      // 里面的 `assets/` `pages/` 是这个站的内部结构，不是并列的文件夹。
      const claimed = new Set();
      for (const a of list) {
        for (const p of [a.root, a.srcRoot, a.file, a.entryRel]) {
          const seg = String(p || '').split('/')[0];
          if (seg && seg !== p) claimed.add(seg);       // 只有带下级路径的才算认领
          else if (seg && a.kind !== 'deck') claimed.add(seg);
        }
      }

      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        if (RESERVED_DIRS.has(e.name) || HARD_IGNORE_DIRS.has(e.name)) continue;
        if (e.name === DRAFTS_DIR) continue;      // 站点试作，由 site 解析器管
        if (claimed.has(e.name)) continue;        // 已经是一件产物了
        folders.push(under(rel, e.name));
        await collect(path.join(dir, e.name), under(rel, e.name), depth + 1);
      }
    };

    try {
      await collect(workspaceRoot, '', 0);
      // 散文件（agent 写的 .md、数据文件、脚本…）。工作区根 + 每个文件夹各平铺
      // 一层，这样收进文件夹的 .md 也上墙 —— 它的 id 天然带着文件夹前缀，
      // 前端据此把它归到那个文件夹里。
      await scanDir(workspaceRoot, 'task-file', '', 1);
      await scanDir(path.join(workspaceRoot, 'notes'), 'note', 'notes');
      for (const rel of folders) {
        await scanDir(path.join(workspaceRoot, rel), 'task-file', rel, 1);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // .html 不当普通文件卡上墙（deck / 站点物件已经代表它们了）；
    // 根站存在时整个工作区的文件都归那个站，不散着上墙。
    const filtered = artifacts.filter((a) => {
      if (a.kind !== 'task-file') return true;
      if (hasRootSite) return false;
      return !a.name.toLowerCase().endsWith('.html');
    });

    // 剪掉画布上没有对应目录的文件夹。
    //
    // 跟物件不一样，文件夹**有权威清单**：`folders` 就是刚扫出来的磁盘真相。
    // 物件那边不能这么干（board.objects 是稀疏的，"不在 board 里"是常态，
    // "在 board 里但磁盘上没有"跟 agent 正在写时的一瞬读不到没法区分），
    // 文件夹这边可以 —— 渲染用的和判断用的是同一份清单。
    //
    // 存量垃圾有两类：任务模型之前的「会话分区」（id 是 sessionId），以及
    // 中途某个版本写下的 `task/.`。它们在画布上是永远删不掉的空框。
    const live = new Set(folders);
    const board = await readBoard(req.params.pid);
    const deadZones = Object.keys(board.zones || {}).filter(z => !live.has(z));
    if (deadZones.length) {
      await patchBoard(req.params.pid, {
        zones: Object.fromEntries(deadZones.map(z => [z, null])),
      });
      console.log(`[board] ${req.params.pid} 清掉 ${deadZones.length} 个没有目录撑着的文件夹: ${deadZones.slice(0, 3).join(', ')}`);
    }

    filtered.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ artifacts: filtered, tasks, folders });
  } catch (err) { next(err); }
});

/**
 * GET /:pid/cover — 项目封面 webp（首页卡片缩略图）
 *
 * 服务端截最新产物的图（见 lib/cover.js 里为什么不是 iframe）。缓存按源 mtime，
 * 命中就是读盘；没命中要起一次 chromium，串行排队，冷启动 1-3s。
 * 没产物 / 截图环境不可用 → 204，前端画占位框（不是错误，别报 500）。
 */
router.get('/:pid/cover', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    let result;
    try {
      result = await getProjectCover(req.params.pid, getSharedDir(req.params.pid));
    } catch (err) {
      console.warn('[cover] render failed:', err.message);
      return res.status(204).end();
    }
    if (!result) return res.status(204).end();
    if (req.headers['if-none-match'] === `"${result.etag}"`) return res.status(304).end();
    res.set('ETag', `"${result.etag}"`);
    res.set('Cache-Control', 'private, max-age=60');
    res.type('image/webp').send(result.buffer);
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
    if (!guardProject(req, res)) return;
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

/** DELETE /:pid/notes/:filename — 删便签（仅 notes/ 目录，单层名 + 落点校验） */
router.delete('/:pid/notes/:filename', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const filename = req.params.filename;
    if (!safeSegment(filename) || !filename.endsWith('.md')) {
      return res.status(400).json({ error: 'invalid note filename' });
    }
    const notesDir = path.join(getSharedDir(req.params.pid), 'assets', 'notes');
    const filePath = path.resolve(notesDir, filename);
    if (!filePath.startsWith(notesDir + path.sep)) {
      return res.status(400).json({ error: 'invalid note filename' });
    }
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

function resolveTaskNote(pid, filename) {
  const base = path.join(getSharedDir(pid), 'notes');
  const file = path.resolve(base, filename);
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

/** PUT /:pid/task-notes/:filename — 写/改便利贴（用户侧编辑） */
router.put('/:pid/task-notes/:filename', express.json(), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { filename } = req.params;
    if (!safeNoteSegment(filename, { md: true })) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    if (text.length > 20_000) return res.status(400).json({ error: 'note too long (max 20k chars)' });
    const file = resolveTaskNote(req.params.pid, filename);
    if (!file) return res.status(400).json({ error: 'invalid path' });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    res.json({ ok: true, path: `notes/${filename}` });
  } catch (err) { next(err); }
});

/** DELETE /:pid/task-notes/:filename — 删便利贴 */
router.delete('/:pid/task-notes/:filename', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { filename } = req.params;
    if (!safeNoteSegment(filename, { md: true })) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const file = resolveTaskNote(req.params.pid, filename);
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
 * DELETE /:pid/folders/*subPath —— 删一个文件夹（连同里面的一切）。
 *
 * 取代旧的 `DELETE /:pid/tasks/:name`。那条做三件事：删任务目录、**连带删掉
 * 绑定的那次对话**、清 board.json 里的 zone 行。中间那件随「任务=会话」一起
 * 废了 —— 会话现在归项目，跟任何文件夹都没有绑定关系，删文件夹不该动对话。
 *
 * 路径按**工作区相对路径**收（`稿件/初稿`），因为文件夹可以嵌套。
 */
router.delete('/:pid/folders/*subPath', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const raw = req.params.subPath;
    const rel = (Array.isArray(raw) ? raw.join('/') : (raw || '')).replace(/\/+$/, '');
    if (!rel) return res.status(400).json({ error: 'folder path required' });

    const root = getSharedDir(req.params.pid);
    const dir = path.resolve(root, rel);
    // 防越界 + 防把工作区自己删了；保留目录一概不许删（.claude 里是项目指引和
    // 记忆，.nd 是各次对话的暗档案，.git 是历史 —— 都不是"用户的文件夹"）
    if (dir !== path.join(root, rel) || !dir.startsWith(root + path.sep)) {
      return res.status(400).json({ error: 'invalid path' });
    }
    if (RESERVED_DIRS.has(rel.split('/')[0])) {
      return res.status(400).json({ error: 'reserved directory' });
    }
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return res.status(404).json({ error: 'folder not found' });

    await fs.rm(dir, { recursive: true, force: true });

    // board.json 跟着剪：这个文件夹自己的那行，以及住在它里面的全部物件。
    // 不剪的话磁盘上没了、画布上还在，就是 2026-07-30 那批「删不掉的僵尸
    // 文件夹」的来源 —— 删除必须是一个动作，不能指望前端补第二刀。
    const board = await readBoard(req.params.pid);
    const patch = { zones: { [rel]: null }, objects: {} };
    const under = `${rel}/`;
    for (const id of Object.keys(board?.objects || {})) {
      const p = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
      if (p === rel || p.startsWith(under)) patch.objects[id] = null;
    }
    for (const zid of Object.keys(board?.zones || {})) {
      if (zid.startsWith(under)) patch.zones[zid] = null;      // 嵌套在里面的子文件夹
    }
    await patchBoard(req.params.pid, patch);

    res.json({ ok: true, removed: rel, objects: Object.keys(patch.objects).length });
  } catch (err) { next(err); }
});

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
    if (!guardProject(req, res)) return;

    const raw = req.params.subPath;
    let subPath = Array.isArray(raw) ? raw.join('/') : (raw || '');
    if (!subPath) return res.status(400).json({ error: 'file path required' });
    // 兼容旧形态：`tasks/<任务>/x` 是扁平化之前的路径，浏览器缓存里、旧
    // board.json 里、用户收藏的链接里都还有。剥掉前两段就是现在的位置。
    subPath = subPath.replace(/^tasks\/[^/]+\//, '');

    // 可服务根 = 整个项目工作区（产物就住在这儿），但**挡掉基础设施**：
    // .claude/（含 settings.json 和整份 SDK 转录）、.nd/（会话私档）、.git/。
    // 扁平化之前这三样都在可服务根之外，是目录结构在替我们把门；现在它们跟
    // 产物同级，必须显式拦 —— 否则 `artifact-file/.claude/settings.json`
    // 是一个能公开读到配置的 URL。
    const sharedRoot = path.resolve(getSharedDir(req.params.pid));
    const absPath = path.resolve(sharedRoot, subPath);
    if (absPath !== sharedRoot && !absPath.startsWith(sharedRoot + path.sep)) {
      return res.status(403).json({ error: 'path escapes workspace' });
    }
    // 点开头的一律拒**是错的**：缩略图就住在 `assets/generated/.thumbnails/`，
    // 一刀切下去产物墙上所有生成图的缩略图全 403（实测一个项目 110 条报错，
    // 图能显示只是因为兜底会回原图现编一张，代价是每次都重编）。
    // 所以按名字判：这几个是**已知安全**的内部目录，其余点开头的照拒
    // （白名单而不是黑名单 —— 将来冒出个 `.env` 不该因为没人想到就漏出去）。
    const DOT_OK = new Set(['.thumbnails', '.meta']);
    const rel = path.relative(sharedRoot, absPath).split(path.sep);
    if (rel.some(seg => seg.startsWith('.') && !DOT_OK.has(seg))) {
      return res.status(403).json({ error: 'not a servable path' });
    }

    let stat;
    let servePath = absPath;
    // 缩略图地址缺文件时回原图现编一张（老图 / 生成失败 / 07-31 前的 .thumb.jpg）。
    // 产物墙的缩略图走的就是这条路由，跟 canvas 那条 session assets 路由同一份兜底。
    let servedOriginalForThumb = false;
    try {
      stat = await fs.stat(servePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const original = isThumbPath(servePath) ? await findOriginalForThumbnail(servePath) : null;
      if (!original) return res.status(404).json({ error: 'file not found' });
      servePath = original;
      stat = await fs.stat(original);
      servedOriginalForThumb = true;
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
    // 站点在编辑中要看到最新的那一份：html/css/js 一律 no-store —— no-cache 不够，
    // CF 会对这些扩展名边缘缓存 + 把浏览器 TTL 改写成 4 小时（见路由入口注释）。
    // 图片按 URL 有没有版本标记决定能缓多久（见 imageCacheControl）。
    const editable = ext === '.html' || ext === '.htm' || ext === '.css' || ext === '.js';
    res.setHeader('Cache-Control', editable ? 'no-store' : imageCacheControl(req));

    // 这条路由是站点窗的图片入口：站点页面里的 <img src="assets/x.png"> 全打这儿。
    // deck 那条 thumbnail 重写只作用于 GET /canvas，站点从来没享受过，于是一页
    // 三张生图就是 5MB 起。显示一律发派生图（原图只留给导出）后降 ~90%。
    // 尺寸由 ?w= 决定（srcset 注入产生），不传就是原尺寸：站点按真实设备宽取景，
    // 服务端自作主张缩会让桌面糊。
    if (IMAGE_EXTS.has(ext)) {
      return sendImage(req, res, servePath, stat, {
        fallbackMime: ARTIFACT_MIME[ext] || 'application/octet-stream',
        maxDim: servedOriginalForThumb ? THUMBNAIL_MAX_DIM : null,
        quality: servedOriginalForThumb ? THUMBNAIL_QUALITY : undefined,
      });
    }

    // 视频：Range + 派生档。以前这条路由对视频是整个文件一次性 res.end，
    // 没有 206 浏览器拖不动进度条（见 lib/video-variant.js）。
    if (isVideo(ext)) {
      return sendVideo(req, res, servePath, stat, {
        fallbackMime: ARTIFACT_MIME[ext] || 'application/octet-stream',
      });
    }

    // 站点页面：注入 srcset 让浏览器按视口挑尺寸。只加属性不动 DOM 结构，
    // 理由见 lib/html-srcset.js（<picture> 会改盒模型，站点布局是 agent 写的）。
    if (ext === '.html' || ext === '.htm') {
      let html = await fs.readFile(servePath, 'utf8');
      try {
        html = await injectSrcset(html, path.dirname(servePath), sharedRoot);
      } catch (err) {
        console.warn('[artifact-file] srcset inject failed:', err.message);
      }
      const body = Buffer.from(html, 'utf8');
      res.setHeader('Content-Type', ARTIFACT_MIME[ext]);
      res.setHeader('Content-Length', body.length);
      return res.end(body);
    }

    res.setHeader('Content-Type', ARTIFACT_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.end(await fs.readFile(servePath));
  } catch (err) { next(err); }
});

export default router;
