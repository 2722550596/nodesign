/**
 * rate-window.js —— 内存滑动窗口限流。
 *
 * 给演出端点用的频率闸门：金额日限（quota.js）拦不住单日尖峰——iframe 同源
 * 带 cookie，agent 写的页面里一个 setInterval 就是烧钱机，必须有按分钟的闸。
 * 内存实现就够：限流是保护性关卡不是记账，重启清零无所谓。
 */

export function makeRateWindow({ limit, windowMs }) {
  const hits = new Map();   // key → 命中时间戳数组（只留窗口内的）
  return {
    /** 窗口内已命中几次（只看不扣；注册这类"先判再做、做成了才扣"的场景用） */
    count(key, now = Date.now()) {
      return (hits.get(key) || []).filter(t => now - t < windowMs).length;
    },
    /** @returns {{ok: true} | {ok: false, retryAfterMs: number}} */
    take(key, now = Date.now()) {
      const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
      if (arr.length >= limit) {
        hits.set(key, arr);
        return { ok: false, retryAfterMs: windowMs - (now - arr[0]) };
      }
      arr.push(now);
      hits.set(key, arr);
      return { ok: true };
    },
  };
}
