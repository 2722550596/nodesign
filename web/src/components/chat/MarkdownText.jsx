/**
 * MarkdownText —— 聊天正文的 markdown 渲染（2026-08-15 从 Message.jsx 拆出，
 * 顺手把 LaTeX 装上）。
 *
 * 公式的规矩不在这儿，在 lib/markdown-math.js（全站一处定义：聊天正文、舞台卡、
 * .md 阅读器、方案评审卡都用同一对插件和同一套美元符号取舍）。这里只管聊天流
 * 里的排版。
 */
import MarkdownMath from '../ui/MarkdownMath.jsx';
import { COLOR, GAP, RADIUS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';

export default function MarkdownText({ children }) {
  return (
    <>
      <div className="md-content">
        <MarkdownMath>{children || ''}</MarkdownMath>
      </div>
      <style>{`
        .md-content p { margin: 0 0 ${GAP.md}px 0; }
        .md-content p:last-child { margin-bottom: 0; }
        .md-content code { background: rgba(43,33,23,0.06); padding: 1px 5px; border-radius: ${RADIUS.xs}px; font-family: ${FONT_MONO}; font-size: ${FONT_SIZE.md}px; }
        .md-content pre { background: ${COLOR.bgCard}; padding: ${GAP.lg}px; border-radius: ${RADIUS.lg}px; overflow-x: auto; font-size: ${FONT_SIZE.md}px; }
        .md-content ul, .md-content ol { margin: 0 0 ${GAP.md}px 0; padding-left: ${GAP.xxl}px; }
        .md-content li { margin: ${GAP.xxs}px 0; }
        .md-content a { color: ${COLOR.btn}; text-decoration: underline; }
        /* 正文里的公式比周围字略大一点才不显小气；块级公式的滚动和留白走全局 */
        .md-content .katex { font-size: 1.06em; }
      `}</style>
    </>
  );
}
