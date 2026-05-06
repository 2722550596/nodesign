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
// Step 2 · bundleBabelScripts (commit 2 实现)
// ──────────────────────────────────────────────────────────────────

/**
 * 把所有 babel script 内容当 entry 喂给 esbuild bundle，配 esm.sh HTTP plugin 把
 * 远程 import 嵌入产物。
 *
 * @param {Array<{ content: string, fullTag: string }>} babelScripts
 * @param {object | null} importmap
 * @returns {Promise<string>} bundled ESM JS（已 minify）
 *
 * commit 2 填实现
 */
export async function bundleBabelScripts(babelScripts, importmap) {
  if (babelScripts.length === 0) return '';

  // TODO commit 2:
  // - 把 babelScripts.map(s => s.content) 拼成一个 entry 字符串
  // - esbuild build({
  //     stdin: { contents: entry, loader: 'tsx' },
  //     bundle: true, format: 'esm', minify: true, target: 'es2020',
  //     plugins: [esmShHttpPlugin(importmap, lruCache)]
  //   })
  // - 返回 outputFiles[0].text

  throw new Error('bundleBabelScripts not yet implemented (commit 2)');
}

// ──────────────────────────────────────────────────────────────────
// Step 3 · extractTailwindCss (commit 2 实现)
// ──────────────────────────────────────────────────────────────────

/**
 * 跑 tailwindcss CLI 提取该 HTML 实际用到的 utility class 对应的 CSS。
 *
 * @param {string} rawHtml
 * @returns {Promise<string>} minified CSS
 *
 * commit 2 填实现
 */
export async function extractTailwindCss(rawHtml) {
  // TODO commit 2:
  // - 写 raw html 到 tmpfile
  // - 写 tailwind.config.js 到 tmpfile（minimal config, 同 template 里的 inline config）
  // - 跑 execFile(TAILWIND_BIN, ['--content', htmlPath, '--config', cfgPath, '--minify'])
  // - 读 stdout 返回
  // - cleanup tmpfiles

  throw new Error('extractTailwindCss not yet implemented (commit 2)');
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

  // 4a. 删 importmap（已 esbuild bundled）
  if (parsed.importmapTagFull) {
    html = html.replace(parsed.importmapTagFull, '<!-- importmap inlined by build-standalone -->');
  }

  // 4b. 删 Babel standalone CDN（已预编译）
  if (parsed.babelCdnTag) {
    html = html.replace(parsed.babelCdnTag, '<!-- @babel/standalone removed (precompiled by esbuild) -->');
  }

  // 4c. 替换 Tailwind CDN script tag → 后续 inline <style>
  if (parsed.tailwindCdnTag) {
    html = html.replace(parsed.tailwindCdnTag, '<!-- Tailwind Play CDN replaced by extracted inline CSS -->');
  }

  // 4d. 移除 tailwind.config 运行时 inline config（已在 extract 阶段消费）
  if (parsed.tailwindConfigTag) {
    html = html.replace(parsed.tailwindConfigTag, '<!-- tailwind.config consumed at build time -->');
  }

  // 4e. 替换所有 babel scripts 为单个 type=module bundle
  for (let i = 0; i < parsed.babelScripts.length; i++) {
    const tag = parsed.babelScripts[i].fullTag;
    const replacement = i === 0
      ? `<script type="module">\n/* bundled by esbuild from ${parsed.babelScripts.length} babel script(s) */\n${bundledJs}\n</script>`
      : '<!-- babel script bundled into the first module -->';
    html = html.replace(tag, replacement);
  }

  // 5. inline Tailwind CSS 到 <head>
  const tailwindStyleTag = `<style id="__nd-tailwind-extracted">\n${tailwindCss}\n</style>`;
  if (html.includes('</head>')) {
    html = html.replace('</head>', tailwindStyleTag + '\n</head>');
  } else {
    html = tailwindStyleTag + '\n' + html;
  }

  return html;
}
