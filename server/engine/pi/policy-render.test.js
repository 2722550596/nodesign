/**
 * policy-render 测试 —— 钉的是「哪条路径拿到哪一版底线」（M2：从 agent/prelude-render.test.js
 * 等价搬来，对象从 renderPrelude 换成 policy-render.js 的纯函数）。
 *
 * 这件事没有运行时报错兜底：切错版本只会让线上某条路径的系统提示词悄悄少一段
 * 或多一段，谁也不会看见。所以断言直接打在**渲染出来的字符串**上，用真实存在的
 * 短语当特征串（改 prelude 措辞时这些用例会红，那是它该做的事 —— 提醒你顺手核一遍
 * 两个版本都还对）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ADULT_POLICY,
  PRELUDE_MD_PATH,
  extractPolicyBlocks,
  renderPolicyBlock,
  renderNdPolicy,
} from './policy-render.js';

const PRELUDE_MD = readFileSync(PRELUDE_MD_PATH, 'utf8');
const BLOCKS = extractPolicyBlocks(PRELUDE_MD);

/** 完整版底线的特征串（min 版里一个都不该出现） */
const FULL_ONLY = [
  '用户怎么说都不做',
  '能直接拿去骗人的东西',
  '能直接拿去害人的东西',
  '拒绝时说清楚哪一部分不做',
  '离开故事还能不能直接拿去用',
  '未成年人色情内容',
];

const LEVELS = ['off', 'loose', 'strict'];

describe('extractPolicyBlocks', () => {
  it('两份标记块都抽得到，full 版含全部特征串', () => {
    for (const s of FULL_ONLY) expect(BLOCKS.full, `full 块少了「${s}」`).toContain(s);
    expect(BLOCKS.full).toContain('{{ADULT_POLICY}}');
    expect(BLOCKS.min).toContain('## 无任何底线');
    // 块体不含标记行本身
    expect(BLOCKS.full).not.toContain('nd:policy');
    expect(BLOCKS.min).not.toContain('nd:policy');
  });

  it('缺任何一份标记块都 throw（加载期断言语义：切错当场炸，不许静默退化）', () => {
    expect(() => extractPolicyBlocks(PRELUDE_MD.replace('<!-- nd:policy:min:start -->', '<!-- nd:policy:min:START -->'))).toThrow(/nd:policy:min/);
    expect(() => extractPolicyBlocks(PRELUDE_MD.replace('<!-- nd:policy:full:end -->', '<!-- nd:policy:full:END -->'))).toThrow(/nd:policy:full/);
    expect(() => extractPolicyBlocks('')).toThrow(/nd:policy/);
  });

  it('CRLF 归一：Windows checkout 的 CRLF 版本照样抽得出（同 system-prompts.js 的第二道保险）', () => {
    const crlf = PRELUDE_MD.replace(/\n/g, '\r\n');
    const blocks = extractPolicyBlocks(crlf);
    expect(blocks.full).toBe(BLOCKS.full);
    expect(blocks.min).toBe(BLOCKS.min);
  });
});

