/**
 * hook 依赖顺序体检（TDZ 白屏专用）——`node web/src/components/canvas/_hook-order-check.mjs`
 *
 * ## 为什么要有这个
 *
 * BoardCanvas.jsx 因为同一件事白屏过**四次**（绑定表 memo / splitStageCards /
 * handlePresenceEvent / zoneGestureProps）。病理每次都一样：
 *
 *     const a = useMemo(() => …, [b]);   // ← b 在这一行被求值
 *     const b = …;                        // ← 但它在下面才声明 → TDZ
 *
 * hook 的依赖数组是**渲染时求值**的，写在被依赖的东西之前就是
 * `Cannot access 'b' before initialization`，整个组件白屏。
 *
 * **build 过、单测全过，只有真跑看得见** —— 这正是它能连栽四次的原因：
 * 编译期不查跨语句的时序，而单测不渲染这个组件。仓库里没有 eslint
 * （no-use-before-define 本来能拦），所以自己钉一条。
 *
 * ## 判据（故意保守）
 *
 * 只看**组件体那一层**（缩进两格）的 `const` / `let` 声明和 hook 依赖数组：
 * 依赖里出现的标识符，如果它的声明行在依赖数组之后 → 报错。
 *
 * 嵌套作用域、解构、条件声明一律不追 —— 宁可漏报也不误报，一个会喊狼来了的
 * 检查等于没有检查。四次事故全部落在这条最朴素的判据里。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['BoardCanvas.jsx', 'StageLayer.jsx', 'CanvasFrame.jsx', 'useBoardCamera.js', 'useCanvasTools.js'];

/** 组件体那一层的 `const x` / `let x` / `const { a, b } =` → { 名字: 行号 } */
function declLines(lines) {
  const out = new Map();
  lines.forEach((line, i) => {
    const m = /^ {2}(?:const|let)\s+(?:\{([^}]*)\}|\[([^\]]*)\]|([A-Za-z_$][\w$]*))/.exec(line);
    if (!m) return;
    const names = m[3]
      ? [m[3]]
      : (m[1] || m[2] || '').split(',').map(s => s.split(':').pop().replace(/=.*/, '').trim());
    for (const n of names) {
      if (n && /^[A-Za-z_$][\w$]*$/.test(n) && !out.has(n)) out.set(n, i + 1);
    }
  });
  return out;
}

/** 组件体那一层的 hook 依赖数组 `}, [a, b]);` → { 行号, 依赖名[] } */
function depArrays(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const m = /^ {2}\}, \[([^\]]*)\]\);/.exec(line);
    if (!m) return;
    const deps = m[1].split(',')
      .map(s => s.trim().split(/[.?[]/)[0])
      .filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
    if (deps.length) out.push({ line: i + 1, deps });
  });
  return out;
}

let failed = 0;
let checked = 0;
for (const file of FILES) {
  const abs = path.join(here, file);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const decls = declLines(lines);
  for (const { line, deps } of depArrays(lines)) {
    for (const d of deps) {
      checked += 1;
      const at = decls.get(d);
      if (at != null && at > line) {
        failed += 1;
        console.error(`✗ ${file}:${line} 依赖 \`${d}\`，而它在 ${file}:${at} 才声明 —— 渲染时 TDZ，整页白屏`);
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} 处 hook 依赖用在了声明之前。`);
  process.exit(1);
}
console.log(`PASS hook 依赖顺序：${checked} 条依赖全部声明在前（${FILES.length} 个文件）`);
