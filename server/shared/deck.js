/**
 * server/shared/deck.js — deck 设计坐标系常量（single source of truth）
 *
 * 1920×1080（PPT 标准 16:9，1080p）。所有需要 playwright headless 渲染 deck
 * 的代码（exports / mcp tools / probe scripts）都从这里读，将来再调一次只改一处。
 *
 * 用户面（浏览器自适应 / iframe 预览）通过 transform: scale wrapper 让任意视口
 * 都满铺 + 完整显示——但 chromium 渲染时 viewport 仍然是这个基线尺寸，
 * scale=1 自然渲染，截图 / PDF 都直出原生 1920×1080（@2x DPR → 3840×2160）。
 */

export const DECK = Object.freeze({
  width: 1920,
  height: 1080,
});
