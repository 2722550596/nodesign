/**
 * server/engine/runs/turn-relay.js — run 记录 ↔ 用户消息的配对（M1 pi-rp 换源：严格串行）
 *
 * M1 换源（doc §5.2）：SDK 时代靠 uuid claim + merge 把并发消息合进同一 run
 * （CLI streamInput 会把 turn 进行中追加的消息并进正在跑的这一轮）。pi-rp 引擎
 * 一个 prompt 就是一个 turn，没有并轮 —— 改为**严格串行**：一条用户消息恰好对应
 * 一个 turn，turn 进行中追加的消息排队等前一个 settle。
 *
 * 于是整套 uuid 认领机制作废删除：claimRunByUuid / pushUnclaimedMessage /
 * closeMergedRun / session record 的 runIdByUuid / pushUserMessage 的 uuid 戳印。
 * 截断续写（半截续接）M1 不做，pushUnclaimedMessage 的唯一用户没了。
 *
 * 会话状态仍归 active-runs.js 的 session record 所有（currentRunId /
 * pendingRunIds / inputQueue），这里只读写它的这几个字段 —— 本模块 import
 * active-runs，反向不 import（无环）。
 *
 * 串行语义：
 *   - pushUserMessage：会话空闲（无 currentRunId 且无 pending）→ 直接设
 *     currentRunId（queued=false，session-loop 拉到消息即开跑）；否则进
 *     pendingRunIds 排队（queued=true）。
 *   - takeNextRunId：当前 turn 结束后 FIFO 提升队头为 current。旧时代怕 echo
 *     锚点丢失才要 uuid 认领；串行化后 turn 边界就是我们自己的 settle 点，
 *     直接提升是安全的。
 *   - getQueueDepth = pendingRunIds.length（"agent 还没接上我这条"的真相，
 *     口径同 08-20 重做后的版本）。
 */

import { getQuerySession } from './active-runs.js';
import { getRun, markRunFailed } from './store.js';

/**
 * 推一条用户消息进会话队列 + 关联 runId。调用方（turn.js）已 createRun。
 *
 * @param {string} sessionId
 * @param {string} runId  - 这条消息对应的 run record id（前端按它跟踪）
 * @param {object} message  - compose 好的 pi 输入 { text, images }
 *   images: [{type:'image', data:<base64>, mimeType}]（rpc-client prompt 形状）
 * @returns {{queued: boolean} | false} false = session 不存在 / 已 abort / push 失败；
 *   queued=false 表示立即成为当前 turn，queued=true 表示排队等前一个 settle。
 */
export function pushUserMessage(sessionId, runId, message) {
  const rec = getQuerySession(sessionId);
  if (!rec) return false;
  if (rec.abortController.signal.aborted) return false;
  // 严格串行：空闲（无 current 且无 pending）→ 直接上位；否则排队。
  // 先记账再 push —— push 成功前 currentRunId/pendingRunIds 已就位，
  // 不存在"消息进队但没人认领"的窗口（单线程，中间无 await）。
  const becameCurrent = !rec.currentRunId && rec.pendingRunIds.length === 0;
  if (becameCurrent) rec.currentRunId = runId;
  else rec.pendingRunIds.push(runId);
  rec.lastActivityAt = Date.now();
  try {
    rec.inputQueue.push({
      runId,
      text: typeof message?.text === 'string' ? message.text : '',
      images: Array.isArray(message?.images) ? message.images : [],
    });
    return { queued: !becameCurrent };
  } catch (err) {
    // push 失败（queue 已 close 等）→ 回滚记账，别留下没有消息的 runId
    if (becameCurrent) {
      if (rec.currentRunId === runId) rec.currentRunId = null;
    } else {
      const i = rec.pendingRunIds.indexOf(runId);
      if (i >= 0) rec.pendingRunIds.splice(i, 1);
    }
    console.warn(`[turn-relay] pushUserMessage failed for ${sessionId}: ${err.message}`);
    return false;
  }
}

/**
 * 当前 turn 结束 → FIFO 提升队头为新的 currentRunId（session-loop 每个 turn
 * settle 后调）。队列空 → currentRunId 置 null，会话转空闲。
 *
 * @param {string} sessionId
 * @returns {string|null} 提升后的 currentRunId（null = 没有排队的了）
 */
export function takeNextRunId(sessionId) {
  const rec = getQuerySession(sessionId);
  if (!rec) return null;
  rec.currentRunId = rec.pendingRunIds.shift() || null;
  return rec.currentRunId;
}

/**
 * @param {string} sessionId
 * @returns {number} 排队中（已 push、还没轮到跑）的 run 数
 */
export function getPendingRunCount(sessionId) {
  return getQuerySession(sessionId)?.pendingRunIds.length || 0;
}

/**
 * 队列深度（前端"已排队 N 条"）= 排队中的 run 数，不含正在跑的当前 turn。
 * 0 = agent idle 立即处理；>0 = agent 还在忙，下一条要排队。
 *
 * @param {string} sessionId
 * @returns {number}
 */
export function getQueueDepth(sessionId) {
  return getPendingRunCount(sessionId);
}

/**
 * 广播"已排队 N 条"（N = 排队中的 run 数，见 getQueueDepth）。
 * push 后 / turn 处理完后各 emit 一次让前端增减。
 *
 * @param {import('../agent/events.js').EventBus} eventBus
 * @param {string} sessionId
 */
export function publishQueueDepth(eventBus, sessionId) {
  eventBus.publish({ type: 'run.queue.depth', sessionId, depth: getQueueDepth(sessionId), ts: new Date().toISOString() });
}

/**
 * drain 会话输入侧：把还没轮到跑的 pending run 全部标 failed（run 行不能永远
 * 停 pending），并清空 pendingRunIds。inputQueue 的 close 归 active-runs 的
 * closeQuerySession / unregisterQuerySession（它们持有 queue 的生命周期）。
 *
 * session-loop 的 finally / close session 路径调。幂等。正在跑的当前 turn 不
 * 在这里处理（cancelRun / 等 settle 归调用方）。
 *
 * @param {string} sessionId
 */
export function drainSession(sessionId) {
  const rec = getQuerySession(sessionId);
  if (!rec) return;
  for (const runId of rec.pendingRunIds.splice(0)) {
    try {
      const run = getRun(runId);
      if (run && (run.status === 'pending' || run.status === 'running')) {
        markRunFailed(runId, '会话结束，排队的消息没有执行');
      }
    } catch { /* run 行可能已被别的路径关账；忽略 */ }
  }
}
