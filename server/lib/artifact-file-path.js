/**
 * server/lib/artifact-file-path.js — artifact-file 的路径判据（2026-08-18 抽出）
 *
 * 抽出来的直接原因是行数棘轮，但抽对了：这几行是**安全判据**，而且它有一条已知的
 * 错（见下面 `tasks/` 那段），judge 类的东西住在路由里没法单测。
 *
 * 可服务根 = 整个项目工作区（产物就住在这儿），但挡掉基础设施：`.claude/`（含
 * settings.json 和整份 SDK 转录）、`.nd/`（会话私档）、`.git/`。扁平化之前这三样
 * 都在可服务根之外、是目录结构在替我们把门；现在它们跟产物同级，必须显式拦 ——
 * 否则 `artifact-file/.claude/settings.json` 是一个能公开读到配置的 URL。
 *
 * 点开头**一刀切拒是错的**：缩略图住在 `assets/generated/.thumbnails/`，一刀切下去
 * 产物墙上所有缩略图全 403。所以按名字白名单（不是黑名单 —— 将来冒出个 `.env`
 * 不该因为没人想到就漏出去）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

const DOT_OK = new Set(['.thumbnails', '.meta']);

/**
 * 这个绝对路径可不可以服出去：不越界、且路径里没有非白名单的点目录。
 *
 * 导出它是因为**改名转发**那条路要用同一个判据（`api/assets.js` 里原来自己又抄了
 * 一遍 DOT_OK 和越界检查）。判据抄第二遍就是等着哪天改一处漏一处 ——
 * 收成一份，两边都 import。
 */
export function isServablePath(sharedRoot, absPath) {
  if (absPath !== sharedRoot && !absPath.startsWith(sharedRoot + path.sep)) return false;
  const rel = path.relative(sharedRoot, absPath).split(path.sep);
  return !rel.some(seg => seg.startsWith('.') && !DOT_OK.has(seg));
}

/**
 * @param {string} sharedRootRaw 项目工作区根
 * @param {string} rawSub 路由里的 *subPath（可能是数组段拼起来的）
 * @returns {Promise<{ok:true, sharedRoot:string, absPath:string, subPath:string}
 *   | {ok:false, status:number, error:string}>}
 */
export async function resolveArtifactFile(sharedRootRaw, rawSub) {
  let subPath = Array.isArray(rawSub) ? rawSub.join('/') : (rawSub || '');
  if (!subPath) return { ok: false, status: 400, error: 'file path required' };

  const sharedRoot = path.resolve(sharedRootRaw);

  // 兼容旧形态：`tasks/<任务>/x` 是扁平化之前的路径，浏览器缓存里、旧 board.json 里、
  // 用户收藏的链接里都还有。剥掉前两段就是现在的位置。
  // ⚠️ **但不能无条件剥**（2026-08-18 审查抓到）：扁平化之后 agent 完全可以在工作区里
  // 真建一个叫 `tasks/` 的目录（它就是个普通名字），那时候剥掉前两段会把**磁盘上真实
  // 存在的文件**变成 404。所以先看原路径在不在，在就别动它。
  const asIs = path.resolve(sharedRoot, subPath);
  const insideAsIs = asIs === sharedRoot || asIs.startsWith(sharedRoot + path.sep);
  if (/^tasks\/[^/]+\//.test(subPath)) {
    let existsAsIs = false;
    if (insideAsIs) {
      try { await fs.stat(asIs); existsAsIs = true; } catch { /* 不在 */ }
    }
    if (!existsAsIs) subPath = subPath.replace(/^tasks\/[^/]+\//, '');
  }

  const absPath = path.resolve(sharedRoot, subPath);
  if (absPath !== sharedRoot && !absPath.startsWith(sharedRoot + path.sep)) {
    return { ok: false, status: 403, error: 'path escapes workspace' };
  }
  if (!isServablePath(sharedRoot, absPath)) {
    return { ok: false, status: 403, error: 'not a servable path' };
  }
  return { ok: true, sharedRoot, absPath, subPath };
}
