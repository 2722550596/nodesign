/**
 * server/engine/pi/ask-registry.js — AskUserQuestion 挂起态（M2 第二步，doc §5.3 方案 A）。
 *
 * pi 扩展 ask-user.ts 的 registerTool('ask_user_question') execute 里 POST sidecar
 * /ask 长轮询；sidecar 在这里登记挂起 Promise 并 emit run.ask_user_question 给前端；
 * 用户在前端答完 → POST /api/projects/:pid/runs/:runId/answer → turn.js 调
 * answerAsk → resolve → /ask 返回 answers → execute 拿到答案返回 tool result。
 *
 * 阻塞语义与 SDK canUseTool 一致：ask 挂起期间 turn 不结束（pi 工具 execute 无限
 * 阻塞合法，agent-loop 裸 await 无超时）。
 *
 * 生命周期纪律：
 *  - 每会话同时至多一个挂起 ask（串行 turn 天然保证；重复 register 拒绝）。
 *  - run 取消 / session 关闭 → cancelAsksForSession：挂起 Promise reject，
 *    /ask 长轮询以 503 收尾，pi 侧 execute 抛错 → 工具错误结果，turn 继续收尾。
 *  - 进程内 Map，无持久化——ask 是瞬态交互，主进程重启即失效（pi 子进程也一起死）。
 */

/** @type {Map<string, {askId: string, runId: string|null, questions: unknown, resolve: Function, reject: Function, createdAt: number}>} */
const pending = new Map();   // sid → entry

let seq = 0;

/**
 * 登记一个挂起 ask。
 * @param {{sid: string, runId?: string|null, questions: unknown}} opts
 * @returns {{askId: string, promise: Promise<unknown>}} 或 null（该 sid 已有挂起 ask）
 */
export function registerAsk({ sid, runId = null, questions }) {
  if (!sid || pending.has(sid)) return null;
  const askId = `ask_${++seq}_${Date.now().toString(36)}`;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // 取消路径（cancelAsksForSession / cancelAskById）可能在任何 awaiter 挂上前
  // reject（如 beforeEach 清残留、连接断先于 /ask 的 await）→ 先挂 noop catch
  // 防 unhandled rejection；真正 await 的 caller 照样收到 reject。
  promise.catch(() => {});
  pending.set(sid, { askId, runId, questions, resolve, reject, createdAt: Date.now() });
  return { askId, promise };
}

/**
 * 取某会话当前挂起 ask 的元信息（/answer 路由校验用：有没有在问、runId 对不对）。
 * @returns {{askId: string, runId: string|null, questions: unknown}|null}
 */
export function getPendingAsk(sid) {
  const e = pending.get(sid);
  return e ? { askId: e.askId, runId: e.runId, questions: e.questions } : null;
}

/**
 * 回答挂起 ask：resolve Promise（/ask 长轮询随之返回）。
 * @param {string} sid
 * @param {unknown} answers  前端答案载荷（形状由 ask-user.ts 与前端约定）
 * @returns {boolean} 是否有挂起 ask 被回答
 */
export function answerAsk(sid, answers) {
  const e = pending.get(sid);
  if (!e) return false;
  pending.delete(sid);
  e.resolve(answers);
  return true;
}

/**
 * 取消某会话全部挂起 ask（run 取消 / session 关闭）。幂等。
 * @returns {number} 取消的个数
 */
export function cancelAsksForSession(sid, reason = 'session_closed') {
  const e = pending.get(sid);
  if (!e) return 0;
  pending.delete(sid);
  e.reject(new Error(`ask cancelled: ${reason}`));
  return 1;
}

/**
 * 按 askId 取消（/ask 长轮询的 HTTP 连接断了 → pi 进程可能已死，挂起态清掉）。
 * @returns {boolean}
 */
export function cancelAskById(askId, reason = 'connection_closed') {
  for (const [sid, e] of pending) {
    if (e.askId === askId) {
      pending.delete(sid);
      e.reject(new Error(`ask cancelled: ${reason}`));
      return true;
    }
  }
  return false;
}
/** 测试钩子：只读快照。 */
export function _pendingAskCount() {
  return pending.size;
}
