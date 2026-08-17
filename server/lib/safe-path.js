/**
 * lib/safe-path.js — 工作区内路径的越界检查。
 *
 * ⚠️ **词法检查不够。** `path.resolve` + `path.relative` 挡得住 `../..`，
 * 挡不住工作区里一个**指向外面的软链** —— 那条路径逐字看都在工作区内，
 * 解引用之后在 `/etc` 或者 `.env` 上。
 *
 * 这个洞在这个仓库里已经出现过两次形状相同的实例（导出收集器、docx 页图路由），
 * 第二次是照着第一次的**调用形状**抄的、没抄它的**正确性**。所以判据收成一份：
 * 谁要在工作区里按用户给的相对路径开文件，就 import 这里，别再各写一遍。
 *
 * 读和写的判据不一样，分两个函数：
 *   - 读：目标必须存在，realpath 之后仍在工作区内
 *   - 写：目标可能还不存在（正要创建），所以查**父目录**的 realpath；
 *     另外目标自己若已经是软链，一律拒 —— 顺着它写等于把别人的文件覆盖掉
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

/** 词法层：拼出绝对路径并确认字面上没跑出去。跑出去返回 null */
function lexical(rootAbs, rel) {
  const abs = path.resolve(rootAbs, String(rel || ''));
  const within = path.relative(rootAbs, abs);
  if (within.startsWith('..') || path.isAbsolute(within)) return null;
  return abs;
}

/**
 * 读用：解析一个工作区内的相对路径。
 * @returns {Promise<string|null>} 绝对路径；越界（含软链穿透）返回 null
 *   目标不存在**不算越界** —— 让调用方自己去 stat 报 404，这里只管边界
 */
export async function safeResolveRead(workspaceRoot, rel) {
  const abs = lexical(path.resolve(workspaceRoot), rel);
  if (!abs) return null;
  try {
    const realRoot = await fs.realpath(workspaceRoot);
    const real = await fs.realpath(abs);
    const rw = path.relative(realRoot, real);
    if (rw.startsWith('..') || path.isAbsolute(rw)) return null;
  } catch (err) {
    // ENOENT：文件还没写出来，边界上没问题，留给调用方 stat
    if (err?.code !== 'ENOENT') return null;
  }
  return abs;
}

/**
 * 写用：解析一个工作区内的写入目标。
 * @returns {Promise<string|null>} 绝对路径；越界 / 目标是软链 返回 null
 */
export async function safeResolveWrite(workspaceRoot, rel) {
  const abs = lexical(path.resolve(workspaceRoot), rel);
  if (!abs) return null;
  try {
    const realRoot = await fs.realpath(workspaceRoot);
    // 目标本身若已存在且是软链 → 拒。顺着它写会覆盖软链指向的那个文件，
    // 而那个文件可以在工作区外（lstat 不解引用，这是判据的关键）
    try {
      if ((await fs.lstat(abs)).isSymbolicLink()) return null;
    } catch (err) {
      if (err?.code !== 'ENOENT') return null;   // 目标还不存在是正常的
    }
    // 父目录必须真的在工作区内（父目录是软链的话，新建的文件会落到外面）
    const realParent = await fs.realpath(path.dirname(abs));
    const rw = path.relative(realRoot, realParent);
    if (rw.startsWith('..') || path.isAbsolute(rw)) return null;
  } catch {
    return null;   // 父目录都解析不了，不给写
  }
  return abs;
}
