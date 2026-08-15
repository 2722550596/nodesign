/**
 * MarkdownMath —— 认公式的 ReactMarkdown（2026-08-15）
 *
 * 全站凡是渲染 markdown 的地方都换成它：聊天正文、舞台卡的子代理结果、
 * .md 阅读器、方案评审卡。规矩（单美元是钱不是公式、`\( \)` 怎么换）在
 * lib/markdown-math.js，这里只是把"插件 + 归一"这两步绑成一件东西 ——
 * 分开摆就有人只记得挂插件、忘了归一，那种半通不通最难查。
 *
 * 排版按各家自己的容器样式来（这层不带任何 CSS），块级公式的滚动与留白
 * 走 globals.css 里的 .katex-display。
 */
import ReactMarkdown from 'react-markdown';
import { MATH_PLUGINS, normalizeMath } from '../../lib/markdown-math.js';

export default function MarkdownMath({ children }) {
  return <ReactMarkdown {...MATH_PLUGINS}>{normalizeMath(children)}</ReactMarkdown>;
}
