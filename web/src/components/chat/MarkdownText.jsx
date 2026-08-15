/**
 * MarkdownText —— 聊天正文的 markdown 渲染（2026-08-15 从 Message.jsx 拆出，
 * 顺手把 LaTeX 装上）。
 *
 * 公式走 remark-math + rehype-katex，字体和 CSS 全打进包 —— 不吃 CDN，断网也认。
 *
 * ⭐ 美元符号的取舍（这个产品满屏都是「$0.75 / $3.75 每百万」这种价钱）：
 *   - 行内公式**不认单美元**（singleDollarTextMath: false）。一开单美元，两个
 *     价钱之间那段文字就被当公式吃掉，账目直接烂给用户看。
 *   - 模型常写的 `\( … \)` / `\[ … \]` 在进 markdown 前换成 `$$ … $$` —— 前者
 *     留在行内（math text），后者独占段落（math flow）。于是"模型写 LaTeX 括号"
 *     和"用户写 $$"两条路都通，而单美元照旧是钱。
 *   - 换写法只在**代码之外**做：围栏代码块和行内 code 里的 `\(` 是代码不是公式。
 */
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { COLOR, GAP, RADIUS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';

/** 围栏代码块 / 行内 code：这些片段原样留着，别在里面动手 */
const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/** `\( … \)` → 行内 `$$ … $$`；`\[ … \]` → 独占一段的 `$$ … $$` */
function convertDelimiters(seg) {
  return seg
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$$${body.trim()}$$`);
}

/** 只在代码之外换公式写法（导出给测试钉住这条边界） */
export function normalizeMath(text) {
  const s = String(text ?? '');
  if (!s.includes('\\(') && !s.includes('\\[')) return s;
  return s.split(CODE_SPANS).map((seg, i) => (i % 2 ? seg : convertDelimiters(seg))).join('');
}

const REMARK = [[remarkMath, { singleDollarTextMath: false }]];
// throwOnError:false —— 模型写错的公式在聊天里显示成红字就够了，不该炸掉整条消息
const REHYPE = [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]];

export default function MarkdownText({ children }) {
  return (
    <>
      <div className="md-content">
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>
          {normalizeMath(children)}
        </ReactMarkdown>
      </div>
      <style>{`
        .md-content p { margin: 0 0 ${GAP.md}px 0; }
        .md-content p:last-child { margin-bottom: 0; }
        .md-content code { background: rgba(43,33,23,0.06); padding: 1px 5px; border-radius: ${RADIUS.xs}px; font-family: ${FONT_MONO}; font-size: ${FONT_SIZE.md}px; }
        .md-content pre { background: ${COLOR.bgCard}; padding: ${GAP.lg}px; border-radius: ${RADIUS.lg}px; overflow-x: auto; font-size: ${FONT_SIZE.md}px; }
        .md-content ul, .md-content ol { margin: 0 0 ${GAP.md}px 0; padding-left: ${GAP.xxl}px; }
        .md-content li { margin: ${GAP.xxs}px 0; }
        .md-content a { color: ${COLOR.btn}; text-decoration: underline; }
        /* 公式：katex 自带的样式管排版，这里只管它在聊天流里的行为 ——
           长公式横向滚动（别把侧栏撑破），块级公式上下留一口气 */
        .md-content .katex-display { margin: ${GAP.md}px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
        .md-content .katex { font-size: 1.06em; }
        .md-content .katex-error { color: ${COLOR.btn}; font-family: ${FONT_MONO}; font-size: ${FONT_SIZE.sm}px; }
      `}</style>
    </>
  );
}
