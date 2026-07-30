/**
 * server/auth/session.js — 无状态会话 token（v2：带用户身份）
 *
 * 2026-07-30 单密码墙 → 多用户：token 从 `v1.<exp>.<hmac>` 升级为
 *   v2.<userId>.<expiresAtMs>.<hmacSha256Hex(secret, "v2.<userId>.<exp>")>
 * v1 一律拒收（上线全员重登一次，admin 用老密码 + 用户名 admin 登）。
 *
 * secret：优先 NODESIGN_AUTH_SECRET（.env 固定随机值）；未配置时从
 * NODESIGN_AUTH_PASSWORD 派生并 loud warn —— 多用户下密码已 per-user，
 * 派生密钥只是别让服务起不来的兜底，不是推荐姿势。
 *
 * 无服务端 token 存储 —— server 重启不掉登录态。身份真伪查 users 表
 * （users-store 带 60s 缓存），disabled 用户 token 仍在也进不来。
 */

import crypto from 'crypto';
import { getUserById, countUsers } from './users-store.js';

export const COOKIE_NAME = 'nd_auth';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** 登录墙是否启用：有用户就启用；一个用户都没有且没密码 = 关闭（本地开发） */
export function authEnabled() {
  return countUsers() > 0 || (process.env.NODESIGN_AUTH_PASSWORD || '').length > 0;
}

let warnedDerivedSecret = false;
function secret() {
  if (process.env.NODESIGN_AUTH_SECRET) return process.env.NODESIGN_AUTH_SECRET;
  if (!warnedDerivedSecret) {
    warnedDerivedSecret = true;
    console.warn('[auth] NODESIGN_AUTH_SECRET 未配置，从 NODESIGN_AUTH_PASSWORD 派生（建议在 .env 固定一个随机值）');
  }
  return crypto.createHash('sha256').update(`nd-auth-v2:${process.env.NODESIGN_AUTH_PASSWORD || ''}`).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function mintToken(userId, now = Date.now()) {
  const payload = `v2.${userId}.${now + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns {string|null} userId（签名或过期不对 → null；v1 一律 null） */
export function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const m = token.match(/^(v2\.([A-Za-z0-9_-]{1,64})\.(\d{1,16}))\.([0-9a-f]{64})$/);
  if (!m) return null;
  const [, payload, userId, expStr, mac] = m;
  if (Number(expStr) < now) return null;
  if (!timingSafeEq(mac, sign(payload))) return null;
  return userId;
}

/** 从原始 Cookie header 解析出登录 token（不引 cookie-parser 依赖） */
export function tokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * HTTP / WS upgrade 共用：解析请求身份。
 * @returns {object|null} user（登录墙关闭时返回匿名 admin，guard 全放行）
 */
export function requestUser(req) {
  if (!authEnabled()) {
    return { id: '_anon', username: 'anon', role: 'admin', dailyTokenLimit: null, disabled: false };
  }
  const userId = verifyToken(tokenFromCookieHeader(req.headers?.cookie));
  if (!userId) return null;
  const user = getUserById(userId);
  if (!user || user.disabled) return null;
  return user;
}

/** 布尔兼容口（老调用点）：有有效身份即 true */
export function requestAuthed(req) {
  return !!requestUser(req);
}

export function cookieSerialize(token, req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function cookieClear() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
