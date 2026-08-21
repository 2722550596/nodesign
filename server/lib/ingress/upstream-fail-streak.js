/**
 * lib/ingress/upstream-fail-streak.js —— 每会话的上游连续失败计数（08-21 晚，僵尸 run 案）。
 *
 * 病：Zen 持续回 503 / network_error 时，我们按规矩发 5xx 或流内 error 事件，CLI 对 5xx 做**无上限**
 * 指数退避重试（假上游实测：75s 内 16 次还在涨），每次又挂 Zen 50~185s —— 一个回合跑了一小时，
 * 用户早断线，run 一直 running。流内 error 事件本身 CLI 只试 4 次就放弃，真正喂活循环的是
 * 非流式兜底那一跳拿到的 502/503。
 *
 * 治法：同一会话连续 N 次上游失败后，ingress 对下一个请求直接回 **HTTP 400**（invalid_request_error）。
 * 假上游 + 真 SDK 循环实测：400 不重试、回合以 is_error 的 result 收场、错误文本原样到用户、
 * streamInput 会话不死（下一条消息照常处理）。消费掉上限后计数归零，用户再发就有新的 N 次机会。
 *
 * 什么算失败：上游 5xx / 转发层网络错 / 200 但零 choices / 私货 finish_reason 且零可见输出（流式与
 * 非流式都算）。什么算成功：一次回应带可见内容（或透传路 2xx）。成功一次就清零。
 * 超过 DECAY_MS 没有新失败也清零（别让昨天的坏账拦今天的人）。
 */

export const DEFAULT_MAX = 4;
export const DECAY_MS = 30 * 60 * 1000;

export function failStreakMax(env = process.env) {
  const v = Number(env.NODESIGN_UPSTREAM_FAIL_STREAK);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX;
}

export class FailStreaks {
  constructor({ max = null, decayMs = DECAY_MS, now = () => Date.now() } = {}) {
    this.map = new Map();   // sid → { n, last, reason }
    this.maxOverride = max;
    this.decayMs = decayMs;
    this.now = now;
  }
  get max() { return this.maxOverride ?? failStreakMax(); }
  /** 记一次结果。ok=true 清零；ok=false 累加并记原因。返回当前计数。 */
  note(sid, ok, reason = '') {
    if (!sid) return 0;
    if (ok) { this.map.delete(sid); return 0; }
    const now = this.now();
    const cur = this.map.get(sid);
    const n = cur && now - cur.last < this.decayMs ? cur.n + 1 : 1;
    this.map.set(sid, { n, last: now, reason: String(reason || '').slice(0, 160) });
    return n;
  }
  /** 到上限了吗（含衰减判断） */
  exhausted(sid) {
    const cur = sid ? this.map.get(sid) : null;
    if (!cur) return false;
    if (this.now() - cur.last >= this.decayMs) { this.map.delete(sid); return false; }
    return cur.n >= this.max;
  }
  /** 取走并清零：返回 { n, reason }，用于组拒绝话术；之后用户再发有新的 max 次机会 */
  consume(sid) {
    const cur = this.map.get(sid) || { n: 0, reason: '' };
    this.map.delete(sid);
    return cur;
  }
  clear(sid) { if (sid) this.map.delete(sid); else this.map.clear(); }
}

/** ingress 进程内单例 */
export const failStreaks = new FailStreaks();

/** 拒绝体（Anthropic error 形状；400 = CLI 不重试，实测） */
export function exhaustedErrorBody({ label, n, reason }) {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `${label} 连续 ${n} 次没有返回可用内容（最近一次：${reason || '未知'}），这轮先停了。稍后再发一次，或换个模型。`,
    },
  };
}
