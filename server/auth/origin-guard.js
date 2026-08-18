/**
 * server/auth/origin-guard.js — 「这个请求是从哪个页面发起的」判据（2026-08-18）
 *
 * 为什么需要：cookie 是 `SameSite=Lax`（session.js），它挡的是**跨站**。而已发布
 * 站点住在 `<slug>.share.xiaobuyu.trade`，与应用主机 `nodesign.xiaobuyu.trade`
 * 同 eTLD+1 —— **同站**。Lax 照发。
 *
 * 真跑验过（chromium + `--host-resolver-rules` 造两个同 eTLD+1 的子域）：
 * `evil.share.nd.trade` 上的页面开 `ws://app.nd.trade/ws/projects/<pid>/browser`,
 * 受害者的 host-only Lax cookie **原样送达**，而服务端收到的
 * `Origin: http://evil.share.nd.trade` 从来没人看。于是任何 beta 用户发布的页面
 * 都能直播别人已登录的浏览器画面并注入键鼠。
 *
 * ⚠️ 判据只有一份：WS 两条升级路 + cors 都 import 这里，别在调用点各写一份
 * （[[feedback-copied-guard-shape]]：去掉第二份实现而不是添第三份）。
 *
 * ⭐ **Origin 缺失 = 放行**，这不是漏洞：浏览器对 WS 握手和带凭据的跨源请求
 * **一定**发 Origin，缺失的只可能是非浏览器客户端（我们自己的验收脚本、
 * playwright、curl）。它们手里本来就有 cookie，拦它们不多一分安全，只拆工具链。
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** host 去掉端口（IPv6 的 [::1]:5173 也要认） */
function bare(hostWithPort) {
  const h = String(hostWithPort || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i === -1 ? h : h.slice(0, i);
}

function isLoopback(hostWithPort) {
  const b = bare(hostWithPort);
  return LOOPBACK.has(b) || LOOPBACK.has(b.replace(/^\[|\]$/g, ''));
}

/**
 * 额外白名单：env `ND_ALLOWED_ORIGINS`（逗号分隔，写完整 origin 或裸 host 都认）。
 * 老键 `CORS_ORIGIN` 一并认，免得改名把已有部署配置作废。
 */
let extraCache = null;
function extraHosts() {
  if (extraCache) return extraCache;
  const raw = `${process.env.ND_ALLOWED_ORIGINS || ''},${process.env.CORS_ORIGIN || ''}`;
  extraCache = new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean)
      .map((s) => { try { return new URL(s).host.toLowerCase(); } catch { return s.toLowerCase(); } }),
  );
  return extraCache;
}

/**
 * @param {{ headers?: Record<string,string|undefined> }} req
 * @returns {boolean} 允许携带凭据地访问
 */
export function originAllowed(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;              // 非浏览器客户端，见文件头
  if (origin === 'null') return false;   // file:// / 不给 allow-same-origin 的 iframe
  let originHost;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }

  const host = String(req?.headers?.host || '').toLowerCase();
  if (originHost === host) return true;  // 同源：生产走这条（nginx 传的是 Host $host）
  // vite dev 代理把 Host 改写成了 localhost:4001，而页面在 localhost:5173
  if (isLoopback(originHost) && isLoopback(host)) return true;
  return extraHosts().has(originHost);
}

/** 测试用：改过 env 之后清掉白名单缓存 */
export function _resetOriginCache() { extraCache = null; }