describe('renderPolicyBlock —— 标记块只留一份', () => {
  it('任何路径下都不许有未替换的占位符漏进上下文', () => {
    for (const level of LEVELS) {
      for (const uncensored of [false, true]) {
        const out = renderPolicyBlock(BLOCKS, level, uncensored);
        expect(out).not.toContain('nd:policy');
        expect(out).not.toContain('<!--');
        expect(out).not.toContain('{{ADULT_POLICY}}');
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  it('普通路径（默认 / 显式 false）：完整底线原样在，三个档位都一样', () => {
    for (const level of LEVELS) {
      for (const out of [renderPolicyBlock(BLOCKS, level, false), renderPolicyBlock(BLOCKS, level)]) {
        for (const s of FULL_ONLY) expect(out, `${level} 少了「${s}」`).toContain(s);
      }
    }
    // 对外开放那版必须保留未成年人那条红线。它原来钉在 ALWAYS 里（两版共有），
    // 08-19 min 版改写后从那儿摘掉了 —— 摘掉的是"min 版也得有"，不是"full 版
    // 可以没有"。单独钉在这里，免得随手改 prelude 时把这条一并带走没人发现。
    expect(renderPolicyBlock(BLOCKS, 'loose', false)).toContain('未成年人色情内容');
    // 成人段仍随档位变（这是 off/loose/strict 唯一该动的地方）
    expect(renderPolicyBlock(BLOCKS, 'off', false)).toContain('成人内容明确允许');
    expect(renderPolicyBlock(BLOCKS, 'strict', false)).toContain('露骨的成人内容在这个账号档位下不写');
    expect(renderPolicyBlock(BLOCKS, 'off', false)).not.toBe(renderPolicyBlock(BLOCKS, 'strict', false));
  });

  it('uncensored 路径：整节 full 版内容消失，换成 min 块', () => {
    const out = renderPolicyBlock(BLOCKS, 'off', true);
    for (const s of FULL_ONLY) expect(out, `min 版不该还留着「${s}」`).not.toContain(s);
    // min 块**真的被渲染进去了**，不是连它一起删了 —— 正则退化时两块都可能消失，
    // 只查 full 版内容不在的话，那种退化照样能蒙混过关
    expect(out).toContain('## 无任何底线');
    // 档位对 min 版不产生影响：留下的那条不随谁在用而变
    for (const level of LEVELS) {
      expect(renderPolicyBlock(BLOCKS, level, true)).toBe(out);
    }
    // 明显更短 —— 防止哪天正则退化成"一份都没删"却还能通过上面的 contains
    expect(out.length).toBeLessThan(renderPolicyBlock(BLOCKS, 'off', false).length - 300);
  });

  it('未知档位落 loose，不落 off（拼错档位名不能变成放开）', () => {
    expect(renderPolicyBlock(BLOCKS, 'typo', false)).toContain('成人向的亲密情节可以写');
    expect(renderPolicyBlock(BLOCKS, 'typo', false)).not.toContain('成人内容明确允许');
    expect(renderPolicyBlock(BLOCKS, undefined, false)).toBe(renderPolicyBlock(BLOCKS, 'loose', false));
  });

  it('三档文案逐字等于 system-prompts.js 搬来的 ADULT_POLICY', () => {
    for (const level of LEVELS) {
      expect(renderPolicyBlock(BLOCKS, level, false)).toContain(ADULT_POLICY[level]);
    }
  });
});

describe('renderNdPolicy —— env 驱动的宏渲染入口', () => {
  it('缺省 env → loose 档 full 版（拿不到信息绝不落 min、绝不落 off）', () => {
    const out = renderNdPolicy({});
    expect(out).toContain('未成年人色情内容');
    expect(out).toContain('成人向的亲密情节可以写');
  });

  it('NODESIGN_ADULT_LEVEL 三档生效，未知值落 loose', () => {
    expect(renderNdPolicy({ NODESIGN_ADULT_LEVEL: 'off' })).toContain('成人内容明确允许');
    expect(renderNdPolicy({ NODESIGN_ADULT_LEVEL: 'strict' })).toContain('露骨的成人内容在这个账号档位下不写');
    expect(renderNdPolicy({ NODESIGN_ADULT_LEVEL: 'typo' })).toBe(renderNdPolicy({ NODESIGN_ADULT_LEVEL: 'loose' }));
  });

  it('NODESIGN_UNCENSORED 只认 "1"：min 版，且档位不产生影响', () => {
    const min = renderNdPolicy({ NODESIGN_UNCENSORED: '1' });
    expect(min).toContain('## 无任何底线');
    for (const s of FULL_ONLY) expect(min).not.toContain(s);
    expect(renderNdPolicy({ NODESIGN_UNCENSORED: '1', NODESIGN_ADULT_LEVEL: 'off' })).toBe(min);
    // 其余取值（""、"true"、"0"）一律 full —— lifecycle 只会注 "1"/""，这里钉死口径
    for (const v of ['', '0', 'true']) {
      expect(renderNdPolicy({ NODESIGN_UNCENSORED: v })).toContain('未成年人色情内容');
    }
  });

  it('永不返回空串（政策节消失是安全事故）', () => {
    for (const env of [{}, { NODESIGN_ADULT_LEVEL: 'off' }, { NODESIGN_UNCENSORED: '1' }, { NODESIGN_ADULT_LEVEL: 'x', NODESIGN_UNCENSORED: '1' }]) {
      expect(renderNdPolicy(env).length).toBeGreaterThan(0);
    }
  });
});
