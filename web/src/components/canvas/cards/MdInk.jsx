/**
 * MdInk —— 画布上的 markdown 文字（2026-08-23 黑板）
 *
 * 手写字对象多了一个 `format: 'md'` 档：agent（或用户）写在黑板上的不只是一句
 * 话，可以是要点列表、小表格、一行 KaTeX 公式、一段 mermaid 图。渲染器复用
 * 全站那份 MarkdownMath（公式规矩与单美元取舍都在 lib/markdown-math.js），
 * 这里只做两件事：
 *   1. 把排版收成"纸上的一块字"——没有卡片外观，字体/字号/墨色跟手写字同源
 *   2. ```mermaid 围栏交给懒加载的 Mermaid 组件（mermaid 包 1MB+，只有真遇到
 *      围栏才拉那片 chunk）
 *
 * mermaid 与画布原生「节点 + 线」的分工：要跟真实产物连线的用原生节点；时序图、
 * 状态机这种密而规整的才装进 mermaid 盒子。这条纪律写在 agent 的 prelude 里，
 * 不在这儿强制。
 */
import { lazy, Suspense, Children } from 'react';
import MarkdownMath from '../../ui/MarkdownMath.jsx';
import { COLOR, FONT_MONO, FONT_SIZE, GAP, RADIUS } from '../../../lib/theme.js';

const MermaidBlock = lazy(() => import('./MermaidBlock.jsx'));

function mermaidSourceOf(preChildren) {
  const kid = Children.toArray(preChildren)[0];
  const cls = kid?.props?.className || '';
  if (!/language-mermaid\b/.test(cls)) return null;
  const raw = kid.props.children;
  return Array.isArray(raw) ? raw.join('') : String(raw ?? '');
}

const COMPONENTS = {
  pre: ({ node, children, ...props }) => {
    const src = mermaidSourceOf(children);
    if (src !== null) {
      return (
        <Suspense fallback={<div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>图在画…</div>}>
          <MermaidBlock source={src} />
        </Suspense>
      );
    }
    return <pre {...props}>{children}</pre>;
  },
};

export default function MdInk({ text, fontFamily, fontSize, color }) {
  return (
    <>
      <div className="nd-mdink" style={{ fontFamily, fontSize, color, lineHeight: 1.6 }}>
        <MarkdownMath components={COMPONENTS}>{text || ''}</MarkdownMath>
      </div>
      <style>{`
        .nd-mdink p { margin: 0 0 ${GAP.sm}px 0; }
        .nd-mdink p:last-child, .nd-mdink ul:last-child, .nd-mdink ol:last-child { margin-bottom: 0; }
        .nd-mdink h1, .nd-mdink h2, .nd-mdink h3, .nd-mdink h4 { margin: 0 0 ${GAP.sm}px 0; line-height: 1.3; font-weight: 600; }
        .nd-mdink h1 { font-size: 1.45em; } .nd-mdink h2 { font-size: 1.25em; } .nd-mdink h3 { font-size: 1.1em; }
        .nd-mdink ul, .nd-mdink ol { margin: 0 0 ${GAP.sm}px 0; padding-left: 1.4em; }
        .nd-mdink li { margin: 2px 0; }
        .nd-mdink code { background: rgba(43,33,23,0.06); padding: 1px 5px; border-radius: ${RADIUS.xs}px; font-family: ${FONT_MONO}; font-size: 0.9em; }
        .nd-mdink pre { background: rgba(43,33,23,0.05); padding: ${GAP.sm}px ${GAP.md}px; border-radius: ${RADIUS.md}px; overflow-x: auto; font-size: 0.85em; }
        .nd-mdink pre code { background: none; padding: 0; }
        .nd-mdink blockquote { margin: 0 0 ${GAP.sm}px 0; padding-left: ${GAP.md}px; border-left: 2px solid rgba(43,33,23,0.25); color: inherit; opacity: .85; }
        .nd-mdink hr { border: 0; border-top: 1px solid rgba(43,33,23,0.22); margin: ${GAP.sm}px 0; }
        .nd-mdink a { color: inherit; text-decoration: underline; }
        .nd-mdink .katex { font-size: 1.04em; }
        .nd-mdink .katex-display { margin: ${GAP.sm}px 0; overflow-x: auto; overflow-y: hidden; }
      `}</style>
    </>
  );
}
