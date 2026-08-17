/**
 * MarkdownMath —— 认公式、认 GFM 的 ReactMarkdown（2026-08-15；表格 2026-08-17 补）
 *
 * 全站凡是渲染 markdown 的地方都换成它：聊天正文、舞台卡的子代理结果、
 * .md 阅读器、方案评审卡。规矩（单美元是钱不是公式、`\( \)` 怎么换、gfm 排在
 * math 前面）在 lib/markdown-math.js，这里只是把"插件 + 归一"这两步绑成一件
 * 东西 —— 分开摆就有人只记得挂插件、忘了归一，那种半通不通最难查。
 *
 * ## 表格是这层唯一带样式的东西，为什么
 *
 * 原本这层刻意不带任何 CSS（排版按各家容器自己来）。表格破这个例，因为它要的
 * 不是皮而是**结构**：窄容器（AI 侧栏才 ~420px）里一张表必须能横向滚，而
 * `overflow-x` 加在 `<table>` 自己身上不生效 —— 得在外面套一层。套层这件事
 * CSS 做不到，只能在渲染时做，于是它天然属于这里。
 *
 * 顺手把线也画了：四个使用处各写一遍表格样式就是四份会分叉的真相，而表格长
 * 什么样跟"这是聊天还是阅读器"无关。线用发丝级、不描外框、不斑马纹 —— 跟全站
 * 「无彩交互、只用墨阶」一致。
 */
import ReactMarkdown from 'react-markdown';
import { MATH_PLUGINS, normalizeMath } from '../../lib/markdown-math.js';
import { COLOR, GAP } from '../../lib/theme.js';

/**
 * ⚠️ `width:100%` 而不是 `max-content`：模型写的表大多是两三列短值，撑满容器
 * 更好读；单元格照常换行。外面那层滚动是给**列特别多**的表兜底的，不是常态。
 */
const COMPONENTS = {
  table: ({ node, ...props }) => (
    <div style={{ overflowX: 'auto', margin: `0 0 ${GAP.md}px 0` }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'inherit' }} {...props} />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th style={{
      textAlign: 'left', fontWeight: 600, color: COLOR.text,
      padding: `${GAP.xs}px ${GAP.sm}px`,
      borderBottom: `1px solid ${COLOR.borderMd}`,
      whiteSpace: 'nowrap',
    }} {...props} />
  ),
  td: ({ node, ...props }) => (
    <td style={{
      color: COLOR.text2, verticalAlign: 'top',
      padding: `${GAP.xs}px ${GAP.sm}px`,
      borderBottom: `1px solid ${COLOR.borderLt}`,
    }} {...props} />
  ),
  /**
   * 任务列表（gfm 一起带来的）。remark-gfm 会给这种 li 打上 `task-list-item`，
   * 拿它把圆点去掉 —— 勾选框已经是那个位置的记号了，再顶一个圆点是两个记号
   * 说同一件事。缩回去的那一格是 ul 的 padding，不摘的话勾选框会比普通条目
   * 缩进得更深。
   */
  li: ({ node, className, ...props }) => (
    className?.includes('task-list-item')
      ? <li className={className} style={{ listStyle: 'none', marginLeft: `-${GAP.lg}px` }} {...props} />
      : <li className={className} {...props} />
  ),
  // 默认那个勾选框在纸面上又蓝又大，压小并去掉指针
  input: ({ node, ...props }) => (
    props.type === 'checkbox'
      ? <input {...props} readOnly style={{ marginRight: GAP.xs, accentColor: COLOR.text, cursor: 'default' }} />
      : <input {...props} />
  ),
};

export default function MarkdownMath({ children }) {
  return (
    <ReactMarkdown {...MATH_PLUGINS} components={COMPONENTS}>
      {normalizeMath(children)}
    </ReactMarkdown>
  );
}
