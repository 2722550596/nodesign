/**
 * server/lib/quota.js — 每用户日用量限额（2026-07-30 内测）
 *
 * 计量口径：runs 表真列 sum(input_tokens + output_tokens)，按 Asia/Shanghai
 * 日界聚合（created_at 是 SQLite datetime('now') 的 UTC 串，查询时把当天
 * +08:00 的起点换算回 UTC 比较）。cache 命中不计入 —— 订阅模式下真实成本
 * 主要看非缓存 token，且 cache_read 数字巨大会让限额失去直觉意义。
 *
 * 限额来源：users.daily_token_limit 优先，NULL 走 env NODESIGN_USER_DAILY_TOKENS
 * （默认 3,000,000）。admin 不限。
 */

import db, { getRun } from '../engine/runs/store.js';
import { countRunningTurns, listRunningTurnRunIds } from '../engine/runs/active-runs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;   // Asia/Shanghai，内测口径写死

/** 当天（+08:00 日界）的 UTC 起点，格式对齐 SQLite datetime('now') */
export function dayStartUtcSql(now = Date.now()) {
  const startLocal = Math.floor((now + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
  return new Date(startLocal).toISOString().slice(0, 19).replace('T', ' ');
}

export function usedTokensToday(userId, now = Date.now()) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) AS used
     FROM runs WHERE user_id = ? AND created_at >= ?`,
  ).get(userId, dayStartUtcSql(now));
  return row.used;
}

export function defaultDailyLimit() {
  const v = Number(process.env.NODESIGN_USER_DAILY_TOKENS);
  return Number.isFinite(v) && v > 0 ? v : 3_000_000;
}

/** @returns {number|null} null = 不限（admin） */
export function limitFor(user) {
  if (!user || user.role === 'admin') return null;
  return user.dailyTokenLimit ?? defaultDailyLimit();
}

/** @returns {{ ok: boolean, usedToday: number, limit: number|null }} */
export function checkQuota(user, now = Date.now()) {
  const limit = limitFor(user);
  const usedToday = usedTokensToday(user.id, now);
  return { ok: limit === null || usedToday < limit, usedToday, limit };
}

// ── 并发闸门 ──
// 语义是"拒绝返 429"而不是"排队 await"：turn.js 是 202 fire-and-forget，
// 闸门必须在 202 之前同步判。同 session 追加消息走既有排队语义不经这里。

export function checkConcurrency(user) {
  const globalMax = Number(process.env.NODESIGN_MAX_CONCURRENT_RUNS) || 3;
  const running = countRunningTurns();
  if (running >= globalMax) {
    return { ok: false, code: 'BUSY', message: `现在有点挤（${running} 个任务在跑），稍等一会儿再发` };
  }
  if (user?.role !== 'admin') {
    const perUser = Number(process.env.NODESIGN_USER_CONCURRENT_RUNS) || 1;
    // running turn → user 归属：runId 查 runs.user_id（不给 session 注册表加
    // userId 字段 —— 正在跑的 turn 就几个，查表成本可忽略）
    let mine = 0;
    for (const rid of listRunningTurnRunIds()) {
      if (getRun(rid)?.userId === user?.id) mine += 1;
    }
    if (mine >= perUser) {
      return { ok: false, code: 'BUSY', message: '你有任务正在跑，等它完成再开下一个（同一对话里追加消息不受限）' };
    }
  }
  return { ok: true };
}
