/**
 * server/api/standalone-fit.js — 唯一权威 fit script source
 *
 * 范式（2026-05-08 简化）：
 *   - 不再分 stack/ppt/carousel/custom 4 mode；统一一种渲染契约
 *   - agent 写的 <section data-page> 仍是 1920×1080 设计稿坐标
 *   - 系统 fit script 自动给每个 section 包一层 100vw×100vh `__nd-page-frame`
 *   - 每个 frame scroll-snap-align: start，body scroll-snap-type: y mandatory
 *     → 滚轮一次切一整页 / 键盘 ↑↓ Space PgUp/PgDn 也按页切
 *   - section 在 frame 里 CSS scale `min(100vw/1920, 100vh/1080)` letterbox 居中
 *     纯 CSS 自适应，无 resize listener
 *
 * 三个调用方共享：
 *   - exports.js `injectViewportFit`（非 hybrid 导出薄包装）
 *   - exports/build-standalone.js `injectStandardFitScript`（hybrid 导出主路径）
 *   - 模板 canvas.template.html 不带 fit（导出 / 独立打开 / preview iframe 都由系统注入）
 *
 * iframe + standalone 行为一致（不再 window!==top 早退）：
 *   - frame 包装在 iframe 内也跑，让 preview 跟离线打开渲染一致
 *   - parent CanvasFrame 把 iframe 元素本身固定 1920×1080 logical viewport，
 *     再用 CSS transform 缩放 iframe 元素到 wrap 大小（外部 letterbox）
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
  var W = ${W}, H = ${H}, body = document.body;
  if (!body) return;

  var wrap = body.querySelector(':scope > .__nd-deck-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = '__nd-deck-wrap';
    while (body.firstChild && body.firstChild !== wrap) wrap.appendChild(body.firstChild);
    body.appendChild(wrap);
  }
  body.classList.add('__nd-fit-active');

  // 给每个 section[data-page] 包 100vw × 100vh frame（idempotent）
  // 滚轮 / 键盘按 frame 边界 snap 切页；CSS scale 单独处理 letterbox 居中
  var sections = Array.prototype.slice.call(wrap.querySelectorAll(':scope > section[data-page]'));
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    if (s.parentElement && s.parentElement.classList.contains('__nd-page-frame')) continue;
    var frame = document.createElement('div');
    frame.className = '__nd-page-frame';
    s.parentNode.insertBefore(frame, s);
    frame.appendChild(s);
  }
})();`;
}

/**
 * 返回 fit 配套 <style> tag（含 wrapping tag），可直接拼到 HTML
 *
 * page-scale 用纯 CSS calc(min()) 做，无需 JS resize handler 自动响应。
 *
 * @param {number} [width=DECK.width]
 * @param {number} [height=DECK.height]
 * @returns {string}
 */
export function fitStyleTag(width = DECK.width, height = DECK.height) {
  // !important 用在 layout reset 三条上：兼容老 canvas.html 自带的 wrap-level fit CSS
  // （body.__nd-fit-active flex+align-items:center / wrap width:1920px+transform 等），
  // 否则老 deck 在新 frame 范式下会被偏左渲染。新 deck 模板已不含老 CSS，无害。
  return `<style id="__nd-standard-fit-style">
:root { --nd-page-scale: min(calc(100vw / ${width}px), calc(100vh / ${height}px)); }
html, body { margin: 0; padding: 0; }
body.__nd-fit-active {
  display: block !important;
  background: var(--bg, #fff);
  scroll-snap-type: y mandatory;
  overflow-x: hidden;
}
body.__nd-fit-active > .__nd-deck-wrap {
  display: block !important;
  width: auto !important;
  margin: 0 !important;
  transform: none !important;
  transform-origin: 0 0 !important;
}
.__nd-page-frame {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  scroll-snap-align: start;
  background: inherit;
}
.__nd-page-frame > section[data-page] {
  flex-shrink: 0;
  width: ${width}px;
  height: ${height}px;
  transform-origin: center center;
  transform: scale(var(--nd-page-scale));
  position: relative;
}
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
  const H = opts.height ?? DECK.height;
  return `<script id="__nd-standard-fit" data-nodesign-keep="fit">
${fitScriptCode(opts)}
</script>
${fitStyleTag(W, H)}`;
}
