/**
 * web/src/lib/canvas-iframe-ops.js — 伸手进预览 iframe 干一件事（2026-08-18 从
 * ProjectWorkspace 拆出来）
 *
 * agent 的 `navigate_to_page` / `highlight` 两个工具最终落在这里：找到那个 iframe，
 * 滚过去 / 闪一下。拆出来的理由是它跟"路由组件"一点关系都没有 —— 它是 DOM 操作，
 * 而 ProjectWorkspace 是个 2400 行的路由。
 *
 * ⚠️ 两个函数都吞掉异常：iframe 可能不在、可能跨源、目标元素可能已经没了。
 * 这些都不是错误，是时序 —— agent 发指令的那一刻用户可能刚把窗关掉。
 */

const iframeDoc = () => {
  try { return document.querySelector('iframe')?.contentDocument ?? null; }
  catch { return null; }   // 跨源
};

/** 滚到某一页（deck 的 section[data-page]） */
export function scrollToPage(pageIndex) {
  try {
    const target = iframeDoc()?.querySelector(`section[data-page="${pageIndex}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch { /* iframe 不在 / 跨源 */ }
}

/** 短暂高亮一个元素（描边脉冲，到时自己还原） */
export function pulseHighlight(selector, durationMs = 1500) {
  try {
    const target = iframeDoc()?.querySelector(selector);
    if (!target) return;
    const orig = {
      outline: target.style.outline,
      offset: target.style.outlineOffset,
      transition: target.style.transition,
    };
    target.style.transition = 'outline 0.2s ease, outline-offset 0.2s ease';
    target.style.outline = '3px solid rgba(255, 196, 0, 0.85)';
    target.style.outlineOffset = '4px';
    setTimeout(() => {
      try {
        target.style.outline = orig.outline;
        target.style.outlineOffset = orig.offset;
        target.style.transition = orig.transition;
      } catch { /* 元素可能已经没了 */ }
    }, durationMs);
  } catch { /* */ }
}
