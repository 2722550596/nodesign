// 酒馆导出 JSON 的解析（2026-08-15）：认形态、摘结构、按需取正文
import { describe, it, expect } from 'vitest';
import { detectKind, digest, fetchEntries } from './tavern-json.js';

const 预设 = {
  temperature: 1, top_p: 1, openai_max_tokens: 30000, reasoning_effort: 'min',
  prompts: [
    { identifier: 'a', name: '主提示', role: 'system', content: '你在演一个摊主。' },
    { identifier: 'b', name: '🚢文风-顺眼舒服', role: 'system', content: '短句，少形容词。' },
    { identifier: 'c', name: '🎆文风-华丽', role: 'system', content: '堆意象。' },
    { identifier: 'd', name: '角色描述', role: 'system', content: '', marker: true },
    { identifier: 'e', name: '💡可选功能开始', role: 'system', content: '' },
    { identifier: 'f', name: '深度注入的小纸条', role: 'system', content: '记得留钩子。', injection_position: 1, injection_depth: 4 },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'a', enabled: true },
    { identifier: 'e', enabled: true },
    { identifier: 'b', enabled: true },
    { identifier: 'c', enabled: false },
    { identifier: 'd', enabled: true },
    { identifier: 'f', enabled: true },
  ] }],
};

const 角色卡 = {
  spec: 'chara_card_v2',
  data: {
    name: '沈砚', description: '旧书铺老板。', personality: '克制。', scenario: '民国末年。',
    first_mes: '「进来看看？」', mes_example: '<START>\n{{user}}: 你好', alternate_greetings: ['雨天版开场', '雪天版开场'],
    character_book: { entries: [
      { uid: 1, comment: '铺子布局', key: [], constant: true, content: '三面书架顶到梁。' },
      { uid: 2, comment: '暗巷', key: ['暗巷', '后门'], content: '巷子尽头有扇小门。' },
      { uid: 3, comment: '停用条', key: ['x'], enabled: false, content: '不该出现。' },
    ] },
  },
};

const 世界书 = { entries: { 0: { uid: 0, comment: '夜市', key: ['夜市'], content: '摊子沿河排开。' } } };

describe('认形态', () => {
  it('预设 / 角色卡 / 世界书 各认各的；普通 JSON 返回 null', () => {
    expect(detectKind(预设)).toBe('preset');
    expect(detectKind(角色卡)).toBe('card');
    expect(detectKind(世界书)).toBe('lorebook');
    expect(detectKind({ 随便: 1 })).toBeNull();
    expect(detectKind(null)).toBeNull();
  });
});

describe('预设摘要', () => {
  const d = digest(预设);
  it('只排 order 里的，启用停用分开', () => {
    expect(d.启用.map(e => e.名字)).toEqual(['主提示', '💡可选功能开始', '🚢文风-顺眼舒服', '角色描述', '深度注入的小纸条']);
    expect(d.停用.map(e => e.名字)).toEqual(['🎆文风-华丽']);
  });
  it('⚠️ marker 与分节标题分开标：都要丢，但不是一回事', () => {
    expect(d.占位条目).toEqual(['角色描述']);
    expect(d.分隔条目).toEqual(['💡可选功能开始']);
  });
  it('合计字数只算有正文的启用条；深度注入位记下来', () => {
    expect(d.合计字数).toBe('你在演一个摊主。'.length + '短句，少形容词。'.length + '记得留钩子。'.length);
    expect(d.启用.find(e => e.名字 === '深度注入的小纸条').深度).toBe(4);
  });
  it('参数带出来（我们没有对应旋钮，但要能照实告诉用户）', () => {
    expect(d.参数.最大输出).toBe(30000);
    expect(d.参数.reasoning_effort).toBe('min');
  });
});

describe('角色卡摘要', () => {
  const d = digest(角色卡);
  it('字段表 + 备选开场白 + 内嵌世界书', () => {
    expect(d.名字).toBe('沈砚');
    expect(d.字段.map(f => f.字段)).toContain('first_mes');
    expect(d.开场白备选).toBe(2);
    expect(d.世界书.find(e => e.名字 === '铺子布局').常驻).toBe(true);
    expect(d.世界书.find(e => e.名字 === '暗巷').触发).toEqual(['暗巷', '后门']);
    expect(d.世界书.find(e => e.名字 === '停用条').停用).toBe(true);
  });
});

describe('按需取正文', () => {
  it('预设按名字部分匹配（条目名带 emoji，别逼 agent 抄全名）', () => {
    const 出 = fetchEntries(预设, ['文风-顺眼', '主提示']);
    expect(出.map(e => e.名字)).toEqual(['🚢文风-顺眼舒服', '主提示']);
    expect(出[0].正文).toBe('短句，少形容词。');
  });
  it('角色卡取字段与备选开场白；世界书按条目名', () => {
    expect(fetchEntries(角色卡, ['first_mes'])[0].正文).toBe('「进来看看？」');
    expect(fetchEntries(角色卡, ['alternate_greetings[1]'])[0].正文).toBe('雪天版开场');
    expect(fetchEntries(角色卡, ['暗巷'])[0].正文).toContain('小门');
    expect(fetchEntries(世界书, ['夜市'])[0].正文).toContain('摊子');
  });
  it('取不到就是空数组，不抛', () => {
    expect(fetchEntries(预设, ['没有这条'])).toEqual([]);
    expect(fetchEntries(预设, [])).toEqual([]);
  });
});
