/**
 * server/shared/deck.js — deck 设计坐标系常量（single source of truth）
 *
 * 默认 1920×1080（16:9 PPT 标准）；4 档预设 ASPECT_PRESETS 可选。所有需要
 * playwright headless 渲染 deck 的代码（exports / mcp tools / probe scripts）
 * 都从这里读，将来再调只改一处。
 *
 * deck 比例由 wrap.dataset.deckAspect 决定（agent 在 canvas.html 里声明）：
 *   "16:9"   默认横屏（1920×1080）演讲 / 文档 / scrollytelling
 *   "16:10"  宽屏笔电 / Mac 屏（1920×1200）介于 16:9 和 4:3 之间
 *   "9:16"   竖屏（1080×1920）手机宣发 / 短故事 / 直播 cover
 *   "4:3"    老投影 / 经典 PPT 投影仪适配（1440×1080）
 *
 * 用户面（浏览器自适应 / iframe 预览）通过 CSS 自适应 scale 让任意视口都满铺；
 * Playwright 渲染按 deck 比例设 viewport，scale=1 自然渲染。
 */

export const ASPECT_PRESETS = Object.freeze({
  '16:9':  Object.freeze({ width: 1920, height: 1080 }),
  '16:10': Object.freeze({ width: 1920, height: 1200 }),
  '9:16':  Object.freeze({ width: 1080, height: 1920 }),
  '4:3':   Object.freeze({ width: 1440, height: 1080 }),
});

export const DEFAULT_ASPECT = '16:9';

export const DECK = ASPECT_PRESETS[DEFAULT_ASPECT];

/**
 * 解析 aspect 字符串到 { width, height }，未知值 fallback 默认 16:9。
 *
 * @param {string|null|undefined} aspect
 * @returns {{ width: number, height: number, key: string }}
 */
export function resolveDeckSize(aspect) {
  const key = ASPECT_PRESETS[aspect] ? aspect : DEFAULT_ASPECT;
  const dims = ASPECT_PRESETS[key];
  return { width: dims.width, height: dims.height, key };
}

/**
 * 从 canvas.html 内容里抽 wrap data-deck-aspect 值。
 * 找不到 / 无效值 → 返回 DEFAULT_ASPECT。仅做轻量 grep，不上 cheerio。
 *
 * @param {string} html
 * @returns {string} aspect key (ASPECT_PRESETS 的键)
 */
export function extractDeckAspect(html) {
  if (!html || typeof html !== 'string') return DEFAULT_ASPECT;
  const m = html.match(/<div\b[^>]*class\s*=\s*['"][^'"]*__nd-deck-wrap[^'"]*['"][^>]*data-deck-aspect\s*=\s*['"]([^'"]+)['"]/i)
        || html.match(/<div\b[^>]*data-deck-aspect\s*=\s*['"]([^'"]+)['"][^>]*class\s*=\s*['"][^'"]*__nd-deck-wrap[^'"]*['"]/i);
  if (!m) return DEFAULT_ASPECT;
  return ASPECT_PRESETS[m[1]] ? m[1] : DEFAULT_ASPECT;
}
