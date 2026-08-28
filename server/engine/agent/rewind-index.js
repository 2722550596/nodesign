/**
 * server/engine/agent/rewind-index.js — rewind 文件侧索引（M3c C2）
 *
 * .nd/<sid>/rewind-index.json —— append-only 索引。
 * 每条 { entryId, headShaBefore }：turn 开始时的 git HEAD + 本轮 user entry 的 pi id。
 * 文件在 .nd/ 内（gitignore），不被 commitWorkspace/revert 触碰。
 *
 * 消费方：
 *  - session-loop.js finishTurn 写入（C3b）：turn 结束 commitWorkspace 后记一条；
 *  - sessions.js rewind 端点查询（C5）：userMessageId → headShaBefore → rewindWorkspace。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 追加一条 { entryId, headShaBefore }。首次写入或文件损坏 → 从空数组重建。 */
export async function appendRewindEntry(metaDir, entry) {
  const indexPath = path.join(metaDir, 'rewind-index.json');
  let entries = [];
  try {
    entries = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch { /* 首次或损坏 → 空数组 */ }
  entries.push(entry);
  await fs.mkdir(metaDir, { recursive: true });   // .nd/<sid> 通常 ensureSessionWorkspace 建；兜底
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2));
}

/** 读全部条目。文件不存在 / 损坏 → []（新会话没跑过 turn 是常态，不是错误）。 */
export async function readRewindIndex(metaDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(metaDir, 'rewind-index.json'), 'utf8'));
  } catch { return []; }
}

/** 按 entryId 查 headShaBefore。找不到 → null */
export async function findRewindTarget(metaDir, entryId) {
  const entries = await readRewindIndex(metaDir);
  const hit = entries.find(e => e.entryId === entryId);
  return hit?.headShaBefore ?? null;
}
