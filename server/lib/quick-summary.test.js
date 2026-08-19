// 精灵短句的整形（2026-08-15）：haiku 精修那条腿 08-19 拆掉后，画布上写的只剩它
import { describe, it, expect } from 'vitest';
import { clampFirstClause, sanitizeLine } from './quick-summary.js';

describe('首句底稿', () => {
  it('剥掉开头的应答词，留下"在干什么"那半句', () => {
    expect(clampFirstClause('好的，我来把海报配色调暖一点。剩下的等会儿说。')).toBe('我来把海报配色调暖一点。');
    expect(clampFirstClause('明白了，先查登录失败的原因。')).toBe('先查登录失败的原因。');
    expect(clampFirstClause('没问题！这就导出三张封面。')).toBe('这就导出三张封面。');
    // 「你说得对」这类附和也算应答词：剥了才不像在跟用户搭话（第一人称那批的同族）
    expect(clampFirstClause('你说得对，登录失败是 cookie 的问题。')).toBe('登录失败是 cookie 的问题。');
  });

  it('整句就是应答词时不剥成空的', () => {
    expect(clampFirstClause('好的。')).toBe('好的。');
  });

  it('只取第一小句并硬截', () => {
    expect(clampFirstClause('第一句。第二句。')).toBe('第一句。');
    expect(clampFirstClause('一'.repeat(40))).toHaveLength(26);
  });

  it('整形：一行、去引号、空输入给空串', () => {
    expect(sanitizeLine('「 带引号\n的两行 」')).toBe('带引号 的两行');
    expect(clampFirstClause('')).toBe('');
    expect(clampFirstClause(null)).toBe('');
  });
});
