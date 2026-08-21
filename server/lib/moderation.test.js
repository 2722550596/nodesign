/**
 * 外审档两旋钮（2026-08-20）：订阅模型看 moderationLevel，本地/中转（API 行）看
 * moderationLevelApi，默认档推导两边相同。钉住的是"按模型通路取旋钮"这件事 ——
 * 站主给朋友开 qwen 无审查不该顺带放开 Sonnet，反之亦然。
 */
import { describe, it, expect } from 'vitest';
import { levelFor, moderationKnobFor } from './moderation.js';

const SUB = 'claude-sonnet-5[1m]';
const QWEN = 'qwen3.8-27b';
const GEMINI = 'gemini-3.7-flash';   // 3.1-pro 行 08-21 深夜清掉，换同通路的 3.7 Flash 当 API 样本
const user = (o = {}) => ({ id: 'u1', role: 'user', plan: 'pro', lifetimeCostLimitUsd: null, moderationLevel: null, moderationLevelApi: null, ...o });

describe('moderationKnobFor', () => {
  it('订阅行 / 未知名 / 空 → subscription；API 行 → api', () => {
    expect(moderationKnobFor(SUB)).toBe('subscription');
    expect(moderationKnobFor('claude-opus-5')).toBe('subscription');
    expect(moderationKnobFor('typo-model')).toBe('subscription');
    expect(moderationKnobFor(null)).toBe('subscription');
    expect(moderationKnobFor(QWEN)).toBe('api');
    expect(moderationKnobFor(GEMINI)).toBe('api');
  });
});

describe('levelFor(user, appModel)', () => {
  it('订阅旋钮 off、API 旋钮没设：Sonnet 关审，qwen/gemini 走默认 strict', () => {
    const u = user({ moderationLevel: 'off' });
    expect(levelFor(u, SUB)).toBe('off');
    expect(levelFor(u, QWEN)).toBe('strict');
    expect(levelFor(u, GEMINI)).toBe('strict');
  });
  it('API 旋钮 off、订阅没设：qwen/gemini 关审，Sonnet 仍 strict —— 给朋友开 qwen 不放开 Sonnet', () => {
    const u = user({ moderationLevelApi: 'off' });
    expect(levelFor(u, QWEN)).toBe('off');
    expect(levelFor(u, GEMINI)).toBe('off');
    expect(levelFor(u, SUB)).toBe('strict');
  });
  it('两边都显式设、互不牵连', () => {
    const u = user({ moderationLevel: 'strict', moderationLevelApi: 'off' });
    expect(levelFor(u, SUB)).toBe('strict');
    expect(levelFor(u, QWEN)).toBe('off');
  });
  it('默认档推导两边相同（按档位，auth/tier.js）：admin off / basic strict / pro strict（08-21 晚全严格）；终身额度不参与', () => {
    for (const m of [SUB, QWEN]) {
      expect(levelFor(user({ role: 'admin' }), m)).toBe('off');
      expect(levelFor(user({ plan: 'basic' }), m)).toBe('strict');
      expect(levelFor(user({ lifetimeCostLimitUsd: 5 }), m)).toBe('strict');   // 试用码 = pro 带花费上限，默认档同 pro
      expect(levelFor(user(), m)).toBe('strict');
    }
  });
  it('不给模型 = 订阅旋钮（老签名兼容）；拼错的档位值当没设', () => {
    expect(levelFor(user({ moderationLevel: 'off', moderationLevelApi: 'strict' }))).toBe('off');
    expect(levelFor(user({ moderationLevelApi: 'nope' }), QWEN)).toBe('strict');
    expect(levelFor(null, QWEN)).toBe('off');
  });
});
