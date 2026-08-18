/**
 * kinds/site.js — 站点形态（网站 / 个人站 / 落地页 / 博客）
 *
 * 站点跟 deck 的本质区别是**源和产物可以分开**：
 *   手写站点   —— 源即产物，index.html 在任务根（产物根 = ''）
 *   构建型站点 —— 源在任务根（md / 模板 / 构建脚本随便放），构建产物落在
 *                约定目录（dist/ out/ build/ _site/ public/，谁有 index.html 认谁），
 *                或 `.nd-project.json` 里 `root` 字段显式指定（08-07 从
 *                `.nd-task.json` 改名，读的是 kinds/index.js readTaskMarker）。
 * 预览、截图、list_pages、整站 zip、发布，全部指向产物根；任务根是 agent 的地盘。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { walkTaskFiles, loadIgnore, DRAFTS_DIR, RESERVED_DIRS } from '../task-scan.js';

const ENTRY = 'index.html';

/** 构建产物的约定目录，按序探测（谁有 index.html 认谁）。任务根有 index.html 时不看这些 */
const OUTPUT_DIRS = ['dist', 'out', 'build', '_site', 'public'];

/** 站点页面扫描深度（产物根之下；子页 / posts/ / pages/ 够用） */
const PAGE_DEPTH = 4;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function normRoot(r) {
  const s = String(r || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  return (!s || s === '.' || s.includes('..')) ? '' : s;
}

/**
 * 产物根（相对任务目录，'' = 任务根）。
 * marker.root 是显式声明，最优先 —— 哪怕入口还没构建出来（agent 刚写完源、
 * 还没跑 build 的窗口期），寻址也该指向将要出现的地方而不是源目录。
 */
async function artifactRoot(taskDir, marker) {
  const declared = normRoot(marker?.root);
  if (declared) return declared;
  if (await exists(path.join(taskDir, ENTRY))) return '';
  for (const d of OUTPUT_DIRS) {
    if (await exists(path.join(taskDir, d, ENTRY))) return d;
  }
  return '';
}

/**
 * 站点产物实例发现（2026-07-29 多产物平权）：
 *   - 任务根有 index.html（或声明根 / 约定构建目录）→ 整个任务是**一个**站点
 *     实例，子目录是它的页面（about/index.html 是 pretty-URL，这是 web 事实，
 *     不能把每个带 index.html 的子目录都拆成独立站）
 *   - 任务根没有站点证据 → 带 index.html 的**一级子目录**各算一个站点实例
 *     （两个平行版本 v1/ v2/ 就这么放）
 *   - `_drafts/<名>.html` → 各自一个**单页**实例（single:true），平等产物，
 *     不再叫"试作"
 */
async function discoverInstances(taskDir, marker) {
  const out = [];
  const declared = normRoot(marker?.root);
  const root = await artifactRoot(taskDir, marker);
  // 根站成立条件：算出的产物根下有 index.html；或 marker 显式声明了 root
  // （声明即意图 —— agent 刚写完源还没 build 的窗口期，站已经"在了"）
  const rootSite = declared ? true : await exists(path.join(taskDir, root || '.', ENTRY));

  if (rootSite) {
    out.push({ srcRoot: '', root, single: false });
  } else {
    // 无根站：一级子目录各自为站
    let entries = [];
    try { entries = await fs.readdir(taskDir, { withFileTypes: true }); } catch { /* */ }
    const ignore = await loadIgnore(taskDir);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === DRAFTS_DIR) continue;
      if (RESERVED_DIRS.has(e.name)) continue;
      if (ignore(e.name, true)) continue;
      if (await exists(path.join(taskDir, e.name, ENTRY))) {
        out.push({ srcRoot: e.name, root: e.name, single: false });
      }
    }
  }

  // 单页实例（原"试作"，平权后就是普通的单文件页面产物）
  try {
    const d = await fs.readdir(path.join(taskDir, DRAFTS_DIR), { withFileTypes: true });
    for (const e of d) {
      if (e.isFile() && /\.html?$/i.test(e.name) && !e.name.startsWith('.')) {
        out.push({ srcRoot: '', root: '', single: true, file: `${DRAFTS_DIR}/${e.name}` });
      }
    }
  } catch { /* 没有 _drafts/：正常 */ }
  return out;
}

