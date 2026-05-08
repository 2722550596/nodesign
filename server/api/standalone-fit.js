/**
 * server/api/standalone-fit.js — 唯一权威 fit script source
 *
 * 三个调用方共享：
 *   - exports.js `injectViewportFit`（非 hybrid 导出薄包装）
 *   - exports/build-standalone.js `injectStandardFitScript`（hybrid 导出主路径）
 *   - 模板 canvas.template.html 不再自带 fit（导出 / 独立打开时由系统注入）
 *
 * 4 mode 感知：stack / ppt / carousel / custom
 *   - stack：deckHeight = wrap.scrollHeight（垂直平铺）
 *   - ppt：deckHeight = H_PAGE（单屏切换 .active）
 *   - carousel：deckHeight = H_PAGE（横向 flex+scroll-snap）
 *   - custom：查 window.__nd_deck.getDeckHeight() / fallback H_PAGE
 *
 * iframe 早退：window !== top 直接 return（前端 HtmlIframe.jsx 父窗口算 scale）
 * transform-origin 全场景统一 top left（兼容 carousel N×1920 wrap 不左溢）
 */

import { DECK } from '../shared/deck.js';

/**
 * 返回 fit script 内容（不含 <script> tag），调用方按需自加 wrap
 *
 * @param {object} [opts]
 * @param {number} [opts.width]   设计坐标系宽（默认 DECK.width = 1920）
 * @param {number} [opts.height]  设计坐标系高（默认 DECK.height = 1080）
 * @returns {string}
 */
export function fitScriptCode(opts = {}) {
  const W = opts.width ?? DECK.width;
  const H = opts.height ?? DECK.height;
  return `(function(){
  if (window !== window.top) return;
  var W = ${W}, H_PAGE = ${H}, body = document.body;
  var wrap = body.querySelector(':scope > .__nd-deck-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = '__nd-deck-wrap';
    while (body.firstChild && body.firstChild !== wrap) wrap.appendChild(body.firstChild);
    body.appendChild(wrap);
  }
  body.classList.add('__nd-fit-active');

  var mode = wrap.getAttribute('data-deck-mode') || 'stack';

  // PPT 兜底：agent 漏写"首屏给 page 1 加 .active" 时补一刀
  if (mode === 'ppt' && wrap.querySelectorAll('section[data-page].active').length === 0) {
    var firstPpt = wrap.querySelector('section[data-page]');
    if (firstPpt) firstPpt.classList.add('active');
  }

  function deckHeight() {
    if (mode === 'stack') return wrap.scrollHeight;
    if (mode === 'ppt') return H_PAGE;
    if (mode === 'carousel') return H_PAGE;
    if (mode === 'custom') {
      var api = window.__nd_deck;
      if (api && typeof api.getDeckHeight === 'function') {
        try { return api.getDeckHeight() || H_PAGE; } catch (_e) { return H_PAGE; }
      }
      return H_PAGE;
    }
    return wrap.scrollHeight; // 未知 mode 兜底 stack
  }

  function fit() {
    var vw = Math.max(document.documentElement.clientWidth || 0, 320);
    var s = vw / W;
    wrap.style.transform = s !== 1 ? 'scale(' + s + ')' : '';
    body.style.height = (deckHeight() * s) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);
  if (document.fonts) document.fonts.ready.then(fit);
})();`;
}

/**
 * 返回 fit 配套 <style> tag（含 wrapping tag），可直接拼到 HTML
 *
 * @param {number} [width=DECK.width]
 * @returns {string}
 */
export function fitStyleTag(width = DECK.width) {
  return `<style id="__nd-standard-fit-style">
body { margin: 0; }
body.__nd-fit-active {
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--bg, #fff);
}
/* transform-origin 统一 top left（兼容 carousel N×1920 wrap 不向左溢出）；
   stack/ppt 视觉居中靠 align-items:center 实现，不靠 transform-origin */
body.__nd-fit-active > .__nd-deck-wrap {
  transform-origin: top left;
  flex-shrink: 0;
}
body.__nd-fit-active > .__nd-deck-wrap:not([data-deck-mode="carousel"]) {
  width: ${width}px;
}
/* carousel：wrap 宽由 agent 在 deck CSS 里设（N × 1920 或 flex 子撑开），
   fit script 不强加 width，仅做 scale */
</style>`;
}

/**
 * 返回完整 <script>+<style> 注入块（最常用形态）
 *
 * @param {object} [opts] 同 fitScriptCode
 * @returns {string}
 */
export function fitInjectionBlock(opts = {}) {
  const W = opts.width ?? DECK.width;
  return `<script id="__nd-standard-fit" data-nodesign-keep="fit">
${fitScriptCode(opts)}
</script>
${fitStyleTag(W)}`;
}

/**
 * normalizeModeCss(deckMode) — ppt/carousel mode fallback CSS string
 *
 * 给 build-standalone HTML 导出路径 + Playwright PDF/PPTX 路径共用。
 *
 * stack/custom 返空字符串（noop）；ppt/carousel 返强 normalize CSS（让 section
 * 平铺 display:block，确保 boundingBox / page-break / 离线打开第一屏都能见内容）。
 */
export function normalizeModeCss(deckMode) {
  if (deckMode !== 'ppt' && deckMode !== 'carousel') return '';
  return `
    .__nd-deck-wrap { display: block !important; flex-direction: initial !important; overflow: visible !important; }
    section[data-page] { display: block !important; position: relative !important; inset: auto !important; opacity: 1 !important; transform: none !important; }
  `;
}

/**
 * normalizeModeStyleTag(deckMode) — 返 <style> tag 字面（含 wrapping tag），
 * HTML 导出路径注 </head> 前用
 */
export function normalizeModeStyleTag(deckMode) {
  const css = normalizeModeCss(deckMode);
  return css ? `<style id="__nd-mode-normalize" data-nodesign-keep="mode-normalize">${css}</style>` : '';
}
