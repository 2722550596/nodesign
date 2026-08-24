/**
 * frame-freeze —— 定格活 iframe 的渲染循环（2026-08-24，站点卡性能案）
 *
 * 病：产物卡的预览是真 iframe（LiveFrame），three.js / React 站点在卡片里是
 * 全速跑真身 —— WebGL 上下文 + rAF 60fps，按真实设备宽渲染再 CSS 缩小，
 * 一张卡就能把主画布拖垮；开产物窗时底下的卡还在跑，是双实例。
 *
 * 法：从外面把 contentWindow.requestAnimationFrame 换成"只排队不执行"——
 * 动画链停在最后一帧（合成器保留最后呈现的画面，卡上照样有图），CPU 归零。
 * 解冻时把攒着的回调用原 rAF 补发，链就地续上（three.js 的循环靠"回调里再
 * 约下一帧"，直接 no-op 会把链掐死、恢复不了 —— 所以必须排队）。
 *
 * 只对同源 iframe 有效（产物预览 sandbox 带 allow-same-origin）；跨源/死窗
 * 一律静默不冻。不碰 setInterval/CSS 动画 —— 大头是 rAF，别扩大爆破面。
 */

/** @returns {boolean} 真的冻上了才 true（已冻/够不着/没有 rAF 都是 false） */
export function freezeWin(win) {
  try {
    if (!win || win.__ndFreeze) return false;
    const orig = win.requestAnimationFrame?.bind(win);
    if (!orig) return false;
    const state = { queued: [], orig };
    win.__ndFreeze = state;
    // 返回 -1：调用方 cancelAnimationFrame(-1) 无害（真 id 恒 > 0）
    win.requestAnimationFrame = (cb) => { state.queued.push(cb); return -1; };
    return true;
  } catch { return false; }
}

/** 解冻并补发攒着的回调，动画链原地续上。@returns {boolean} */
export function thawWin(win) {
  try {
    const state = win?.__ndFreeze;
    if (!state) return false;
    win.requestAnimationFrame = state.orig;
    win.__ndFreeze = null;
    for (const cb of state.queued.splice(0)) state.orig(cb);
    return true;
  } catch { return false; }
}
