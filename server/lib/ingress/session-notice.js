/**
 * lib/ingress/session-notice.js —— ingress 往「正在等的那个会话」推一句人话（08-21 晚）。
 *
 * 病：上游抖的时候（Zen 的 503 挂 50~140 秒才返回、network_error 慢败 185 秒），CLI 在退避重试，
 * 会话里**什么都不动** —— 用户看到的是一个转了三五分钟的绿点，不知道是卡死了还是在重试，
 * 也就不知道该等还是该点停止。
 *
 * 治法：ingress 每次上游失败就往会话推一条通知（前端弹 toast）。ingress 住 lib/、会话住 engine/，
 * 为了不让 lib 反向依赖 engine（session-loop 已经 import model-ingress），这里只做一个回调注册表：
 * session-loop 起会话时 register，结束时 unregister，ingress 只管 notice。
 *
 * 节流住在这里而不是调用方：一次失败 CLI 0.2 秒就重发，连着几发能刷出一串 toast。
 * 同一会话 MIN_INTERVAL_MS 内只推一条，够用户知道"在重试"，不至于变成噪音。
 */

export const MIN_INTERVAL_MS = 20_000;

export class SessionNotices {
  constructor({ minIntervalMs = MIN_INTERVAL_MS, now = () => Date.now() } = {}) {
    this.handlers = new Map();   // sid → fn(payload)
    this.lastAt = new Map();     // sid → ts（节流）
    this.minIntervalMs = minIntervalMs;
    this.now = now;
  }
  register(sid, fn) { if (sid && typeof fn === 'function') this.handlers.set(sid, fn); }
  /**
   * 注销。`expected` 给了就只在**当前登记的就是它**时才删（跟 unregisterQuerySession 的 token 比对同一招）：
   * 旧会话的 finally 跑在 `await commitWorkspace` 之后，可能已经隔了几秒，期间同 sid 的新会话
   * 已经 register —— 不比对就会把新会话的通道删掉，新会话从此静默收不到上游提示。
   */
  unregister(sid, expected = null) {
    if (!sid) return;
    if (expected && this.handlers.get(sid) !== expected) return;
    this.handlers.delete(sid);
    this.lastAt.delete(sid);
  }
  /**
   * 推一条。没有注册者（非会话请求 / 会话已结束）就静默丢弃。
   * @param {string} sid
   * @param {{ key?: string, text: string, priority?: string }} payload
   * @param {{ throttle?: boolean }} [opts] throttle=false 强制推（默认 true）
   * @returns {boolean} 真推出去了吗
   */
  notice(sid, payload, { throttle = true } = {}) {
    const fn = sid ? this.handlers.get(sid) : null;
    if (!fn || !payload?.text) return false;
    const now = this.now();
    if (throttle && this.lastAt.has(sid)) {
      // ⚠️ 别写成 `(this.lastAt.get(sid) || 0)`：没推过时那是 0，真时钟下 now-0 巨大碰巧放行，
      // 假时钟（测试里 now()=0）却把**第一条**吞掉 —— 同一段代码两种行为。
      if (now - this.lastAt.get(sid) < this.minIntervalMs) return false;
    }
    this.lastAt.set(sid, now);
    try { fn(payload); return true; } catch (err) {
      console.warn(`[session-notice] handler failed for ${String(sid).slice(0, 8)}: ${err.message}`);
      return false;
    }
  }
}

/** 进程内单例 */
export const sessionNotices = new SessionNotices();

export function registerSessionNotice(sid, fn) { sessionNotices.register(sid, fn); }
export function unregisterSessionNotice(sid, expected) { sessionNotices.unregister(sid, expected); }
export function noticeSession(sid, payload, opts) { return sessionNotices.notice(sid, payload, opts); }
