import { describe, it, expect } from 'vitest';
import { splitNoteFaces, faceParts } from './note-faces.js';

describe('splitNoteFaces', () => {
  it('无分隔符 = 单面', () => {
    expect(splitNoteFaces('# 甲\n正文')).toEqual(['# 甲\n正文']);
  });
  it('\\n---\\n 分面，空面丢弃', () => {
    const faces = splitNoteFaces('# 一\n甲\n\n---\n\n# 二\n乙\n\n---\n\n');
    expect(faces).toHaveLength(2);
    expect(faces[1]).toBe('# 二\n乙');
  });
  it('CRLF 归一化', () => {
    expect(splitNoteFaces('a\r\n---\r\nb')).toEqual(['a', 'b']);
  });
  it('空输入返回一张空面', () => {
    expect(splitNoteFaces('')).toEqual(['']);
  });
});

describe('faceParts', () => {
  it('抽首行标题', () => {
    expect(faceParts('# 主色定稿\n因为品牌要蓝')).toEqual({ title: '主色定稿', body: '因为品牌要蓝' });
  });
  it('无标题整段当正文', () => {
    expect(faceParts('就一句话')).toEqual({ title: null, body: '就一句话' });
  });
  it('## 不算贴面标题', () => {
    expect(faceParts('## 小节\nx').title).toBeNull();
  });
});
