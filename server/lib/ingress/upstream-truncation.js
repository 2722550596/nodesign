/**
 * lib/ingress/upstream-truncation.js —— 「上一次响应是不是半截」的会话级标记（08-21 晚）。
 *
 * 病：Zen 会在模型说到一半时把流掐了（无 finish_reason，或私货 finish 如 network_error），
 * 而正文已经吐出来一部分。转换层照旧按 end_turn 收尾（这是对的，假上游实测：有可见输出后
 * 再发 error 事件 CLI 不重试、只会把半截 + "Server error mid-response" 一起判 is_error 给用户），
 * 于是**半截答案就成了最终答案** —— agent 说了半句话就收工，用户以为它答完了。
 * 08-21 当天生产日志 4 次。
 *
 * 治法（对齐 OpenCode 1.18.21 对 unknown finish 的处理）：ingress 每次往返把「半截」标记记到
 * 会话上，session-loop 收到 result 时取走；有标记就自动补一条续接消息再跑一轮，
 * 半截那段原样留在对话历史里（跟 OpenCode 一样，不删不改，让模型自己接着说）。
 *
 * 只记**最近一次**，不累加：一个回合里有多次 API 往返（工具调用），我们关心的是收尾那次
 * 是不是半截。任何一次完整收尾都把标记清掉。
 */

export class UpstreamTruncation {
  constructor({ now = () => Date.now() } = {}) {
    this.map = new Map();   // sid → { reason, appModel, at }
    this.now = now;
  }
  /**
   * 记一次往返的收尾形态。truncated 为 null/'' = 这次收得完整 → 清掉旧标记。
   * @param {string} sid
   * @param {string|null} truncated  半截原因串（openai-chat.js 的 truncationReason 产出）
   * @param {{ appModel?: string }} [meta]
   */
  note(sid, truncated, { appModel = '' } = {}) {
    if (!sid) return;
    if (!truncated) { this.map.delete(sid); return; }
    this.map.set(sid, { reason: String(truncated).slice(0, 120), appModel, at: this.now() });
  }
  /** 取走并清零：{ reason, appModel, at } 或 null */
  take(sid) {
    if (!sid) return null;
    const cur = this.map.get(sid) || null;
    this.map.delete(sid);
    return cur;
  }
  clear(sid) { if (sid) this.map.delete(sid); else this.map.clear(); }
}

/** ingress 进程内单例 */
export const upstreamTruncation = new UpstreamTruncation();

export function noteUpstreamTruncation(sid, truncated, meta) { upstreamTruncation.note(sid, truncated, meta); }
export function takeUpstreamTruncation(sid) { return upstreamTruncation.take(sid); }
