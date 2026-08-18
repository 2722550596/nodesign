/**
 * server/engine/browse/screencast.js — 把 agent 的浏览器画面推给用户（2026-08-18）
 *
 * 用户要的形态：「**用通用显示器来播放 agent 当前浏览器操作画面，必要时人类可以
 * 协助 agent**」。这个模块是那条像素通路加上行输入。
 *
 * ## 为什么是 CDP screencast（而不是轮询截图）
 *
 * ⭐ **screencast 是 damage-driven**（实测）：页面静止时 30 秒只发 1 帧、0.1% 单核；
 * 一次 DOM 改动 = 一帧。所以代价全在「页面在动 + 有人看」，静止时近乎免费。
 * 周期性 `page.screenshot()` 轮询正好丢掉这个免费午餐 —— 页面动不动都要编码一张，
 * 在 1 vCPU 上更差。
 *
 * ## 1 vCPU 上的账（⚠️ 实测纠正过一次归因）
 *
 * 拿一个持续 rAF 动画的页面分相量过：
 *
 *   动画页 + **没人订阅**      → chromium 树 85.6% 单核
 *   动画页 + 有人订阅（本文件的参数）→ 86.6%
 *   退订之后（页面照旧在动）    → 84.8%
 *
 * ⭐ **贵的是页面自己在动，不是画面流。** 在 nth=5 / q45 / maxWidth 1024 下推流只加
 * 约 1 个百分点（实测 6.5 fps、32 KB/s、平均帧 4.9 KB）。所以下面第 3 条的
 * 「活跃流 ≤1」**不是真正的保护** —— 真正的约束是「一个会永久动画的参考站只要
 * 开着就吃掉大半个核」，兜住它的是 registry 那边的 **5 分钟空闲回收**。
 * 留着 MAX_ACTIVE=1 是因为它便宜且无害，但别指望它省 CPU。
 * （待考虑但没做：没人看时用 `Emulation.setVirtualTimePolicy` 把页面冻住 ——
 *  能省下那 85%，代价是有些页面 resume 之后会坏，需要真跑一批站才敢上。）
 *
 * 三道刹车：
 * 1. **帧率硬压**：`everyNthFrame=5`（60fps 动画 → ~12fps）、`quality=45`、`maxWidth=1024`
 * 2. ⭐ **ack 门控背压**：CDP 的 screencast 是 ack 驱动的 —— 只在 socket 没堵
 *    （`bufferedAmount` 低于阈值）时才 `screencastFrameAck`。socket 堵住就不 ack，
 *    chromium 自然停发下一帧。**把"没人接得住"直接变成"不生产"**，不丢帧也不排队膨胀。
 * 3. **没人看就停**：最后一个订阅者断开 → 立刻 `stopScreencast`，不等浏览器空闲回收。
 *    同时活跃画面流全局 ≤1（**这条是 CPU 定的，不是内存**）。
 */

/** 帧参数：1 vCPU 下的取舍，别调高（改这里前先拿 `top` 量一遍） */
const CAST = { format: 'jpeg', quality: 45, maxWidth: 1024, maxHeight: 700, everyNthFrame: 5 };
/** socket 里积压超过这个就不再 ack（= 让 chromium 停发） */
const BACKPRESSURE_BYTES = 256 * 1024;
/** 全局同时只允许一路活跃画面流。⚠️ 实测它省的 CPU 很少（见文件头），留着是因为
 * 便宜无害 + 界面上"同时看两路"本来也没意义，不是因为它是 CPU 的主要保护。 */
const MAX_ACTIVE = 1;

/** projectId → { page, cdp, subs:Set<ws>, meta } */
const casts = new Map();

function activeCount() {
  let n = 0;
  for (const c of casts.values()) if (c.subs.size) n += 1;
  return n;
}

/**
 * 让某个 socket 订阅某项目的画面。
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function subscribe(projectId, ws, page) {
  let cast = casts.get(projectId);
  if (!cast) {
    if (activeCount() >= MAX_ACTIVE) {
      return { ok: false, reason: `同时只能看一路浏览器画面（这台机器 1 个 CPU 核，满帧动画页要吃掉 2/3 个核）。先关掉另一扇浏览器窗。` };
    }
    const cdp = await page.context().newCDPSession(page);
    cast = { projectId, page, cdp, subs: new Set(), meta: null, casting: false };
    casts.set(projectId, cast);

    cdp.on('Page.screencastFrame', (ev) => {
      cast.meta = ev.metadata;   // 里面有 deviceWidth/deviceHeight —— 接手时坐标换算要用
      const buf = Buffer.from(ev.data, 'base64');
      let anyoneKeepingUp = false;
      for (const sock of cast.subs) {
        if (sock.readyState !== 1) continue;
        // ⭐ 堵住的 socket 直接跳过这一帧（画面会掉帧，但不会积压）
        if (sock.bufferedAmount > BACKPRESSURE_BYTES) continue;
        anyoneKeepingUp = true;
        try { sock.send(buf, { binary: true, compress: false }); } catch { /* 下一帧再说 */ }
      }
      // ack 决定 chromium 发不发下一帧：没人接得住就不 ack = 不生产
      if (anyoneKeepingUp) {
        cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      } else {
        // 留一条慢速心跳，免得所有人都堵住之后再也不恢复
        setTimeout(() => {
          cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
        }, 500).unref?.();
      }
    });
  }

  cast.subs.add(ws);
  if (!cast.casting) {
    await cast.cdp.send('Page.startScreencast', CAST);
    cast.casting = true;
  }
  return { ok: true };
}

/** 退订。最后一个人走了就停止编码。 */
export async function unsubscribe(projectId, ws) {
  const cast = casts.get(projectId);
  if (!cast) return;
  cast.subs.delete(ws);
  if (cast.subs.size) return;
  if (cast.casting) {
    await cast.cdp.send('Page.stopScreencast').catch(() => {});
    cast.casting = false;
  }
}

/** 浏览器被关掉时（空闲回收 / LRU 淘汰）把这一路彻底忘掉 */
export function forget(projectId) {
  const cast = casts.get(projectId);
  if (!cast) return;
  casts.delete(projectId);
  for (const sock of cast.subs) {
    try { sock.send(JSON.stringify({ type: 'closed', reason: 'browser was shut down' })); } catch { /* */ }
  }
}

/** 当前帧的设备像素尺寸 —— 接手时前端坐标要按它换算 */
export function frameMeta(projectId) {
  return casts.get(projectId)?.meta ?? null;
}

export const _cast = { CAST, BACKPRESSURE_BYTES, MAX_ACTIVE };
