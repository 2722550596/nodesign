/**
 * lib/export-package.js — 把收集到的产物打成用户拿得走的东西（2026-08-17）
 *
 * 分两个出口，各自说清给谁：
 *   **看的出口**  raw / zip —— 给不动手的人。原件或一个压缩包，双击就能看。
 *   **接手的出口** handoff（工程包）—— 给要继续开发的人。除了源码，还带一份
 *                  「这是什么、怎么跑、mock 数据在哪、你的后端要实现哪些接口」。
 *
 * ⭐**zip 布局保持工作区相对路径，不做任何改写。**
 * 旧交付包把东西塞进 `design/` 再回头重写 `../../assets/` 前缀，于是有了一整类
 * 裂图 bug（深度算错一层，图全裂）。保持原布局的话，产物里的相对引用**天然成立**，
 * 零改写、零深度计算 —— 那类 bug 从根上不存在。代价只是解压出来多一层目录，
 * 换来的是"打开就对"。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { renderUnresolvedReport } from './asset-refs.js';

/** 文件名里不能出现的东西（路径分隔与父目录） */
export function safeName(name, fallback = '导出') {
  const s = String(name || '').replace(/[/\\]/g, '_').replace(/\.\.+/g, '.').trim();
  return s || fallback;
}

/**
 * 从 `api.js` 那层抽出后端接口清单。
 *
 * 应用道的约定是：所有数据访问走一层 `api/` 函数，每个函数右边注上建议路由
 * （`// GET /api/posts`）。**那列注释就是交接文档的草稿** —— 这里把它抽成表，
 * 用户拿到的就不只是前端，还有一份现成的后端需求规格。这是「用了模拟数据」
 * 从缺陷变成资产的那一步。
 *
 * 抓的是 `export const 名字 = ... // METHOD /path` 和 `export async function 名字`。
 */
export function extractApiContract(source) {
  const rows = [];
  // ⚠️ 标识符类必须认 Unicode。JS 的标识符本来就允许非 ASCII，而这个产品里
  // agent 写的代码大量用中文命名（`export const 列出书目 = …`）—— 用
  // `[A-Za-z_$]` 会把它们整片漏掉，接口表少一半还不报错。
  const lineRe = /export\s+(?:const|let|async\s+function|function)\s+([\p{L}_$][\p{L}\p{N}_$]*)[^\n]*?(?:\/\/\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+))?\s*$/gmu;
  let m;
  while ((m = lineRe.exec(source)) !== null) {
    const [, name, method, route] = m;
    if (!name) continue;
    rows.push({ name, method: method || null, route: route || null });
  }
  return rows;
}

