/**
 * server/engine/browse/handover.js — agent 求助 / 人接手（2026-08-18）
 *
 * 用户拍的方向是「**agent 需要帮助的时候人类才介入**」，不做人与 agent 同时操作的
 * 共享控制。所以这一层很小：agent 举手 → 用户在窗里点几下 → 用户说"好了" → agent 继续。
 *
 * ## 为什么 agent 要**阻塞等**
 *
 * 接手期间页面状态被人改（过验证墙、登录、关弹窗），agent 并行去干别的会基于陈旧
 * 状态出错。所以 `browser_request_help` 就停在这儿等。
 *
 * ## 为什么必须有超时
 *
 * 人可能就走了。没有超时的话 agent 会挂到会话结束 —— 那是最糟的失败形态
 * （用户看到的是"它卡住了"，而不是"它说了它需要什么"）。
 */

/** projectId → { resolve, timer, reason, since } */
const waiting = new Map();

export const HELP_TIMEOUT_MS = Number(process.env.ND_BROWSE_HELP_TIMEOUT_MS || 0) || 120_000;

/**
 * agent 举手，等人。
 * @returns {Promise<{released: boolean, url: string|null, waitedMs: number, by: string}>}
 *   released=false 表示等超时了（人没来）
 */
export function requestHelp(projectId, reason, { timeoutMs = HELP_TIMEOUT_MS } = {}) {
  // 同一项目重复举手：把前一次直接放走（agent 不该被自己的两次求助卡死）
  const prev = waiting.get(projectId);
  if (prev) { clearTimeout(prev.timer); prev.resolve({ released: false, url: null, waitedMs: 0, by: 'superseded' }); }

  const since = Date.now();
  return new Promise((resolve) => {
    const done = (v) => {
      if (!waiting.has(projectId)) return;
      clearTimeout(waiting.get(projectId).timer);
      waiting.delete(projectId);
      resolve({ ...v, waitedMs: Date.now() - since });
    };
    const timer = setTimeout(() => done({ released: false, url: null, by: 'timeout' }), timeoutMs);
    timer.unref?.();
    waiting.set(projectId, { resolve: done, timer, reason, since });
  });
}

/** 人点了「好了继续」 */
export function releaseHelp(projectId, { url = null, by = 'human' } = {}) {
  const w = waiting.get(projectId);
  if (!w) return false;
  w.resolve({ released: true, url, by });
  return true;
}

/** 有人在等吗（前端开窗时用来决定要不要亮 banner） */
export function pendingHelp(projectId) {
  const w = waiting.get(projectId);
  return w ? { reason: w.reason, waitingMs: Date.now() - w.since } : null;
}
