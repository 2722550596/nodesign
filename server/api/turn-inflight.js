/**
 * server/api/turn-inflight.js — POST /turn 的 requestId 去重（2026-08-20 从 turn.js 拆出，
 * 行数棘轮；逻辑原样）。
 */

/**
 * Phase A.6（2026-05-07）：requestId LRU dedup —— 弱网下用户重发 / fetch retry
 * 同 requestId 直接返已存在的 { runId, sessionId }，不重复 createRun / startNewRunSession。
 *
 * 数据：Map<requestId, { pid, runId, sessionId, ts }>，简单 5 分钟 TTL + 1024 容量上限
 * （超过先驱逐最旧）。同进程内存，重启清空（此时活 run 也都死了，一致）。
 *
 * race 修复（2026-05-08）：原版 lruGet → createRun → lruPut 之间无并发保护。两个
 * 并发 POST 同 requestId 都通过 lruGet 返 null → 各自 createRun → 双 run 同 sid
 * 推进同 inputQueue → agent 收两条同 chat 处理两轮（双倍 token / canvas 双写）。
 *
 * 加 inflightTurns Map<requestId, Promise<result>>：第一 POST 进来注册 in-flight
 * Promise；第二 POST 看到 in-flight 就 await 拿第一个的 result 返 deduped。
 * 第一个 POST 拿到 res 写完 lruPut + resolveInflight，5s 后 delete in-flight（让
 * LRU 接管后续幂等查询）。
 */
const REQUEST_LRU_TTL_MS = 5 * 60 * 1000;
const REQUEST_LRU_MAX = 1024;
const requestLru = new Map();
export const inflightTurns = new Map();  // requestId → Promise<{ pid, runId, sessionId }>
export const INFLIGHT_RETENTION_MS = 5_000;
export function lruGet(requestId) {
  const rec = requestLru.get(requestId);
  if (!rec) return null;
  if (Date.now() - rec.ts > REQUEST_LRU_TTL_MS) {
    requestLru.delete(requestId);
    return null;
  }
  return rec;
}
export function lruPut(requestId, rec) {
  if (requestLru.size >= REQUEST_LRU_MAX) {
    // 驱逐最早（Map 保留插入顺序）
    const firstKey = requestLru.keys().next().value;
    if (firstKey) requestLru.delete(firstKey);
  }
  requestLru.set(requestId, { ...rec, ts: Date.now() });
}

