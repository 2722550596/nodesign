// danbooru-tags 的离线部分：句子判定 / 下划线 / 标签抽取 / 文本输出。
// 联网的收录量查询不进测试（danbooru 不是本仓库的依赖，fail-open 路径靠 offline 分支覆盖）。
import { describe, it, expect } from 'vitest';
import {
  isSentenceLike, classifyFragments, extractTags, normalizeTag, formatTagLint, formatLookup,
} from './danbooru-tags.js';

describe('isSentenceLike', () => {
  it('多词英文句子 / 带功能词的短语 / 中文 = 句子', () => {
    expect(isSentenceLike('standing woman and little girl on the floor')).toBe(true);
    expect(isSentenceLike('a girl with sword')).toBe(true);           // 3 词 + 功能词 a
    expect(isSentenceLike('她站在便利店门口')).toBe(true);
  });
  it('真 danbooru 标签不被误伤（含 own/with/of/on 的长标签）', () => {
    for (const t of ['hand on own chest', 'playing with own hair', 'cup of tea', 'looking at viewer',
      'hands on own hips', 'long hair', '1girl', 'artist:dairi', 'lucy \\(cyberpunk\\)', '(masterpiece:1.2)']) {
      expect(isSentenceLike(t), t).toBe(false);
    }
  });
});

describe('classifyFragments / extractTags', () => {
  const prompt = '2girls, mature_female, black hair, full_body, <lora:x:0.8>, depth of field, standing woman and little girl on the floor';
  it('句子片段与下划线片段分开点名，lora 块不算', () => {
    const c = classifyFragments(prompt);
    expect(c.sentences).toEqual(['standing woman and little girl on the floor']);
    expect(c.underscored).toEqual(['mature_female', 'full_body']);
  });
  it('抽标签时跳过句子片段，空格归一成下划线', () => {
    expect(extractTags(prompt)).toEqual(['2girls', 'mature_female', 'black_hair', 'full_body', 'depth_of_field']);
  });
  it('normalizeTag：权重/强调括号/反斜杠/artist: 前缀剥掉，名字自带的括号留着', () => {
    expect(normalizeTag('(Smeared Lipstick:1.3)')).toBe('smeared_lipstick');
    expect(normalizeTag('((long hair))')).toBe('long_hair');
    expect(normalizeTag('lucy \\(cyberpunk\\)')).toBe('lucy_(cyberpunk)');
    expect(normalizeTag('(lucy \\(cyberpunk\\):1.1)')).toBe('lucy_(cyberpunk)');
    expect(normalizeTag('artist:dairi')).toBe('dairi');
    expect(normalizeTag('[tag]')).toBe('tag');
  });
});

describe('formatTagLint', () => {
  it('没什么可说 → null；有句子时即使 offline 也要说', () => {
    expect(formatTagLint(null)).toBeNull();
    const txt = formatTagLint({ zero: [], low: [], missing: [], checked: 0, offline: true,
      sentences: ['a girl with sword'], underscored: ['long_hair'] });
    expect(txt).toContain('只做了本地判定');
    expect(txt).toContain('"a girl with sword"');
    expect(txt).toContain('long_hair');
    expect(txt).toContain('lookup_tags');
  });
  it('低收录措辞 = 弱不是禁区', () => {
    const txt = formatTagLint({ zero: [], low: [['rare_tag', 120]], missing: [], checked: 1, offline: false,
      sentences: [], underscored: [] });
    expect(txt).toContain('rare_tag(120)');
    expect(txt).toContain('不是禁区');
  });
});

describe('formatLookup', () => {
  it('四段各自成行，空查询给提示', () => {
    const txt = formatLookup({ offline: false,
      tags: { ok: [['long_hair', 5000000]], low: [['rare_tag', 120]], zero: ['dead_tag'], missing: ['nope_tag'] },
      suggestions: [['nope_tag', [['nope', 3000]]]],
      searches: [['makeup', [['makeup', 186849]]], ['zzz', []]],
      wiki: [['makeup', 'Cosmetics applied to the face.']] });
    expect(txt).toContain('long_hair(5000000)');
    expect(txt).toContain('rare_tag(120)');
    expect(txt).toContain('dead_tag');
    expect(txt).toContain('nope_tag 的候选');
    expect(txt).toContain('*makeup*');
    expect(txt).toContain('没有匹配的标签');
    expect(txt).toContain('📖 makeup');
    expect(formatLookup({ offline: false, tags: { ok: [], low: [], zero: [], missing: [] }, suggestions: [], searches: [], wiki: [] }))
      .toContain('至少给一个');
  });
});
