// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { findElementByAnchor, serializeAnchor, serializeStableAnchor } from './html-utils.js';

/** 复刻出问题那一页的结构：一个头像 div + 若干张同构卡片 */
function buildPage() {
  document.body.innerHTML = `
    <main><section><div class="wrap">
      <div class="portrait"><img alt="p"></div>
      <div class="trait"><h3>沉稳淡定</h3><p>a</p></div>
      <div class="trait"><h3>高傲自恋</h3><p>b</p></div>
      <div class="trait"><h3>腹黑毒舌</h3><p>c</p></div>
      <div class="trait"><h3>温柔暖心</h3><p>d</p></div>
    </div></section></main>`;
  return document.body;
}
const h3 = (t) => [...document.querySelectorAll('h3')].find(e => e.textContent === t);

describe('锚点在 DOM 被搬动之后还能不能指对', () => {
  beforeEach(buildPage);

  it('不动 DOM 时 path 就够用', () => {
    const a = serializeAnchor(h3('腹黑毒舌'));
    expect(findElementByAnchor(a, document.body).textContent).toBe('腹黑毒舌');
  });

  it('前面插进一个兄弟节点 → 纯 path 会指到邻居，textHint 兜住', () => {
    const a = serializeAnchor(h3('腹黑毒舌'));
    const wrap = document.querySelector('.wrap');
    wrap.insertBefore(document.createElement('div'), wrap.firstElementChild);
    // path 现在指向「高傲自恋」那张；带上 textHint 校验后应当纠正回来
    expect(document.body.querySelector(a.path).textContent).toBe('高傲自恋');
    expect(findElementByAnchor(a, document.body).textContent).toBe('腹黑毒舌');
  });

  it('拖拽搬走一个兄弟 → 同样纠正', () => {
    const a = serializeAnchor(h3('温柔暖心'));
    const wrap = document.querySelector('.wrap');
    wrap.removeChild(wrap.children[1]);
    expect(findElementByAnchor(a, document.body).textContent).toBe('温柔暖心');
  });

  it('稳定锚点盖了 data-anchor，DOM 怎么搬都命中', () => {
    const el = h3('腹黑毒舌');
    const a = serializeStableAnchor(el);
    expect(a.dataId).toBeTruthy();
    const wrap = document.querySelector('.wrap');
    wrap.insertBefore(document.createElement('div'), wrap.firstElementChild);
    wrap.appendChild(wrap.children[2]);   // 再搬一次
    expect(findElementByAnchor(a, document.body)).toBe(el);
  });

  it('同一个元素重复取稳定锚点，id 不变', () => {
    const el = h3('高傲自恋');
    expect(serializeStableAnchor(el).dataId).toBe(serializeStableAnchor(el).dataId);
  });

  it('文本自己被改过（评论后又改字）时不误判：前缀关系仍认', () => {
    const a = serializeAnchor(h3('腹黑毒舌'));
    h3('腹黑毒舌').textContent = '腹黑毒舌（改）';
    expect(findElementByAnchor(a, document.body).textContent).toBe('腹黑毒舌（改）');
  });
});
