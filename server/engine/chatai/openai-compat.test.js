// 中转站「流式抗截断」的 [done] 收尾标记（2026-08-15 实测：claude 变体流式必带，
// 而且是跨分片来的 —— 尾三片实测 "。\n\n[" + "done]"）。不摘就演给用户看还写进记录。
import { describe, it, expect } from 'vitest';
import { stripSentinel, makeTailFilter } from './openai-compat.js';

function 跑(pieces) {
  const 发出 = [];
  const t = makeTailFilter((s) => 发出.push(s));
  for (const p of pieces) t.push(p);
  return { 全文: t.end(), 发出: 发出.join('') };
}

describe('[done] 收尾标记', () => {
  it('跨分片的标记也摘干净，且一个字都没提前发出去', () => {
    const r = 跑(['雾夜里灯亮着，', '摊主抬起头。', '\n\n[', 'done]']);
    expect(r.全文).toBe('雾夜里灯亮着，摊主抬起头。');
    expect(r.发出).toBe(r.全文);            // 流出去的和落盘的是同一段
  });

  it('没有标记的正常回复一字不动', () => {
    const r = 跑(['雾夜里灯亮着，', '摊主抬起头。']);
    expect(r.全文).toBe('雾夜里灯亮着，摊主抬起头。');
    expect(r.发出).toBe(r.全文);
  });

  it('只出现在末尾才算标记：正文里的 [done] 留着', () => {
    expect(stripSentinel('他说「[done]」，然后走了。')).toBe('他说「[done]」，然后走了。');
    expect(stripSentinel('收工。\n\n[done]')).toBe('收工。');
    expect(stripSentinel('收工。[done]\n')).toBe('收工。');
    expect(stripSentinel('')).toBe('');
  });

  it('分片再碎也不会把标记漏出去', () => {
    const r = 跑('好的。\n\n[done]'.split(''));
    expect(r.全文).toBe('好的。');
    expect(r.发出).toBe('好的。');
  });
});