/** 在收到的文件里找 api 层（`app/api.js` / `src/api/index.js` / 任何 `api.js`） */
function findApiFile(files) {
  const score = (rel) => {
    if (/(^|\/)app\/api\.js$/i.test(rel)) return 3;
    if (/(^|\/)api\/index\.js$/i.test(rel)) return 2;
    if (/(^|\/)api\.js$/i.test(rel)) return 1;
    return 0;
  };
  return files.map(f => ({ f, s: score(f.rel) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)[0]?.f || null;
}

/** 有没有 package.json，决定 README 里写「双击打开」还是「npm i && npm run build」 */
function findPackageJson(files) {
  return files.find(f => /(^|\/)package\.json$/.test(f.rel)) || null;
}

/**
 * 工程包的 README —— 交付物的一半。
 * 没有它，用户拿到的是一堆他不敢动的文件。
 */
async function renderHandoffReadme({ projectName, bundles, apiRows, pkg, missing, hasMock }) {
  const titles = bundles.map(b => b.title).join('、');
  const L = [];
  L.push(`# ${projectName || titles || '设计交付'}`, '');
  L.push(`本包由 NoDesign 导出，包含 ${bundles.length} 份产物：${titles}。`, '');

  L.push('## 怎么打开', '');
  if (pkg) {
    L.push('这是一个需要构建的工程：', '', '```bash', 'npm install', 'npm run build', '```', '');
    L.push('构建产物在 `dist/`（或 package.json 里 build 脚本指定的目录）。**`node_modules` 不在包里**，靠上面这两行装回来。', '');
  } else {
    L.push('直接用浏览器打开入口 html 就行，不需要装任何东西。页面之间是相对链接，不依赖服务器。', '');
  }

  if (hasMock) {
    L.push('## 现在的数据是假的', '');
    L.push('所有数据来自 `mock` / `seed` 那一层，写操作存在浏览器 localStorage 里。清掉浏览器数据就回到初始状态。', '');
    L.push('**这是一个可运行的原型，不是上线的系统** —— 托管和真实数据是你自己的事。', '');
  }

  if (apiRows.length) {
    L.push('## 换成真后端要改哪里', '');
    L.push('只改 api 那一层文件：把每个函数从调用 mock 改成 `fetch`。**页面代码一行都不用动。**', '');
    L.push('你的后端需要提供这些接口：', '');
    L.push('| 函数 | 建议路由 |', '|---|---|');
    for (const r of apiRows) {
      L.push(`| \`${r.name}\` | ${r.method && r.route ? `\`${r.method} ${r.route}\`` : '（源码里没注路由，自己定）'} |`);
    }
    L.push('');
  }

  if (missing.length) {
    L.push('## ⚠️ 有几个引用没找到对应文件', '');
    L.push('下面这些是页面里引用了、但打包时磁盘上没有的（原工程里可能已经删了或改名了）：', '');
    for (const m of missing.slice(0, 30)) L.push(`- \`${m}\``);
    if (missing.length > 30) L.push(`- …还有 ${missing.length - 30} 条`);
    L.push('');
  }

  L.push('## 包里有什么', '');
  L.push('目录结构跟原工作区一致，**没有做任何路径改写** —— 所以页面里的相对引用原样成立，解压出来直接能用。', '');
  return L.join('\n');
}

/**
 * 打包。
 *
 * @param {Array} bundles  collectCard 的产出
 * @param {object} opts
 * @param {'raw'|'zip'|'md'|'handoff'|'site'} opts.format
 * @param {string} [opts.projectName]
 * @returns {Promise<{filename:string, buffer:Buffer, mime:string}>}
 */
export async function packageBundles(bundles, { format, projectName } = {}) {
  if (!bundles?.length) {
    throw Object.assign(new Error('没有可导出的产物'), { status: 400 });
  }

  // 原件直下：只有单张卡、且只有一个文件时成立
  if (format === 'raw') {
    if (bundles.length !== 1 || bundles[0].files.length !== 1) {
      throw Object.assign(new Error('原件直下只能对单个文件用，多个请用 zip'), { status: 400 });
    }
    const f = bundles[0].files[0];
    return {
      filename: path.basename(f.rel),
      buffer: await fs.readFile(f.abs),
      mime: 'application/octet-stream',
    };
  }

  // 便签合并成一份 markdown
  if (format === 'md') {
    const parts = [];
    for (const b of bundles) {
      for (const f of b.files) {
        if (!/\.md$/i.test(f.rel)) continue;
        parts.push(`<!-- ${f.rel} -->\n\n${await fs.readFile(f.abs, 'utf8')}`);
      }
    }
    if (!parts.length) throw Object.assign(new Error('这些卡里没有 markdown 可合并'), { status: 400 });
    return {
      filename: `${safeName(projectName, '便签')}.md`,
      buffer: Buffer.from(parts.join('\n\n---\n\n'), 'utf8'),
      mime: 'text/markdown; charset=utf-8',
    };
  }

  const zip = new JSZip();
  const seen = new Set();
  const allMissing = []; const allUnresolved = [];
  const allFiles = []; const allAssets = [];

  for (const b of bundles) {
    allMissing.push(...b.missing);
    allUnresolved.push(...b.unresolved);
    allFiles.push(...b.files);
    allAssets.push(...b.assets);
    for (const f of [...b.files, ...b.assets]) {
      if (seen.has(f.rel)) continue;          // 多张卡引用同一张图时只进一次
      seen.add(f.rel);
      try { zip.file(f.rel, await fs.readFile(f.abs)); } catch { /* 中途被删就跳过 */ }
    }
  }

  // 没解析出来的引用写成清单。**没有就不放** —— 旧包里那个常年空着的
  // prompt.txt 就是"占位符放着放着就成了垃圾"的样板。
  const report = renderUnresolvedReport(allUnresolved);
  if (report) zip.file('未解析的引用.md', report);

  if (format === 'handoff') {
    const apiFile = findApiFile(allFiles);
    const apiRows = apiFile ? extractApiContract(await fs.readFile(apiFile.abs, 'utf8').catch(() => '')) : [];
    const pkg = findPackageJson(allFiles);
    const hasMock = allFiles.some(f => /(^|\/)(mock|seed)[./]/i.test(f.rel));
    zip.file('README.md', await renderHandoffReadme({
      projectName, bundles, apiRows, pkg, missing: allMissing, hasMock,
    }));
  }

  const base = safeName(projectName || bundles[0].title, '导出');
  const suffix = format === 'handoff' ? '-工程包' : '';
  return {
    filename: `${base}${suffix}.zip`,
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    mime: 'application/zip',
  };
}
