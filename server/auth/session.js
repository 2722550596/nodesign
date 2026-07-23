/**
 * server/auth/session.js — 单用户登录墙的无状态会话 token
 *
 * 形态（auth/README.md 方案 B/C 折中）：密码在 .env（NODESIGN_AUTH_PASSWORD），
 * 登录成功后签发 HMAC token 放 HttpOnly cookie。无服务端存储 —— server 重启
 * 不掉登录态（跟"重启丢活跃 session"的已知限制正交，别再叠一层重新登录的痛）。
 *
 * token 格式：v1.<expiresAtMs>.<hmacSha256Hex(secret, "v1.<expiresAtMs>")>
 * secret 默认从密码派生（sha256）——改密码即全端登出，单用户场景是 feature。
 * NODESIGN_AUTH_SECRET 可显式覆盖（想改密码但保持已登录设备时用）。
 */

import crypto from 'crypto';

export const COOKIE_NAME = 'nd_auth';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export function authPassword() {
  return process.env.NODESIGN_AUTH_PASSWORD || '';
}

/** 登录墙是否启用（密码未配置 = 关闭，启动时 index.js 会 loud warn） */
export function authEnabled() {
  return authPassword().length > 0;
}

function secret() {
  if (process.env.NODESIGN_AUTH_SECRET) return process.env.NODESIGN_AUTH_SECRET;
  return crypto.createHash('sha256').update(`nd-auth-v1:${authPassword()}`).digest('hex');
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

/** 密码比对（恒定时间） */
export function checkPassword(input) {
  if (!authEnabled()) return false;
  return timingSafeEq(input, authPassword());
}

export function mintToken(now = Date.now()) {
  const payload = `v1.${now + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const m = token.match(/^(v1\.(\d{1,16}))\.([0-9a-f]{64})$/);
  if (!m) return false;
  const [, payload, expStr, mac] = m;
  if (Number(expStr) < now) return false;
  return timingSafeEq(mac, sign(payload));
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

/** HTTP / WS upgrade 共用：请求是否带有效登录态 */
export function requestAuthed(req) {
  if (!authEnabled()) return true;
  return verifyToken(tokenFromCookieHeader(req.headers?.cookie));
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
