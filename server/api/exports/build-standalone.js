/**
 * server/api/exports/build-standalone.js
 *
 * 把 hybrid canvas.html 打包成"自包含离线 HTML"——CDN 全 inline，用户拿到能离线双击打开。
 *
 * 触发条件：检测到 <script type="text/babel"> 存在 = hybrid 文件 → 走管道
 * 老 deck（无 babel script）→ 不走管道，调用方降级到 injectViewportFit 文本替换
 *
 * 7 步管道：
 *   1. parse：抽 importmap / babel scripts / Tailwind CDN script tag
 *   2. esbuild bundle：babel script 内容当 entry，import 走 esm.sh HTTP plugin（in-memory LRU cache）
 *   3. tailwind extract：跑 tailwindcss CLI on stdin，--content 指 raw html，--output 拿 used CSS
 *   4. replace tags：删 importmap / Babel CDN / Tailwind CDN script，替换 babel scripts 为 type=module 的 bundled JS
 *   5. inline tailwind CSS：插入 <style> 到 <head>
 *   6. inject viewport fit（复用 injectViewportFit）—— 跟 commit 1 / 2 / 3 已有的 fit script 兼容
 *   7. return assembled HTML
 *
 * 性能预期：首次导出 5-10s（CDN fetch 耗时）；缓存命中后 1-2s（仅 esbuild bundle + tailwind extract）
 *
 * 错误降级：管道任一步失败 → throw，调用方应回落到原 injectViewportFit（保证导出至少能拿到能用的 HTML）
 */

import { build } from 'esbuild';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Tailwind CLI 路径 — 项目本地 install */
const TAILWIND_BIN = path.resolve(__dirname, '../../../node_modules/.bin/tailwindcss');

/**
 * 去掉 HTML 注释——避免 regex 把注释里的 `<script type="text/babel">` 字面
 * 字符当成真 script tag 抓（template 顶部就有这种注释提示）。
 *
 * 仅用于 parser 内部 regex 扫描；assemble 阶段仍用原始 rawHtml（保留注释作为 doc）。
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Hybrid 文件检测（heuristic）—— 检测真 script tag，不是注释里的字面文字
 * @param {string} html
 * @returns {boolean}
 */
