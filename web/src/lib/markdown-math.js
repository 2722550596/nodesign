/**
 * markdown-math —— 全站 markdown 的公式支持（2026-08-15）
 *
 * 一处定义、四处用（聊天正文、舞台卡的子代理结果、.md 阅读器、方案评审卡）：
 * `<ReactMarkdown {...MATH_PLUGINS}>{normalizeMath(text)}</ReactMarkdown>`。
 * katex 的 CSS 和字体在这儿 import，打进包不吃 CDN；字体是按需加载的，
 * 没公式的页面不会去取。
 *
 * ⭐ 美元符号的取舍（这个产品满屏都是「$0.75 / $3.75 每百万」这种价钱）：
 *   - 行内公式**不认单美元**（singleDollarTextMath: false）。一开单美元，两个
 *     价钱之间那段文字就被当公式吃掉，账目直接烂给用户看。
 *   - 模型常写的 `\( … \)` / `\[ … \]` 在进 markdown 前换成 `$$ … $$` —— 前者
 *     留在行内（math text），后者独占段落（math flow）。于是"模型写 LaTeX 括号"
 *     和"用户写 $$"两条路都通，而单美元照旧是钱。
 *   - 换写法只在**代码之外**做：围栏代码块和行内 code 里的 `\(` 是代码不是公式。
 */
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

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

/**
 * 直接摊给 ReactMarkdown 的插件对。
 * throwOnError:false —— 模型写错的公式显示成红字就够了，不该炸掉整条消息/整张卡。
 *
 * ## remark-gfm（2026-08-17 补）
 *
 * react-markdown 默认只认 **CommonMark**，而 CommonMark 里没有表格。用户报的
 * 「AI 侧边栏 markdown 显示不全，表格渲染不出来」就是这个 —— 表格源码原样躺在
 * 那儿。同一批缺的还有：删除线 `~~x~~`、任务列表 `- [ ]`、裸链接自动成链、
 * 脚注。模型写这几样是家常便饭，缺一样就是"它答对了但我看不懂"。
 *
 * ⚠️ **gfm 要排在 math 前面**。两个插件都要动 `~` 和 `$` 附近的文本：gfm 先把
 * 表格和删除线切成节点，math 再在剩下的文本里找公式；反过来的话表格分隔行里的
 * 内容有机会先被别的规则吃掉。顺序在这种插件链里是语义不是风格。
 */
export const MATH_PLUGINS = Object.freeze({
  remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: false }]],
  rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]],
});
