// @vitest-environment happy-dom
// 全站 markdown 的公式支持（2026-08-15）：模型写的 LaTeX 要出来，价钱不许被当公式吃掉
import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import MarkdownMath from '../components/ui/MarkdownMath.jsx';
import { normalizeMath } from './markdown-math.js';

function render(md) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<MarkdownMath>{md}</MarkdownMath>); });
  const html = host.innerHTML;
  act(() => { root.unmount(); });
  host.remove();
  return html;
}

describe('公式写法归一', () => {
  it('\\( \\) 进行内、\\[ \\] 独占一段', () => {
    expect(normalizeMath('勾股 \\(a^2+b^2=c^2\\) 就这样')).toBe('勾股 $$a^2+b^2=c^2$$ 就这样');
    expect(normalizeMath('看：\\[x=1\\]')).toContain('\n\n$$\nx=1\n$$\n\n');
  });

  it('代码里的反斜杠括号不动', () => {
    const src = '行内 `\\(a\\)` 和围栏：\n```py\nprint("\\(x\\)")\n```';
    expect(normalizeMath(src)).toBe(src);
  });

  it('没有 LaTeX 括号就原样返回（不白跑正则）', () => {
    expect(normalizeMath('一句普通的话')).toBe('一句普通的话');
    expect(normalizeMath(null)).toBe('');
  });
});

describe('渲染', () => {
  it('行内与块级公式都出 katex', () => {
    expect(render('质能 \\(E=mc^2\\) 方程')).toContain('katex');
    expect(render('$$\n\\frac{1}{3}\n$$')).toContain('katex-display');
  });

  it('⭐ 价钱不是公式：单美元原样留着', () => {
    const html = render('一轮约 $0.75 / $3.75 每百万 token');
    expect(html).not.toContain('katex');
    expect(html).toContain('$0.75');
    expect(html).toContain('$3.75');
  });

  it('写坏的公式只红一行，不炸整条消息', () => {
    const html = render('坏的 \\(\\frac{1\\) 后面还有话');
    expect(html).toContain('后面还有话');
  });

  it('普通 markdown 照旧', () => {
    const html = render('**粗**与 `码`\n\n- 一\n- 二');
    expect(html).toContain('<strong>');
    expect(html).toContain('<code>');
    expect(html).toContain('<li>');
  });
});

/**
 * GFM（2026-08-17）。用户报「AI 侧边栏 markdown 显示不全，表格渲染不出来」——
 * react-markdown 默认只认 CommonMark，而 CommonMark 里**没有表格**，源码原样躺着。
 * 同一批缺的还有删除线、任务列表、裸链接。模型写这几样是家常便饭。
 *
 * 钉在这儿而不是某个使用处：四个渲染点共用同一对插件，这一层通了就都通了。
 */
describe('GFM', () => {
  const TABLE = ['| 档位 | 单价 |', '| --- | --- |', '| Sonnet | $3 |', '| Opus | $15 |'].join('\n');

  it('表格渲染成真表格，不是一坨竖线', () => {
    const html = render(TABLE);
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('Sonnet');
    // 没接 gfm 时这里会是一整段带 | 的纯文本
    expect(html).not.toContain('| --- |');
  });

  it('窄容器里表格能横向滚 —— 外面那层是渲染时套的，CSS 套不出来', () => {
    expect(render(TABLE)).toMatch(/<div[^>]*overflow-x: ?auto/);
  });

  it('删除线 / 任务列表 / 裸链接一起认', () => {
    expect(render('~~算了~~')).toContain('<del>');
    expect(render('- [x] 已上线\n- [ ] 还没做')).toContain('type="checkbox"');
    expect(render('见 https://nodesign.xiaobuyu.trade 这里')).toContain('<a href="https://nodesign.xiaobuyu.trade"');
  });

  it('⭐ 表格里的价钱还是钱，不许被当公式吃掉', () => {
    const html = render(TABLE);
    expect(html).toContain('$3');
    expect(html).toContain('$15');
    expect(html).not.toContain('katex');
  });
});
