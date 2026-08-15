// @vitest-environment happy-dom
// 演出页隐私序列化（2026-08-15）：发给 agent 的标注剥文本留结构
import { describe, it, expect, afterEach } from 'vitest';
import { serializeForAI, redactAnchor, isPrivacyDoc } from './element-semantics.js';

function 搭台(withMeta) {
  document.head.innerHTML = withMeta ? '<meta name="nd-privacy" content="演出">' : '';
  document.body.innerHTML = `
    <div id="台">
      <div class="回合 演出" data-anchor="a1">沈先生放下账本，看了你一眼。</div>
      <div class="回合 用户">「我找一本《铁流》。」</div>
    </div>`;
  return document.querySelector('[data-anchor="a1"]');
}
afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });

describe('演出页隐私序列化', () => {
  it('redactText:true —— outerHtml/textBrief/anchor.textHint 全剥，结构保留', () => {
    const el = 搭台(false);
    const s = serializeForAI(el, { redactText: true });
    expect(s.outerHtml).not.toContain('沈先生');
    expect(s.outerHtml).toContain('〔文');
    expect(s.outerHtml).toContain('data-anchor="a1"');          // 结构骨架还在
    expect(s.anchor.textHint).toMatch(/^〔文\d+字〕$/);
    for (const sib of s.siblings) expect(sib.textBrief).not.toContain('铁流');
    expect(s.隐私).toBeTruthy();
  });

  it('页面带 nd-privacy 标 —— 不传参也自动剥', () => {
    const el = 搭台(true);
    expect(isPrivacyDoc(document)).toBe(true);
    const s = serializeForAI(el);
    expect(s.outerHtml).not.toContain('沈先生');
  });

  it('普通页 —— 原文照发（行为不变）', () => {
    const el = 搭台(false);
    const s = serializeForAI(el);
    expect(s.outerHtml).toContain('沈先生');
    expect(s.anchor.textHint).toContain('沈先生');
    expect(s.隐私).toBeUndefined();
  });

  it('redactAnchor：textHint 换字数占位，其余字段原样', () => {
    const a = redactAnchor({ dataId: 'a1', path: 'div>div', textHint: '偷不得的台词', bbox: { x: 1 } });
    expect(a.textHint).toBe('〔文6字〕');
    expect(a.dataId).toBe('a1');
    expect(a.bbox).toEqual({ x: 1 });
  });
});
