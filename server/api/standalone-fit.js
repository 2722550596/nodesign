/**
 * server/api/standalone-fit.js — 唯一权威 fit script source
 *
 * 范式（2026-05-08）：每个 <section data-page> 写设计稿原坐标，系统自动给每
 * section 包 100vw×100vh `__nd-page-frame` + scroll-snap-y mandatory，单页
 * 铺满 viewport，滚轮 / 键盘按页切。CSS min(100vw/W, 100vh/H) 缩放 letterbox
 * 居中，纯 CSS 自适应不用 JS resize handler。
 *
 * 多比例支持（2026-05-08 增）：deck 比例由 wrap data-deck-aspect 声明，3 档：
 *   "16:9"  1920×1080（默认，PPT 标准）
 *   "9:16"  1080×1920（竖屏 / 手机 / 短故事）
 *   "4:3"   1440×1080（老投影 / 经典 PPT）
 * CSS 通过 attribute selector 直接派发 --deck-w / --deck-h，无需 JS 设。
 *
 * iframe + standalone 行为一致（不再 window!==top 早退）：
 *   - frame 包装在 iframe 内也跑，preview 跟离线打开渲染一致
 *   - parent CanvasFrame 把 iframe 元素本身固定为 deck 比例 logical viewport，
 *     再用 CSS transform 缩放 iframe 元素到 wrap 大小
 *
 * 三个调用方共享：
 *   - exports.js `injectViewportFit`（非 hybrid 导出薄包装）
 *   - exports/build-standalone.js（hybrid 导出主路径）
 *   - canvas.js GET /canvas（preview iframe 路径）
 */

import { ASPECT_PRESETS, DEFAULT_ASPECT } from '../shared/deck.js';

/**
 * 返回 fit script 内容（不含 <script> tag）
 * 只做 frame 包装，CSS var 派发由 fitStyleTag 的 attribute selector 直接处理
 *
 * @returns {string}
 */
export function fitScriptCode() {
  return `(function(){
  var body = document.body;
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

  // 演讲模式 — F 键切换浏览器 fullscreen
  // 16:9 显示器进 fullscreen 后浏览器 chrome 退场，可视区 = 物理屏 = 画布比例 → 黑边消失
  // ESC 退出由 Fullscreen API 自带，不重复绑（避免干扰其他用 ESC 的内容）
  // input guard 跟 navigation script 一致，防输入框冲突
  document.addEventListener('keydown', function(e){
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
    }
  });
})();`;
}

/**
 * 返回 fit 配套 <style> tag（含 wrapping tag）
 *
 * 多比例 attribute selectors：wrap data-deck-aspect 决定 --deck-w / --deck-h
 * 不声明 = 默认 16:9 (1920×1080)
 *
 * !important 用在 layout reset 三条上：兼容老 canvas.html 自带的 wrap-level fit
 * CSS（body.__nd-fit-active flex+align-items:center / wrap width:1920px+transform 等），
 * 否则老 deck 在新 frame 范式下会被偏左渲染。新 deck 模板已不含老 CSS，无害。
 *
 * @returns {string}
 */
export function fitStyleTag() {
  // 把 ASPECT_PRESETS 编译成 attribute selector CSS（写死避免 JS 跑前 flash）
  const aspectRules = Object.entries(ASPECT_PRESETS).map(([key, dims]) =>
    `.__nd-deck-wrap[data-deck-aspect="${key}"] { --deck-w: ${dims.width}px; --deck-h: ${dims.height}px; }`
  ).join('\n');
  const def = ASPECT_PRESETS[DEFAULT_ASPECT];
  return `<style id="__nd-standard-fit-style">
:root {
  --deck-w: ${def.width}px;
  --deck-h: ${def.height}px;
  --nd-page-scale: min(calc(100vw / var(--deck-w)), calc(100vh / var(--deck-h)));
}
${aspectRules}
html, body { margin: 0; padding: 0; }
body.__nd-fit-active {
  display: block !important;
  /* letterbox 填充色：agent 可在 deck CSS 里覆盖 --nd-letterbox-bg
     默认继承 deck 主背景 var(--bg)，无 --bg 时兜底黑色（演讲投影标准） */
  background: var(--nd-letterbox-bg, var(--bg, #000));
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
  /* 跟 body 同源 letterbox 色（inherit 在 background 上不会跨级，必须显式重写） */
  background: var(--nd-letterbox-bg, var(--bg, #000));
}
.__nd-page-frame > section[data-page] {
  flex-shrink: 0;
  width: var(--deck-w);
  height: var(--deck-h);
  transform-origin: center center;
  transform: scale(var(--nd-page-scale));
  position: relative;
}

/* 演讲模式 — 隐藏视口滚动条（root + body 双挂以覆盖渲染差异）
   N×100vh 的 page frame 总高度让 root element 自然出滚动条；
   :has() 把规则挂到 <html> 是关键（滚动条真正所在的元素）。
   兼容：Chrome 105+ / Safari 15.4+ / Firefox 121+，零 fallback 代价。 */
html:has(body.__nd-fit-active),
body.__nd-fit-active {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
html:has(body.__nd-fit-active)::-webkit-scrollbar,
body.__nd-fit-active::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
</style>`;
}

/**
 * 返回完整 <script>+<style> 注入块（最常用形态）
 *
 * @returns {string}
 */
export function fitInjectionBlock() {
  return `<script id="__nd-standard-fit" data-nodesign-keep="fit">
${fitScriptCode()}
</script>
${fitStyleTag()}`;
}
