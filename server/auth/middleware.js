/**
 * server/auth/middleware.js — 登录墙：/api/auth 路由 + /api 守卫
 *
 * - POST /api/auth/login  {password} → Set-Cookie nd_auth
 * - POST /api/auth/logout            → 清 cookie
 * - GET  /api/auth/status            → {required, authed}（前端 AuthGate 用，永远放行）
 * - authGuard：其余 /api/* 无有效 cookie 一律 401（health 挂在守卫之前不受影响）
 *
 * 暴力破解防护：按 IP 记连续失败，超限锁 15 分钟。in-memory —— 单实例架构下
 * 够用（跟 EventBus 同理），重启清零可接受。
 */

import express from 'express';
import {
  authEnabled, checkPassword, mintToken,
  requestAuthed, cookieSerialize, cookieClear,
} from './session.js';

const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;
/** ip → { fails, lockedUntil } */
const failures = new Map();

function clientIp(req) {
  // 直连 + nginx/CF 反代两种形态；多级代理取最初的那跳
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export const authRouter = express.Router();

authRouter.get('/status', (req, res) => {
  res.json({ required: authEnabled(), authed: requestAuthed(req) });
});

authRouter.post('/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, note: 'auth disabled' });

  const ip = clientIp(req);
  const rec = failures.get(ip);
  const now = Date.now();
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    const waitMin = Math.ceil((rec.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `尝试次数过多，${waitMin} 分钟后再试` });
  }

  const { password } = req.body || {};
  if (!checkPassword(typeof password === 'string' ? password : '')) {
    const next = { fails: (rec?.fails || 0) + 1, lockedUntil: 0 };
    if (next.fails >= MAX_FAILS) {
      next.fails = 0;
      next.lockedUntil = now + LOCK_MS;
      console.warn(`[auth] ip ${ip} locked for ${LOCK_MS / 60000}min (too many failures)`);
    }
    failures.set(ip, next);
    return res.status(401).json({ error: '密码错误' });
  }

  failures.delete(ip);
  res.setHeader('Set-Cookie', cookieSerialize(mintToken(), req));
  res.json({ ok: true });
});

authRouter.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', cookieClear());
  res.json({ ok: true });
});

/** 挂在业务路由之前的守卫 */
export function authGuard(req, res, next) {
  if (requestAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized', code: 'AUTH_REQUIRED' });
}
