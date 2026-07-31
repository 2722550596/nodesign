/**
 * server/auth/users-store.js — 用户与邀请码（2026-07-30 内测多用户）
 *
 * 复用 engine/runs/store.js 的 better-sqlite3 连接（与 projects/runs 同一个
 * nodesign.db）。建表走仓里的既有范式：import 副作用式幂等 DDL。
 *
 * 密码：node 内置 crypto.scrypt，无新依赖。存储格式
 *   scrypt$<N>$<saltHex>$<hashHex>
 * 参数变更时旧记录仍能按自记录的 N 校验。
 *
 * 邀请码：admin 生成，限次数/可过期；注册时事务内 used_count+1 防并发超发。
 *
 * bootstrapAuth()（index.js 启动时调，幂等）：
 *   - users 空 && NODESIGN_AUTH_PASSWORD 存在 → 用该密码建 admin 账号
 *     （单密码墙 → 多用户的无感迁移：你用老密码 + 用户名 admin 重登即可）
 *   - projects.owner_id 为 NULL 的存量行 → 回填 admin（历史项目全归你）
 */

import crypto from 'node:crypto';
import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    daily_token_limit INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_by TEXT,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 老 DB 补列（幂等，同 projects/store.js 范式）：07-31 限额口径从 token 换成
// 金额，per-user 覆盖也跟着换单位。daily_token_limit 保留不删 —— 它是老口径的
// 存量数据，删了就没法回溯当时给谁开过什么口子。
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
if (!userCols.has('daily_cost_limit_usd')) {
  db.exec('ALTER TABLE users ADD COLUMN daily_cost_limit_usd REAL');
  console.log('[users-store] users.daily_cost_limit_usd column added');
}

// ── 密码 ──

const SCRYPT_N = 16384;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N, r: 8, p: 1 }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored || '');
  if (!m) return false;
  const [, nStr, salt, hashHex] = m;
  try {
    const calc = crypto.scryptSync(String(password), salt, hashHex.length / 2, { N: Number(nStr), r: 8, p: 1 });
    return crypto.timingSafeEqual(calc, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

// ── 用户 ──

const USERNAME_RE = /^[A-Za-z0-9_一-鿿-]{2,32}$/;

export function validUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

function newUserId() {
  return `u_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    dailyCostLimitUsd: row.daily_cost_limit_usd ?? null,
    dailyTokenLimit: row.daily_token_limit ?? null,   // 老口径存量，只读不用
    disabled: !!row.disabled,
    inviteCode: row.invite_code || null,
    createdAt: row.created_at,
  };
}

// requestUser 每个请求都要查 —— 60s 内存缓存压掉热路径的 SQLite 读。
// disable 用户最迟 60s 生效，内测语境可接受。
const userCache = new Map();   // id → { user, at }
const USER_CACHE_MS = 60_000;

export function getUserById(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
  const user = rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  userCache.set(id, { user, at: Date.now() });
  return user;
}

export function getUserByUsername(username) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

/** 登录用：要拿 hash 比对，不走 rowToUser（hash 不出模块） */
export function getCredential(username) {
  const row = db.prepare('SELECT id, password_hash, disabled FROM users WHERE username = ?').get(username);
  return row ? { id: row.id, passwordHash: row.password_hash, disabled: !!row.disabled } : null;
}

export function createUser({ username, password, role = 'user', inviteCode = null }) {
  const user = {
    id: newUserId(),
    username,
    role,
    inviteCode,
  };
  db.prepare(`INSERT INTO users (id, username, password_hash, role, invite_code) VALUES (?, ?, ?, ?, ?)`)
    .run(user.id, username, hashPassword(password), role, inviteCode);
  return getUserById(user.id);
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(rowToUser);
}

export function updateUser(id, { disabled, dailyTokenLimit, dailyCostLimitUsd, role } = {}) {
  const sets = [];
  const args = [];
  if (disabled !== undefined) { sets.push('disabled = ?'); args.push(disabled ? 1 : 0); }
  if (dailyCostLimitUsd !== undefined) { sets.push('daily_cost_limit_usd = ?'); args.push(dailyCostLimitUsd ?? null); }
  if (dailyTokenLimit !== undefined) { sets.push('daily_token_limit = ?'); args.push(dailyTokenLimit ?? null); }
  if (role !== undefined) { sets.push('role = ?'); args.push(role); }
  if (!sets.length) return getUserById(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  userCache.delete(id);
  return getUserById(id);
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// ── 邀请码 ──

export function createInvite({ createdBy = null, maxUses = 1, expiresAt = null } = {}) {
  // 可读形态：nd-xxxxxxxx（发群里手输不痛苦；去掉易混字符）
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = 'nd-';
  for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
  db.prepare('INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, createdBy, maxUses, expiresAt);
  return getInvite(code);
}

export function getInvite(code) {
  return db.prepare('SELECT * FROM invites WHERE code = ?').get(code) || null;
}

export function listInvites() {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all();
}

/**
 * 注册主流程：校验邀请码 + 建用户，单事务（used_count+1 与 INSERT 原子，
 * 两人同抢最后一个名额只有一个成）。失败抛带 .code 的 Error。
 */
export const registerUser = db.transaction(({ username, password, inviteCode }) => {
  if (!validUsername(username)) {
    throw Object.assign(new Error('用户名 2-32 位，仅限字母数字下划线连字符和中文'), { code: 'BAD_USERNAME' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { code: 'BAD_PASSWORD' });
  }
  if (getUserByUsername(username)) {
    throw Object.assign(new Error('用户名已被使用'), { code: 'USERNAME_TAKEN' });
  }
  const inv = getInvite(String(inviteCode || ''));
  if (!inv) throw Object.assign(new Error('邀请码无效'), { code: 'BAD_INVITE' });
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('邀请码已过期'), { code: 'INVITE_EXPIRED' });
  }
  if (inv.used_count >= inv.max_uses) {
    throw Object.assign(new Error('邀请码已用完'), { code: 'INVITE_EXHAUSTED' });
  }
  db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(inv.code);
  return createUser({ username, password, role: 'user', inviteCode: inv.code });
});

// ── 启动 bootstrap（index.js 调，幂等）──

export function bootstrapAuth() {
  let admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC").get();
  if (!admin && countUsers() === 0) {
    const pw = process.env.NODESIGN_AUTH_PASSWORD || '';
    if (pw) {
      const created = createUser({ username: 'admin', password: pw, role: 'admin' });
      admin = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
      console.log('[auth] bootstrap: 用 NODESIGN_AUTH_PASSWORD 创建了 admin 账号（用户名 admin）');
    } else {
      console.warn('[auth] users 表为空且未配置 NODESIGN_AUTH_PASSWORD —— 登录墙关闭（仅限本地开发）');
    }
  }
  if (admin) {
    // 存量项目回填归属（owner_id 列由 projects/store.js 幂等 ALTER 加上）
    const r = db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(admin.id);
    if (r.changes > 0) console.log(`[auth] bootstrap: ${r.changes} 个存量项目归属到 admin`);
  }
  return admin ? rowToUser(admin) : null;
}
