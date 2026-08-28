/**
 * 外审档单旋钮（M3b，2026-08-28）：订阅通道删除后所有模型都走 API 通路，
 * 原来的「订阅 / 本地中转」双旋钮合并成一枚 moderationLevelApi。
 * levelFor 永远按 api 旋钮取；老的 moderationLevel（订阅旋钮）字段即使还在用户对象上也不再参与。
 */
import { describe, it, expect } from 'vitest';
import { levelFor } from './moderation.js';

const QWEN = 'qwen3.8-27b';
const GEMINI = 'gemini-3.7-flash';   // 3.1-pro 行 08-21 深夜清掉，换同通路的 3.7 Flash 当 API 样本
const OX = 'ox-alpha';
const user = (o = {}) => ({ id: 'u1', role: 'user', plan: 'pro', lifetimeCostLimitUsd: null, moderationLevelApi: null, ...o });

describe('levelFor(user, appModel) —— M3b 起永远 api 旋钮', () => {
  it('api 旋钮 off：所有模型关审', () => {
    const u = user({ moderationLevelApi: 'off' });
    expect(levelFor(u, QWEN)).toBe('off');
    expect(levelFor(u, GEMINI)).toBe('off');
    expect(levelFor(u, OX)).toBe('off');
  });
  it('⚠️ 老的订阅旋钮字段（moderationLevel）不再参与 —— 设了也不影响 api 通路', () => {
    const u = user({ moderationLevel: 'off' });
    expect(levelFor(u, QWEN)).toBe('strict');
    expect(levelFor(u, OX)).toBe('strict');
    const u2 = user({ moderationLevel: 'off', moderationLevelApi: 'loose' });
    expect(levelFor(u2, QWEN)).toBe('loose');
  });
  it('默认档按账号档位（auth/tier.js）：admin off / basic strict / pro strict（08-21 晚全严格）；终身额度不参与', () => {
    for (const m of [QWEN, OX]) {
      expect(levelFor(user({ role: 'admin' }), m)).toBe('off');
      expect(levelFor(user({ plan: 'basic' }), m)).toBe('strict');
      expect(levelFor(user({ lifetimeCostLimitUsd: 5 }), m)).toBe('strict');   // 试用码 = pro 带花费上限，默认档同 pro
      expect(levelFor(user(), m)).toBe('strict');
    }
  });
  it('不给模型 = 同一枚 api 旋钮（老签名兼容）；拼错的档位值当没设', () => {
    expect(levelFor(user({ moderationLevelApi: 'off' }))).toBe('off');
    expect(levelFor(user({ moderationLevelApi: 'nope' }), QWEN)).toBe('strict');
    expect(levelFor(null, QWEN)).toBe('off');
  });
});