export function isHybridHtml(html) {
  return /<script[^>]*type=["']text\/babel["']/i.test(stripHtmlComments(html));
}

/**
 * 主入口：打包成自包含 HTML
 *
 * @param {string} rawHtml canvas.html 原文
 * @returns {Promise<string>} 自包含 HTML（CDN 全 inline，可离线打开）
 * @throws 任一步骤失败抛——调用方应降级到 injectViewportFit 文本替换
 */
export async function buildStandaloneHtml(rawHtml) {
  if (!isHybridHtml(rawHtml)) {
    throw new Error('Not a hybrid HTML — caller should fall back to injectViewportFit');
  }

  // 1. parse —— 抽出关键段
  const parsed = parseHybridDoc(rawHtml);

  // 2. bundle JS（esbuild + esm.sh HTTP plugin）—— commit 2 填实现
  const bundledJs = await bundleBabelScripts(parsed.babelScripts, parsed.importmap);

  // 3. extract Tailwind used CSS（tailwindcss CLI on stdin）—— commit 2 填实现
  const tailwindCss = await extractTailwindCss(rawHtml);

  // 4-7. 重写 HTML —— inline 所有外部 CDN
  return assembleStandaloneHtml({
    rawHtml,
    parsed,
    bundledJs,
    tailwindCss,
  });
}

// ──────────────────────────────────────────────────────────────────
// Step 1 · parseHybridDoc
// ──────────────────────────────────────────────────────────────────

/**
 * 抽出 hybrid HTML 的关键段：importmap / babel scripts / Tailwind CDN tag / Babel standalone tag
 *
 * @param {string} html
 * @returns {{
 *   importmap: object | null,
 *   importmapTagFull: string | null,
 *   babelScripts: Array<{ content: string, fullTag: string }>,
 *   tailwindCdnTag: string | null,
 *   babelCdnTag: string | null,
 *   tailwindConfigTag: string | null
 * }}
 */
export function parseHybridDoc(html) {
  // 关键：先 strip HTML 注释——避免 template 顶部 doc-comment 里的字面 <script>
  // 字符串被 regex 误抓。assemble 阶段仍 replace 原始 rawHtml，所以注释保留。
  const scan = stripHtmlComments(html);

  // importmap
  let importmap = null;
  let importmapTagFull = null;
  const importmapMatch = scan.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (importmapMatch) {
    importmapTagFull = importmapMatch[0];
    try { importmap = JSON.parse(importmapMatch[1]); } catch { /* malformed */ }
  }

  // babel scripts —— 多个段都收
  const babelScripts = [];
  const babelRe = /<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = babelRe.exec(scan)) !== null) {
    babelScripts.push({ content: m[1], fullTag: m[0] });
  }

  // Tailwind CDN tag —— 替换目标
  const tailwindCdnMatch = scan.match(/<script[^>]*src=["']https?:\/\/cdn\.tailwindcss\.com[^"']*["'][^>]*><\/script>/i);
  const tailwindCdnTag = tailwindCdnMatch ? tailwindCdnMatch[0] : null;

  // Tailwind config tag （tailwind.config = {...}）—— 移除（运行时不再需要）
  const tailwindConfigMatch = scan.match(/<script>[\s\S]*?tailwind\.config[\s\S]*?<\/script>/i);
  const tailwindConfigTag = tailwindConfigMatch ? tailwindConfigMatch[0] : null;

  // Babel standalone tag —— 删除（已 esbuild 预编译）
  const babelCdnMatch = scan.match(/<script[^>]*src=["'][^"']*@babel\/standalone[^"']*["'][^>]*><\/script>/i);
  const babelCdnTag = babelCdnMatch ? babelCdnMatch[0] : null;

  return { importmap, importmapTagFull, babelScripts, tailwindCdnTag, babelCdnTag, tailwindConfigTag };
}

// ──────────────────────────────────────────────────────────────────
// Step 2 · bundleBabelScripts —— esbuild + esm.sh HTTP plugin
// ──────────────────────────────────────────────────────────────────

/**
 * In-memory LRU cache for esm.sh fetched modules.
 * Key = absolute URL after redirect resolution.
 * Value = { contents: string, contentType: string }
 *
 * 容量 500 entries（一个 deck bundle 涉及 ~30-100 个 esm.sh 子模块；缓存几个 deck 够用）。
 * 每条 entry size 通常 5-50KB → cache 顶峰 ~10MB，进程重启就清。
 */
const REMOTE_CACHE_MAX = 500;
const remoteCache = new Map();

function cacheGet(key) {
  if (!remoteCache.has(key)) return undefined;
  const v = remoteCache.get(key);
  remoteCache.delete(key);  // LRU 用 Map 顺序，命中时挪到末尾
  remoteCache.set(key, v);
  return v;
}

function cacheSet(key, val) {
  if (remoteCache.size >= REMOTE_CACHE_MAX) {
    const oldestKey = remoteCache.keys().next().value;
    remoteCache.delete(oldestKey);
  }
  remoteCache.set(key, val);
}

/**
 * 把所有 babel script 内容拼成一个 entry，喂给 esbuild bundle。
 * esbuild 远程 import 走 esm.sh HTTP plugin（自写 onResolve / onLoad）+ LRU cache。
 *
 * @param {Array<{ content: string, fullTag: string }>} babelScripts
 * @param {object | null} importmap importmap 的 imports 字段是 bare specifier → URL 的映射
 * @returns {Promise<string>} bundled ESM JS（已 minify）
 */
export async function bundleBabelScripts(babelScripts, importmap) {
  if (babelScripts.length === 0) return '';

  // 拼 entry：多 babel script 内容直接 concat（每段独立 IIFE-style 代码，能共存）
  const entryContent = babelScripts.map(s => s.content).join('\n\n;\n\n');

  const importmapImports = importmap?.imports || {};

  const result = await build({
    stdin: {
      contents: entryContent,
      loader: 'tsx',         // 支持 JSX + TS
      sourcefile: '__nd_entry__.tsx',
    },
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
    write: false,            // 不写盘，结果在 outputFiles
    plugins: [esmShHttpPlugin(importmapImports)],
    // tsx loader 默认 jsx: classic（变 React.createElement），我们模板用 import React 就走通
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  });

  if (result.errors.length > 0) {
    throw new Error('esbuild errors: ' + result.errors.map(e => e.text).join('; '));
  }
  return result.outputFiles[0].text;
}

/**
 * esbuild plugin：把 bare specifier（react / recharts / @radix-ui/...）按 importmap 解析到
 * esm.sh URL，HTTP fetch 内容（with LRU cache + redirect 跟随），返给 esbuild bundle。
 *
 * @param {Record<string, string>} importmapImports
 */
function esmShHttpPlugin(importmapImports) {
  return {
    name: 'esm-sh-http',
    setup(buildApi) {
      // 第一层：bare specifier（react / 'react-dom/client' / '@radix-ui/react-dialog'）
      // 走 importmap 查表 → URL
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        // 已经是 https:// 的相对/绝对 URL（来自前一个 fetch 的 import 解析），下面那条 filter 接
        if (/^https?:\/\//.test(args.path)) {
          return { path: args.path, namespace: 'esm-http' };
        }
        // bare specifier → importmap
        if (importmapImports[args.path]) {
          return { path: importmapImports[args.path], namespace: 'esm-http' };
        }
        // bare specifier 带子路径，如 'react-dom/client'：先查 importmap 完全匹配
        // 没有就找 trailing-slash 前缀（importmap 'react/' 风格）
        for (const [k, v] of Object.entries(importmapImports)) {
          if (k.endsWith('/') && args.path.startsWith(k)) {
            const rest = args.path.slice(k.length);
            return { path: v + rest, namespace: 'esm-http' };
          }
        }
        // 不在 importmap 里就让 esbuild 走默认（多半 fail，但留余地）
        return null;
      });

      // 第二层：从 esm-http 命名空间的 module 内部解析相对路径（esm.sh 返的代码会
      // import './chunk-XXX.mjs' 这种 relative）
      buildApi.onResolve({ filter: /.*/, namespace: 'esm-http' }, (args) => {
        // resolve relative URL based on importer
        if (args.path.startsWith('http')) {
          return { path: args.path, namespace: 'esm-http' };
        }
        try {
          const resolved = new URL(args.path, args.importer).toString();
          return { path: resolved, namespace: 'esm-http' };
        } catch {
          return null;
        }
      });

      // 第三层：HTTP fetch
      buildApi.onLoad({ filter: /.*/, namespace: 'esm-http' }, async (args) => {
        const cached = cacheGet(args.path);
        if (cached) {
          return { contents: cached.contents, loader: cached.loader };
        }
        const res = await fetch(args.path, { redirect: 'follow' });
        if (!res.ok) {
          throw new Error(`esm.sh fetch failed: ${res.status} ${args.path}`);
        }
        const finalUrl = res.url;  // 跟随 redirect 后
        const contents = await res.text();
        const ct = res.headers.get('content-type') || '';
        const loader = ct.includes('css') ? 'css' : 'js';
        cacheSet(finalUrl, { contents, loader });
        if (finalUrl !== args.path) cacheSet(args.path, { contents, loader });
        return { contents, loader };
      });
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Step 3 · extractTailwindCss (commit 2 实现)
// ──────────────────────────────────────────────────────────────────

/**
 * 跑 tailwindcss CLI 提取该 HTML 实际用到的 utility class 对应的 CSS。
 *
 * 输入 raw HTML（含 <head>/Tailwind config + <body>/Tailwind class 用法）：
 *   - 写到 tmp html 文件让 tailwindcss --content 扫描
 *   - 跑 CLI on stdin 读 input CSS（@tailwind base/components/utilities），stdout 拿编译后 CSS
 *   - cleanup tmp file
 *
 * @param {string} rawHtml
 * @returns {Promise<string>} minified CSS（含 base reset + agent 用到的所有 utility）
 */
export async function extractTailwindCss(rawHtml) {
  // 写 raw html 到 tmpfile，tailwindcss CLI 扫描它的 class
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-tw-'));
  const htmlPath = path.join(tmpDir, 'src.html');
  const cfgPath = path.join(tmpDir, 'tailwind.config.js');
  const inputCssPath = path.join(tmpDir, 'in.css');

  // minimal tailwind.config —— 不重要的 fontFamily 也加，让 font-display 等不被 purge
  // 注：raw HTML 里的 inline `tailwind.config = {...}` 在运行时设过，这里 build 阶段
  // 我们走 tailwindcss CLI 不再读 inline config。我们给一个 superset config 保证不缺。
  const config = `module.exports = {
  content: ['${htmlPath}'],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
        display: ['Instrument Serif', 'serif'],
      },
    },
  },
  // 不开 corePlugins.preflight=false：保留 Tailwind base reset（tile 默认含 box-sizing 等基础）
};
`;
  const inputCss = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n';

  await Promise.all([
    fs.writeFile(htmlPath, rawHtml, 'utf8'),
    fs.writeFile(cfgPath, config, 'utf8'),
    fs.writeFile(inputCssPath, inputCss, 'utf8'),
  ]);

  try {
    const { stdout } = await execFileAsync(TAILWIND_BIN, [
      '-c', cfgPath,
      '-i', inputCssPath,
      '--minify',
    ], {
      maxBuffer: 10 * 1024 * 1024,  // CSS 最大 10MB（远超实际 ~50KB）
    });
    return stdout;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}

// ──────────────────────────────────────────────────────────────────
// Step 4-7 · assembleStandaloneHtml
// ──────────────────────────────────────────────────────────────────

/**
 * 重写 HTML：删 CDN script tag / 替换 babel scripts / 注入 inline CSS
 *
 * @param {{
 *   rawHtml: string,
 *   parsed: ReturnType<typeof parseHybridDoc>,
 *   bundledJs: string,
 *   tailwindCss: string
 * }} args
 * @returns {string} 自包含 HTML
 */
export function assembleStandaloneHtml({ rawHtml, parsed, bundledJs, tailwindCss }) {
  let html = rawHtml;

  // ⚠️ 关键：用 split+join 而不是 string.replace，因为 minified JS bundle 里
  // 有大量 `$&` `$'` `$1` 等字面字符串，String.replace 的 replacement 字符串会
  // 把它们当作 backreference（substitute matched/captured groups），导致 1MB
  // bundle 替换后产物炸到 7 倍大小。split+join 是字面替换，无 $ 解读。
  const literalReplace = (str, search, replacement) =>
    str.split(search).join(replacement);

  // 4a. 删 importmap（已 esbuild bundled）
  if (parsed.importmapTagFull) {
    html = literalReplace(html, parsed.importmapTagFull, '<!-- importmap inlined by build-standalone -->');
  }

  // 4b. 删 Babel standalone CDN（已预编译）
  if (parsed.babelCdnTag) {
    html = literalReplace(html, parsed.babelCdnTag, '<!-- @babel/standalone removed (precompiled by esbuild) -->');
  }

  // 4c. 替换 Tailwind CDN script tag → 后续 inline <style>
  if (parsed.tailwindCdnTag) {
    html = literalReplace(html, parsed.tailwindCdnTag, '<!-- Tailwind Play CDN replaced by extracted inline CSS -->');
  }

  // 4d. 移除 tailwind.config 运行时 inline config（已在 extract 阶段消费）
  if (parsed.tailwindConfigTag) {
    html = literalReplace(html, parsed.tailwindConfigTag, '<!-- tailwind.config consumed at build time -->');
  }

  // 4e. 替换所有 babel scripts 为单个 type=module bundle（必须 literal——bundledJs 含 $）
  for (let i = 0; i < parsed.babelScripts.length; i++) {
    const tag = parsed.babelScripts[i].fullTag;
    const replacement = i === 0
      ? `<script type="module">\n/* bundled by esbuild from ${parsed.babelScripts.length} babel script(s) */\n${bundledJs}\n</script>`
      : '<!-- babel script bundled into the first module -->';
    html = literalReplace(html, tag, replacement);
  }

  // 5. inline Tailwind CSS 到 <head>（CSS 也可能含 $，用 literal）
  const tailwindStyleTag = `<style id="__nd-tailwind-extracted">\n${tailwindCss}\n</style>`;
  if (html.includes('</head>')) {
    html = literalReplace(html, '</head>', tailwindStyleTag + '\n</head>');
  } else {
    html = tailwindStyleTag + '\n' + html;
  }

  return html;
}
