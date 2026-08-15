/**
 * chat-log.js —— 演出的对话记录与摘要落盘。
 *
 * 对话记录（默认 `对话.jsonl`，可在 编排.yaml 的 历史.文件 改）：
 *   一行一条 { seq, role: 'user'|'assistant', text, at }。
 *   ⭐ 只存双方真实发言，永远只追加、永远不删——摘要折叠掉的轮次仍然留在
 *   文件里（编译时靠 摘要.json 的 `至` 跳过），全量记录随时可重放、可导出。
 *
 * 摘要（固定名 `摘要.json`，派生态不给改名旋钮）：
 *   { 至, 内容, 时, 模型, 用量, 花费 } —— `至` 是被折叠的最后一条记录的 seq，
 *   滚动覆盖写（旧摘要在生成新摘要时被并入，不单独存档）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export const SUMMARY_FILE = '摘要.json';

function logPath(dir, config) {
  const rel = config?.历史?.文件 || '对话.jsonl';
  const abs = path.resolve(dir, rel);
  if (abs !== path.resolve(dir) && !abs.startsWith(path.resolve(dir) + path.sep)) {
    throw Object.assign(new Error(`历史.文件「${rel}」跑出了演出文件夹`), { code: 'ORCH_INVALID' });
  }
  return abs;
}

/** 读全量记录。文件不存在 = 空场；坏行跳过不炸（记录是追加型文件，尾行可能残缺）。 */
export async function readLog(dir, config) {
  let raw;
  try { raw = await fs.readFile(logPath(dir, config), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (Number.isInteger(r.seq) && (r.role === 'user' || r.role === 'assistant') && typeof r.text === 'string') {
        out.push(r);
      }
    } catch { /* 残行跳过 */ }
  }
  return out;
}

/**
 * 追加一轮（user + assistant 成对写入，调用成功之后才落盘——失败的调用
 * 不留半条记录，重试不会双写）。
 */
export async function appendTurn(dir, config, userText, assistantText) {
  const records = await readLog(dir, config);
  const last = records.length ? records[records.length - 1].seq : 0;
  const at = new Date().toISOString();
  const lines = [
    { seq: last + 1, role: 'user', text: String(userText), at },
    { seq: last + 2, role: 'assistant', text: String(assistantText), at },
  ];
  await fs.appendFile(
    logPath(dir, config),
    lines.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  return lines;
}

export async function readSummary(dir) {
  try {
    const s = JSON.parse(await fs.readFile(path.join(dir, SUMMARY_FILE), 'utf8'));
    return (s && Number.isInteger(s.至) && typeof s.内容 === 'string') ? s : null;
  } catch { return null; }
}

/** 原子写（tmp + rename）：摘要生成要花一次真调用，别让并发读读到半个文件。 */
export async function writeSummary(dir, summary) {
  const target = path.join(dir, SUMMARY_FILE);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(summary, null, 2), 'utf8');
  await fs.rename(tmp, target);
}
