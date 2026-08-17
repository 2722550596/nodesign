/**
 * 未定义标识符扫描（2026-08-17）。
 *
 * ## 为什么要有这条
 *
 * 08-17 从 BoardCanvas 拆出八个模块，`useMarquee.js` 漏带了三样东西
 * （`onChrome` / `sizeOf` / `recentDragMovedRef`）—— 它们原来住在组件作用域里，
 * 搬走之后既没 import 也没进参数。`armMarquee` 第二行就调 `onChrome`，于是
 * **画布上每一次 pointerdown 都抛 ReferenceError**，`camera.onPointerDown`
 * 永远执行不到 = 画布完全没法拖。上了生产才被用户发现。
 *
 * 关键在于：**`vite build` 一声不吭地通过了**。未定义的标识符对打包器来说只是
 * 一次运行时全局查找，它没有理由报错。而画布几乎没有渲染测试，跑测试也照不出来。
 * 「搬代码只验证能不能编译」这件事从此不成立。
 *
 * 所以补这条。跟 loc-ratchet / path-compose 同一个存在方式：这仓库没有 CI，
 * vitest 就是部署链的闸门。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * 浏览器 / Node 里本来就有的全局。缺了会误报，多了会漏报 —— 只列真的存在的，
 * 别拿它当消音器用（漏报比误报贵得多，这条规则就是为漏报补的）。
 */
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'console', 'localStorage', 'sessionStorage', 'fetch', 'Headers', 'Request', 'Response',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'queueMicrotask', 'structuredClone', 'reportError',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData',
  'AbortController', 'AbortSignal', 'EventSource', 'WebSocket', 'MessageChannel',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'PerformanceObserver',
  'Image', 'Audio', 'Option', 'DOMParser', 'XMLHttpRequest', 'CustomEvent', 'Event',
  'Node', 'Element', 'HTMLElement', 'SVGElement', 'CanvasRenderingContext2D', 'Path2D',
  'getComputedStyle', 'matchMedia', 'scrollTo', 'alert', 'confirm', 'prompt', 'open',
  'performance', 'crypto', 'btoa', 'atob', 'process', 'globalThis',
  'Math', 'JSON', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'Proxy', 'Reflect', 'BigInt', 'Intl',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  'TextEncoder', 'TextDecoder', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'undefined', 'NaN', 'Infinity', 'arguments', 'globalThis', 'Function',
  'NodeFilter', 'CSS', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent',
  // Node（server/ 那一半）
  'Buffer', '__dirname', '__filename', 'require', 'module', 'exports',
]);

/**
 * 不扫的目录。
 *
 * ⚠️ `projects-data` 是**用户的生产数据** —— agent 给用户做的站点就落在那儿，
 * 里面的 script.js 引用 CDN 全局（GSAP 的 ScrollTrigger、ECharts…）是**正常的**，
 * 那些名字来自页面上的 <script> 标签，静态扫描永远看不见。拿这把尺子量用户
 * 产物 = 用户每做一个带库的站，我们的 CI 就红一次。这把尺子是量**我们的源码**的。
 */
const SKIP_DIRS = new Set(['node_modules', 'projects-data', 'dist', 'coverage']);

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sourceFiles(p, out); continue; }
    if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 这个文件里所有「引用了但谁也没声明」的名字 */
function undefinedRefs(code, filename) {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'importMeta', 'topLevelAwait'],
    errorRecovery: false,
  });
  const bad = new Map();   // name → 首次出现的行号
  traverse(ast, {
    ReferencedIdentifier(p) {
      const { name } = p.node;
      if (GLOBALS.has(name)) return;
      if (p.scope.hasBinding(name, { noGlobals: true })) return;
      // JSX 里的原生标签（<div>）会走到这儿，但它们首字母小写且是 JSXIdentifier
      if (p.isJSXIdentifier() && /^[a-z]/.test(name)) return;
      if (!bad.has(name)) bad.set(name, p.node.loc?.start.line ?? 0);
    },
  });
  void filename;
  return [...bad.entries()].map(([name, line]) => ({ name, line }));
}

describe('未定义标识符', () => {
  const files = [
    ...sourceFiles(path.join(REPO, 'web/src')),
    ...sourceFiles(path.join(REPO, 'server')),
  ];

  it('每个源文件引用的名字都有来处（import / 声明 / 参数 / 全局）', () => {
    const problems = [];
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      let refs;
      try {
        refs = undefinedRefs(fs.readFileSync(f, 'utf8'), rel);
      } catch (err) {
        problems.push(`${rel}: 解析失败 —— ${err.message}`);
        continue;
      }
      for (const { name, line } of refs) problems.push(`${rel}:${line} 用了 \`${name}\`，但它没有来处`);
    }
    expect(problems, `拆代码最容易漏的就是这个，而 vite build 不会报：\n${problems.join('\n')}`).toEqual([]);
  // 全仓解析一遍，仓库长大它只会更慢（08-17 撞过默认 5s：那次 5.47s，
  // 报出来是"测试超时"而不是"有未定义标识符"，差点被当成真失败去查代码）
  }, 60_000);
});
