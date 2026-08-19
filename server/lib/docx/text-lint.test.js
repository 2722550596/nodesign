import { describe, it, expect } from 'vitest';
import { lintDocxSource, formatLint } from './text-lint.js';
import { PRESETS } from './tokens.js';

/**
 * 这套盯的是三条设计红线有没有守住：
 *   1. 高精度 —— 每条规则都要有"看着像但不该报"的反例
 *   2. 一致性类全文聚合 —— 全文统一（哪怕统一成"不规范"的那种）不报
 *   3. 词典条目自己必须干净 —— 规则定规范，预置遵守；预置报警 = 每次构建都在
 *      教 agent 忽略警报
 */

const T = PRESETS['办公标准']();
const lint = (content, opts) => lintDocxSource({ tokens: T, content, opts });
const p = (text) => ({ t: 'p', text });

describe('错误档（基本可断定是错的）', () => {
  it('重复标点报、修辞叠用不报', () => {
    const r = lint([p('这里写完了。。然后继续')]);
    expect(r.errors.join()).toContain('重复标点');
    expect(lint([p('真的吗！！')]).errors).toEqual([]);   // ！的叠用是修辞
    expect(lint([p('省略号……也不该报')]).errors).toEqual([]);
  });

  it('括号全半角不配对', () => {
    expect(lint([p('（这是中文括号)')]).errors.join()).toContain('括号全半角');
    expect(lint([p('（配对的）和 (paired)')]).errors).toEqual([]);
  });

  it('中文后跟半角标点报；西文语境不报', () => {
    expect(lint([p('第一,第二')]).errors.join()).toContain('半角标点');
    expect(lint([p('用了 Node.js, Express 和 React')]).errors).toEqual([]);
    expect(lint([p('时间是 12:30 开始')]).errors).toEqual([]);
  });
});

describe('建议档：单点惯例', () => {
  it('数字紧贴单位报；已留空 / 歧义单位不报', () => {
    const r = lint([p('首屏 150ms 内出来')]);
    expect(r.notes.join()).toContain('150ms');
    expect(lint([p('首屏 150 ms 内')]).notes).toEqual([]);
    expect(lint([p('那是 80s 的老歌')]).notes).toEqual([]);      // 裸 s 不在单位表
    expect(lint([p('内存 8GBx2')]).notes).toEqual([]);           // 后面还有字母 = 不是单位结尾
  });
});

describe('建议档：一致性类（全文聚合，并存才报）', () => {
  it('中西文空格：多数派有空格时点名少数派；全文都不空 = 自洽风格不报', () => {
    const mixed = lint([
      p('使用 React 和 Node 做了 三个 project 的 demo'),   // 多处带空格
      p('还有一个用Vue写的'),                              // 少数派
    ]);
    expect(mixed.notes.join()).toContain('不一致');
    expect(mixed.notes.join()).toContain('Vue');
    const uniform = lint([p('全文都是中文紧贴English的风格'), p('另一处也紧贴Vue')]);
    expect(uniform.notes.filter(n => n.includes('中西文'))).toEqual([]);
  });

  it('斜杠风格：两种并存报少数派；统一不报；URL 和日期数字不算', () => {
    const mixed = lint([p('画布 / 参数面板 / 便签'), p('用 Python/FastAPI 开发')]);
    expect(mixed.notes.join()).toContain('斜杠');
    const uniform = lint([p('Python/FastAPI 和 TypeScript/Node')]);
    expect(uniform.notes.filter(n => n.includes('斜杠'))).toEqual([]);
    const excluded = lint([p('见 https://a.com/b/c 和日期 03/07'), p('对比 甲 / 乙')]);
    expect(excluded.notes.filter(n => n.includes('斜杠'))).toEqual([]);
  });

  it('日期范围连接号：混用报、统一（哪怕统一用连字符）不报', () => {
    const mixed = lint([p('2024.03 - 2024.07'), p('2025.01—2025.06')]);
    expect(mixed.notes.join()).toContain('连接号');
    const uniform = lint([p('2024.03 - 2024.07'), p('2025.01 - 至今')]);
    expect(uniform.notes.filter(n => n.includes('连接号'))).toEqual([]);
  });

  it('run 边界处的间距问题也查得到（先拼段落再扫）', () => {
    const r = lint([
      p('前面 A 和 B 都有空格 OK 的'),
      { t: 'p', runs: ['联系我：', { text: 'github.com', link: 'https://github.com' }] },
      { t: 'p', runs: ['紧贴的', { text: 'English', bold: true }] },
    ]);
    expect(r.notes.join()).toContain('content[2]');   // 定位到 run 拆开的那一段
  });
});

describe('版式断言（token 层）', () => {
  it('行距倍数 < 1 是错误档', () => {
    const tok = PRESETS['办公标准']();
    tok.styles.Normal.para.spacing = { line: 0.8, lineRule: 'multiple' };
    const r = lintDocxSource({ tokens: tok, content: [p('x')] });
    expect(r.errors.join()).toContain('叠压');
  });

  it('有 outlineLevel 的标题缺 keepNext 提醒', () => {
    const tok = PRESETS['办公标准']();
    tok.styles.MyTitle = { type: 'paragraph', name: 'MyTitle', para: { outlineLevel: 0 } };
    const r = lintDocxSource({ tokens: tok, content: [p('x')] });
    expect(r.notes.join()).toContain('MyTitle');
  });

  it('标题层级字号倒挂提醒', () => {
    const tok = PRESETS['办公标准']();
    tok.styles.Heading2.run.sizePt = 22;   // 比 Heading1（三号=16pt）还大
    const r = lintDocxSource({ tokens: tok, content: [p('x')] });
    expect(r.notes.join()).toContain('倒挂');
  });

  it('⭐三个词典条目自己全干净（预置报警 = 教 agent 忽略警报）', () => {
    for (const name of Object.keys(PRESETS)) {
      const r = lintDocxSource({ tokens: PRESETS[name](), content: [p('正文一段。')] });
      expect(r.errors, name).toEqual([]);
      expect(r.notes, name).toEqual([]);
    }
  });
});

describe('formatLint', () => {
  it('全干净时一个字都不占', () => {
    expect(formatLint({ errors: [], notes: [] })).toBe('');
  });
  it('超出上限收成「另有 N 条」', () => {
    const out = formatLint({ errors: ['a'], notes: Array.from({ length: 15 }, (_, i) => `n${i}`) }, 5);
    expect(out).toContain('另有 11 条');
  });
});
