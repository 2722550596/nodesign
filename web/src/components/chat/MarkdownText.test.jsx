// @vitest-environment happy-dom
// 聊天正文的公式渲染（2026-08-15）：模型写的 LaTeX 要出来，价钱不许被当公式吃掉
import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import MarkdownText, { normalizeMath } from './MarkdownText.jsx';

function render(md) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<MarkdownText>{md}</MarkdownText>); });
  // 只看正文那块：组件自带的 <style> 里就有 katex 选择器，连样式一起断言等于白断言
  const html = host.querySelector('.md-content').innerHTML;
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
