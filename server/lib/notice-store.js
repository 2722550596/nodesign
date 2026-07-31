/**
 * server/lib/notice-store.js — 站内公告（2026-07-31）
 *
 * 起因很具体：内测有人在用的时候要重启，但没有任何办法告诉他们。用户视角是
 * 「我发的消息突然没了」，运维视角是「等到没人再动手」，两边都在猜。
 *
 * 形态刻意做小：一次只有一条生效的公告（取最新未过期的那条），不做多条队列
 * 也不做分人群投放 —— 内测阶段要说的话就那么几句（要重启了 / 回来了 / 出了什么
 * 事），排队和定向都是给不存在的问题写的代码。
 *
 * 历史保留不删：`active=0` 是软下架，翻记录能看到当时到底跟大家说过什么。
 *
 * 前端的「已读」不在这里 —— 记 localStorage，键带 notice id。服务端记已读要么
 * 加一张按用户的表，要么就是错的（同一个人换浏览器就重看一遍）。公告本来就
 * 允许多看一次，不值得为它建表。
 */

import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/** info = 中性告知（蓝）、warn = 要留意（黄）、alert = 影响使用（红） */
export const LEVELS = ['info', 'warn', 'alert'];

function rowToNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    body: row.body,
    level: row.level,
    active: !!row.active,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  };
}

function newNoticeId() {
  return `nt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * @param {object} p
 * @param {string} p.body            正文（前端整段显示，不解析 markdown）
 * @param {string} [p.level]         info | warn | alert
 * @param {number} [p.expiresInHours] 到点自动消失；不给就一直挂到手动下架
 */
export function createNotice({ body, level = 'info', expiresInHours = null } = {}) {
  const text = String(body || '').trim();
  if (!text) throw new Error('notice body 不能为空');
  if (!LEVELS.includes(level)) throw new Error(`level 只能是 ${LEVELS.join(' / ')}`);
  const hours = Number(expiresInHours);
  const expiresAt = Number.isFinite(hours) && hours > 0
    ? new Date(Date.now() + hours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  const id = newNoticeId();
  db.prepare('INSERT INTO notices (id, body, level, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, text.slice(0, 500), level, expiresAt);
  return getNotice(id);
}

export function getNotice(id) {
  return rowToNotice(db.prepare('SELECT * FROM notices WHERE id = ?').get(id));
}

/**
 * 当前该给用户看的那一条：最新的、active、未过期。没有就 null。
 *
 * `rowid DESC` 不是装饰：created_at 是 datetime('now')，只到秒。发完一条马上改词
 * 再发一条（正是「写错了重发」的常见操作）会撞同一秒，只按 created_at 排的话
 * 谁在前是不确定的，用户可能看到被你替换掉的那一版。rowid 单调递增，能定序。
 */
export function getActiveNotice() {
  return rowToNotice(db.prepare(`
    SELECT * FROM notices
    WHERE active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get());
}

export function listNotices(limit = 50) {
  return db.prepare('SELECT * FROM notices ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(Math.min(200, limit)).map(rowToNotice);
}

/** 软下架：留着记录，只是不再投放 */
export function retireNotice(id) {
  const r = db.prepare('UPDATE notices SET active = 0 WHERE id = ?').run(id);
  return r.changes > 0;
}

/** 全部下架（"说完了，清屏"）@returns 下架条数 */
export function retireAllNotices() {
  return db.prepare('UPDATE notices SET active = 0 WHERE active = 1').run().changes;
}
