/**
 * move-entry.js —— 「把一个东西搬到另一个文件夹」的唯一实现（2026-08-14 抽出）。
 *
 * 之前它整个住在 `POST /:pid/move` 的路由体里。agent 的整理工具
 * （organize_board）要同一套语义 —— 按单一真相源纪律抽成一份，两个调用方
 * （用户拖拽 / agent 归纳）共用，别长出第二套"怎么算搬得动"。
 *
 * 语义（见原路由注释，搬运时一字未改）：
 *   ① fs.rename 先动磁盘，失败画布一个字节不改
 *   ② renameBoardPaths 同一步改画布身份（物件/文件夹/归属/关系线端点）+ 转发表
 *   ③ 调用方拿到新 board（前端要用它重写 layoutRef）
 *   ④ commit 交给调用方（路由在响应后 commit；agent 工具每轮本来就落 commit）
 *
 * 失败用 MoveError 抛（带 status），路由映射成 http 状态码，工具映射成文案。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getSharedDir } from './workspace.js';
import { renameBoardPaths } from './board-store.js';
import { taskManifest, KIND_SITE } from '../lib/artifact-target.js';
import { RESERVED_DIRS } from '../lib/task-scan.js';

export class MoveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * 哪些东西不许搬走：真·基础设施 + notes/（便签搬出去=形态退化不是位置变化）。
 * `assets/` 2026-08-13 起放开 —— 把生成图归进文件夹是再正常不过的动作。
 */
const NO_MOVE_OUT = new Set(['exports', 'node_modules', 'agent-memory', 'notes']);

/**
 * @param {string} pid
 * @param {string} fromRaw  工作区相对路径（文件或文件夹）
 * @param {string} toRaw    目标文件夹（'' = 工作区根）
 * @param {object} [opts]   { createFolder: 目标夹不存在就 mkdir（agent 归纳常配新夹）}
 * @returns {Promise<{ok:true, from:string, to:string, moved:boolean, board?:object}>}
 */
export async function moveEntry(pid, fromRaw, toRaw, { createFolder = false } = {}) {
  const root = getSharedDir(pid);
  const from = norm(fromRaw);
  const to = norm(toRaw);
  if (!from) throw new MoveError(400, 'from required');

  const absFrom = path.resolve(root, from);
  const absToDir = to ? path.resolve(root, to) : root;
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  if (!inside(absFrom) || absFrom === root || !inside(absToDir)) {
    throw new MoveError(400, 'path escapes workspace');
  }
  const guardSeg = (rel) => rel.split('/')[0];
  if (NO_MOVE_OUT.has(guardSeg(from)) || guardSeg(from).startsWith('.')) {
    throw new MoveError(400, '这个位置的东西不参与搬家');
  }
  if (to && (RESERVED_DIRS.has(guardSeg(to)) || guardSeg(to).startsWith('.'))) {
    throw new MoveError(400, '不能搬进这个目录');
  }
  // 搬进自己肚子里（文件夹拖到它自己的子文件夹上）—— fs.rename 会报
  // EINVAL，但那时目录树已经没法自洽了，提前拦住
  if (to === from || to.startsWith(from + '/')) {
    throw new MoveError(400, '不能把文件夹搬进它自己里面');
  }

  const srcStat = await fs.stat(absFrom).catch(() => null);
  if (!srcStat) throw new MoveError(404, 'source not found');
  let dirStat = await fs.stat(absToDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    if (!createFolder || !to) throw new MoveError(404, 'target folder not found');
    await fs.mkdir(absToDir, { recursive: true });
    dirStat = await fs.stat(absToDir);
  }

  // 目标目录**本身是一件产物**（整站 / 世界）时不许搬进去：它的内部结构由
  // 形态解析器管，塞进去的东西会从产物枚举里彻底消失（既不是页面也不是卡）。
  // 站点收素材的正路是它的 assets/ 子目录（那一层不是产物根，照常放行）。
  if (to) {
    const m = await taskManifest(absToDir);
    const opaque = (m?.artifacts || []).some(
      a => a.kind === 'world' || (a.kind === KIND_SITE && !a.single && !a.root));
    if (opaque) throw new MoveError(400, '这是一件产物，不是收纳文件夹（站点收素材放它的 assets/ 子目录）');
  }

  const base = path.basename(from);
  const nextRel = to ? `${to}/${base}` : base;
  if (nextRel === from) return { ok: true, from, to: from, moved: false };
  if (await exists(path.resolve(root, nextRel))) {
    throw new MoveError(409, `「${base}」在那儿已经有一个了`);
  }

  await fs.rename(absFrom, path.resolve(root, nextRel));                    // ①
  const { board } = await renameBoardPaths(pid, [[from, nextRel]]);         // ②
  return { ok: true, from, to: nextRel, moved: true, board };               // ③
}
