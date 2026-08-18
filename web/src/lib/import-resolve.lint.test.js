/**
 * import 路径可解析扫描（2026-08-18）
 *
 * ⛔ 为什么有这份东西：我写 `server/ws/browse-channel.js` 时把
 * `validateProjectId` 的来处猜成了 `../projects/ids.js`（真的住在 `store.js`）。
 * `node --check` **只查语法不查模块能不能解析**，全套 650 条测试也全绿 ——
 * 因为没有一条测试 import 那个新文件。**pm2 restart 之后生产直接起不来**
 * （ERR_MODULE_NOT_FOUND），挂了约一分钟。
 *
 * ⛔ **同一天又栽了一次，在下一层**：路径对了，但**导出名不存在** —— 拆模块时
 * 把函数搬过去忘了加 `export`，`SyntaxError: does not provide an export named …`，
 * 生产第二次起不来。所以这份东西现在查两件事：**路径存不存在** + **具名导入的
 * 名字在目标模块里到底导没导出**。
 *
 * 这是这个仓库「静默失效」病族的又一种形态，跟 no-undef.lint 是一对：
 * 那个查"名字有没有来处"，这个查"来处存不存在、以及它给不给这个名字"。
 *
 * 扫 `server/` 与 `web/src/` 全部 js/jsx 的**相对** import/export-from
 * （裸包名交给 npm 自己管），逐条落到文件系统上确认。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOTS = [path.join(REPO, 'server'), path.join(REPO, 'web/src')];
const SKIP_DIRS = new Set(['node_modules', 'projects-data', 'dist', 'dist-build', '.git', '.cache']);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) yield p;
  }
}

/**
 * 这个文件里全部**相对**的模块说明符。
 *
 * ⚠️ 用 AST 不用正则：第一版拿正则扫，把**写在模板字符串里的测试夹具代码**
 * （`await fs.writeFile(..., \`import * as impl from './mock.js'\`)`）当成了真的
 * import 报上来。字符串和注释里的东西只有解析器分得清。
 */
/** 这个模块导出了哪些名字（含 `export * from` 的转发，转发就当"可能有"放过）*/
function exportedNames(code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'importMeta', 'topLevelAwait'], errorRecovery: true });
  const names = new Set();
  let hasStarReexport = false;
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') { hasStarReexport = true; continue; }
    if (node.type === 'ExportDefaultDeclaration') { names.add('default'); continue; }
    if (node.type !== 'ExportNamedDeclaration') continue;
    for (const sp of node.specifiers || []) names.add(sp.exported?.name ?? sp.exported?.value);
    const d = node.declaration;
    if (!d) continue;
    if (d.id?.name) names.add(d.id.name);                       // function / class
    for (const decl of d.declarations || []) {                    // const / let
      if (decl.id?.name) names.add(decl.id.name);
      for (const pr of decl.id?.properties || []) if (pr.value?.name) names.add(pr.value.name);
    }
  }
  return { names, hasStarReexport };
}

/** 这个文件对相对模块做的**具名**导入：[{ spec, names: [...] }] */
function namedImports(code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'importMeta', 'topLevelAwait'], errorRecovery: true });
  const out = [];
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration') continue;
    const spec = node.source?.value;
    if (typeof spec !== 'string' || !spec.startsWith('.')) continue;
    const names = (node.specifiers || [])
      .filter(sp => sp.type === 'ImportSpecifier' || sp.type === 'ExportSpecifier')
      .map(sp => sp.imported?.name ?? sp.local?.name)
      .filter(Boolean);
    if (names.length) out.push({ spec, names });
  }
  return out;
}

function relativeSpecifiers(code) {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'importMeta', 'topLevelAwait'],
    errorRecovery: true,
  });
  const out = [];
  const take = (node) => {
    const v = node?.source?.value ?? (node?.type === 'ImportExpression' ? node.source?.value : null);
    if (typeof v === 'string' && v.startsWith('.')) out.push(v);
  };
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration'
        || node.type === 'ExportAllDeclaration') take(node);
  }
  // 动态 import 也走 AST（第一版这里留了半条正则，结果把**本文件注释里的示例**
  // 当成真 import 报上来 —— 同一个病犯两次，只有解析器分得清代码和文字）。
  // 只认字面量参数：拼出来的路径本来就查不了。
  traverse(ast, {
    CallExpression(p2) {
      if (p2.node.callee?.type !== 'Import') return;
      const a = p2.node.arguments?.[0];
      if (a?.type === 'StringLiteral' && a.value.startsWith('.')) out.push(a.value);
    },
  });
  return out;
}

describe('import 路径可解析', () => {
  it('server/ 与 web/src/ 里每一条相对 import 都指向真实存在的文件', () => {
    const broken = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = fs.readFileSync(file, 'utf8');
        let specs;
        try { specs = relativeSpecifiers(src); } catch { continue; }   // 解析不了的交给别的闸
        for (const raw of specs) {
          const spec = raw.replace(/\?.*$/, '');    // 去掉 ?fresh= 之类的 query
          const abs = path.resolve(path.dirname(file), spec);
          const candidates = [abs, `${abs}.js`, `${abs}.jsx`,
            path.join(abs, 'index.js'), path.join(abs, 'index.jsx')];
          if (!candidates.some(c => fs.existsSync(c) && fs.statSync(c).isFile())) {
            broken.push(`${path.relative(REPO, file)} → '${spec}'`);
          }
        }
      }
    }
    expect(broken, `这些 import 指向不存在的文件（生产会 ERR_MODULE_NOT_FOUND 起不来）:\n${broken.join('\n')}`)
      .toEqual([]);
  });

  it('⭐ 具名导入的名字在目标模块里真的导出了（路径对不代表名字对）', () => {
    const missing = [];
    const exportCache = new Map();
    const resolve = (fromFile, spec) => {
      const abs = path.resolve(path.dirname(fromFile), spec.replace(/\?.*$/, ''));
      for (const c of [abs, `${abs}.js`, `${abs}.jsx`, path.join(abs, 'index.js'), path.join(abs, 'index.jsx')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      }
      return null;
    };
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        let imports;
        try { imports = namedImports(fs.readFileSync(file, 'utf8')); } catch { continue; }
        for (const { spec, names } of imports) {
          const target = resolve(file, spec);
          if (!target) continue;                     // 路径问题上一条测试管
          if (!exportCache.has(target)) {
            try { exportCache.set(target, exportedNames(fs.readFileSync(target, 'utf8'))); }
            catch { exportCache.set(target, { names: null, hasStarReexport: true }); }
          }
          const { names: has, hasStarReexport } = exportCache.get(target);
          if (!has || hasStarReexport) continue;     // 有 `export *` 转发就放过（查不动）
          for (const n of names) {
            if (!has.has(n)) {
              missing.push(`${path.relative(REPO, file)} 从 '${spec}' 导入 \`${n}\`，但那边没导出它`);
            }
          }
        }
      }
    }
    expect(missing, `这些具名导入的名字目标模块没导出（生产会 SyntaxError 起不来）:\n${missing.join('\n')}`)
      .toEqual([]);
  });
});
