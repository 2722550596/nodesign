/**
 * rewrite-refs.js —— 搬文件后把全工作区的引用改写到新路径（2026-08-24，iss_mt38uih6）
 *
 * 用户的方法论原话：「新建一个文件夹然后改个索引」。organize_board 归纳素材时
 * 磁盘和画布身份跟着走了，但 HTML/MD 里的 src/href 还指旧路径 —— 裂图。这里把
 * "改索引"那半补上：对每个文本文件，把指向被搬条目的引用按**相对该文件目录**
 * 的写法换算后替换。
 *
 * 设计取舍：
 *   - 引用是相对路径（站点路径铁律），所以同一个目标在不同文件里的写法不同
 *     （根上的 deck 写 `assets/x.png`，子页写 `../assets/x.png`）——逐文件换算。
 *   - 被搬的文件**自己**也可能引用别人：它落了新家后自己的相对引用基准变了，
 *     按"旧目录里的写法 → 新目录里的写法"改（哪怕目标没动）。
 *   - 边界字符防误伤：只有前后都像"引用上下文"（引号/括号/=/空白/行首尾/`/`
 *     延续）才替换。改了多少处如实报给调用方 —— 自动改写用户内容，必须可核对。
 *   - 搬的是文件夹时按前缀匹配（`素材/x.png` 里的 `素材` 段）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { walkTaskFiles, loadIgnore } from './task-scan.js';

const TEXT_EXTS = /\.(html?|css|md|markdown|js|mjs|json|svg|ya?ml|txt)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const relFrom = (dirRel, targetRel) => path.posix.relative(dirRel || '.', targetRel);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 纯函数：一段文本里把 pairs（[旧工作区相对路径, 新路径]）的引用改写掉。
 * @param {string} text
 * @param {string} oldDirRel  这段文本**写下时**所在目录（工作区相对，'' = 根）
 * @param {string} newDirRel  这段文本现在所在目录（自己没被搬则与 oldDirRel 相同）
 * @param {Array<[string,string]>} pairs
 * @returns {{ text: string, hits: number }}
 */
export function rewriteTextRefs(text, oldDirRel, newDirRel, pairs) {
  let out = text; let hits = 0;
  const variants = [];
  for (const [oldRel, newRel] of pairs) {
    const oldRef = relFrom(oldDirRel, oldRel);
    const newRef = relFrom(newDirRel, newRel);
    if (!oldRef || oldRef === newRef) continue;
    variants.push([oldRef, newRef]);
    const encOld = encodeURI(oldRef); const encNew = encodeURI(newRef);
    if (encOld !== oldRef) variants.push([encOld, encNew]);
  }
  // 长的先替：`素材` 与 `素材/子` 并存时避免前缀误吞
  variants.sort((a, b) => b[0].length - a[0].length);
  for (const [o, n] of variants) {
    const re = new RegExp(`(^|["'\\(=,\\s])${escRe(o)}(?=["'\\)\\s#?,]|/|$)`, 'gm');
    out = out.replace(re, (m, p1) => { hits += 1; return `${p1}${n}`; });
  }
  return { text: out, hits };
}

/**
 * 自己被搬过的文本文件：**所有**相对引用的基准都变了（不只指向被搬条目的）。
 * 把每个像相对路径的 token 按旧目录解析、按新目录重写；目标自己也搬了就再查
 * moves 表。只认引号/括号里带扩展名的 token，http/data//#/绝对路径不碰。
 */
export function rebaseSelfRefs(text, oldDirRel, newDirRel, movesMap) {
  let hits = 0;
  const out = text.replace(
    /(["'(=])((?:\.\.\/|\.\/)?[^"'\s()#?]*\.[A-Za-z0-9]{1,8})(?=["')\s#?]|$)/gm,
    (m, pre, ref) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref)) return m;
      const target = path.posix.normalize(path.posix.join(oldDirRel || '.', decodeURI(ref)));
      if (target.startsWith('..')) return m;   // 出工作区的不碰
      const finalTarget = movesMap.get(target) || target;
      const next = relFrom(newDirRel, finalTarget);
      if (next === ref) return m;
      hits += 1;
      return `${pre}${next}`;
    },
  );
  return { text: out, hits };
}

/**
 * 扫全工作区文本文件，改写指向 pairs 的引用。
 * @param {string} root   工作区根（绝对路径）
 * @param {Array<{from: string, to: string}>} moves  已完成的搬家（工作区相对）
 * @returns {Promise<{files: number, hits: number, lines: string[]}>}
 */
export async function rewriteWorkspaceRefs(root, moves) {
  const pairs = moves.map((m) => [m.from, m.to]);
  const movesMap = new Map(pairs);
  const movedTo = new Map(moves.map((m) => [m.to, m.from]));
  const ignore = await loadIgnore(root);
  const all = await walkTaskFiles(root, { maxDepth: 6, ignore, includeDrafts: true });
  let files = 0; let hits = 0; const lines = [];
  for (const f of all) {
    if (!TEXT_EXTS.test(f.name) || f.size > MAX_BYTES) continue;
    const newDir = path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel);
    const selfOld = movedTo.get(f.rel);
    let raw;
    try { raw = await fs.readFile(f.abs, 'utf8'); } catch { continue; }
    // 自己被搬过 → 整体换基准（含指向没搬目标的引用）；没搬 → 只改指向被搬条目的
    const r = selfOld
      ? rebaseSelfRefs(raw, path.posix.dirname(selfOld) === '.' ? '' : path.posix.dirname(selfOld), newDir, movesMap)
      : rewriteTextRefs(raw, newDir, newDir, pairs);
    if (r.hits > 0 && r.text !== raw) {
      try { await fs.writeFile(f.abs, r.text, 'utf8'); } catch { continue; }
      files += 1; hits += r.hits;
      lines.push(`  ↻ ${f.rel}：${r.hits} 处`);
    }
  }
  return { files, hits, lines };
}