export default {
  id: 'site',
  capabilities: ['browsable'],   // 入口是 html，能塞进 iframe / playwright
  entryFile: ENTRY,
  view: 'site',
  injectFit: false,         // 整屏翻页脚本会把长页改造成翻页器；stripFitScripts 的启发式也会误删站点动画
  exportFormats: ['site', 'html', 'handoff'],
  referenceDoc: { file: 'site-reference', title: '站点技术参考' },
  // 目录型实例判据（卡即文件夹）：单页（_drafts）是一个文件，其余站都是一棵树。
  // 「这张卡是不是文件夹」全仓只问 isDirArtifact（kinds/index.js），别在调用点自判
  directory: (a) => !a.single,
  discoverInstances,

  /** 任务根 / 声明的产物根 / 约定产物目录，任何一处有 index.html 都算站点 */
  async detect(taskDir, marker) {
    const declared = normRoot(marker?.root);
    if (declared && await exists(path.join(taskDir, declared, ENTRY))) return true;
    if (await exists(path.join(taskDir, ENTRY))) return true;
    for (const d of OUTPUT_DIRS) {
      if (await exists(path.join(taskDir, d, ENTRY))) return true;
    }
    return false;
  },

  artifactRoot,

  /**
   * 单个站点实例的完整条目。pages 相对**实例产物根**（预览窗直接拼 URL）。
   * 单页实例（原 _drafts）pages 就是它自己那一页。
   */
  async instanceManifest(taskDir, marker, inst) {
    if (inst.single) {
      return {
        kind: 'site',
        root: '',
        srcRoot: '',
        entry: inst.file,
        entryRel: inst.file,
        file: inst.file,
        pages: [inst.file],
        single: true,
        title: inst.file.replace(new RegExp(`^${DRAFTS_DIR}/`), '').replace(/\.html?$/i, ''),
      };
    }
    const root = inst.root || '';
    const rootAbs = root ? path.join(taskDir, root) : taskDir;
    const ignore = await loadIgnore(taskDir);
    const files = await walkTaskFiles(rootAbs, { maxDepth: PAGE_DEPTH, ignore, ignoreBase: taskDir });
    const pages = files
      .filter(f => /\.html?$/i.test(f.name))
      // 根站（root=''）时 canvas.html 是 deck 的保留名，不算站点页面。
      // root 非空（dist/ 或子目录站）时目录即边界，不用滤
      .filter(f => root || (f.rel !== 'canvas.html'))
      .map(f => f.rel)
      .sort((a, b) => (a === ENTRY ? -1 : b === ENTRY ? 1 : a.localeCompare(b)));
    return {
      kind: 'site',
      root,
      srcRoot: inst.srcRoot || '',
      entry: ENTRY,
      entryRel: root ? `${root}/${ENTRY}` : ENTRY,
      file: null,
      pages,
      single: false,
      title: inst.srcRoot || null,   // 根站 null（前端用任务名），子目录站用目录名
    };
  },

  async describe(taskDir, artifact) {
    if (artifact.single) return `单页 ${artifact.entryRel}`;
    const parts = [`站点${artifact.srcRoot ? ` ${artifact.srcRoot}/` : ''} · ${artifact.pages.length} 个页面：${artifact.pages.slice(0, 6).join(' / ')}${artifact.pages.length > 6 ? ' …' : ''}`];
    if (artifact.root && artifact.root !== artifact.srcRoot) {
      parts.push(`产物根 ${artifact.root}/（预览与导出看这里，改完源记得重新构建）`);
    }
    return parts.join(' · ');
  },
};
