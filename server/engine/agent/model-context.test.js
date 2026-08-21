/**
 * model-context 单表真相源测试。重点不是枚举每行，而是钉住派生逻辑与
 * 撞车断言 —— 这张表写错一个字的历史下场是"两处静默降级没人报错"。
 */

import { describe, it, expect } from 'vitest';
import {
  SELECTABLE_MODELS,
  resolveSdkSpoofModel,
  resolveModelContextWindow,
  pickThinkingConfig,
  resolveModelRoute,
  resolveWireModel,
  repriceUsageDeltas,
  selectableModelsFor,
  allowedModelsFor, isModelLockedFor, defaultModelFor, modelIsFree, crossLaneSwitchReason,
  UPSTREAMS,
} from './model-context.js';

describe('派生导出（旧签名不变）', () => {
  it('SELECTABLE_MODELS 只暴露带 select 的行；没 select 的 API 行（kimi / qwen / 3.1 Pro）不进 picker', () => {
    const ids = SELECTABLE_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5[1m]');
    expect(ids).toContain('claude-opus-5[1m]');
    expect(ids.some((id) => /kimi/i.test(id))).toBe(false);
    expect(SELECTABLE_MODELS.find((m) => m.id === 'gemini-3.7-flash')?.gate).toBe('localGen');
    expect(ids).not.toContain('gemini-3.1-pro');     // 3.1 Pro 行 08-21 深夜连同 kimi 行一起删了
    expect(resolveWireModel('gemini-3.1-pro')).toBe(null);
    expect(resolveWireModel('kimi-k2.6')).toBe(null);
    expect(UPSTREAMS.moonshot).toBeUndefined();
    // 08-20 摘牌：盒子关机，行和线路都留着（api 字段仍在），只是不给人选
    expect(ids).not.toContain('qwen3.8-27b');
    expect(resolveWireModel('qwen3.8-27b')?.appModel).toBe('qwen3.8-27b');   // ⭐ 摘牌 ≠ 拆线
    for (const m of SELECTABLE_MODELS) {
      expect(typeof m.label).toBe('string');
      expect(typeof m.desc).toBe('string');
    }
  });

  it('闸门：中转 Gemini 3.7 Flash 只对 admin/获批账号露出，普通账号看不见', () => {
    const plain = selectableModelsFor({ role: 'user' }).map((m) => m.id);
    expect(plain).not.toContain('gemini-3.7-flash');
    expect(plain).toContain('claude-sonnet-5[1m]');          // 无闸门的照常在

    for (const u of [{ role: 'admin' }, { role: 'user', plan: 'pro', allowLocalGen: true }]) {
      const ids = selectableModelsFor(u).map((m) => m.id);
      expect(ids).toContain('gemini-3.7-flash');
      // 摘了牌的行，连 admin 也选不到（gate 是"谁能看见"，select 是"在不在牌上"）
      expect(ids).not.toContain('qwen3.8-27b');
    }
    // 未登录 / 拿不到用户对象时按最严处理
    const anon = selectableModelsFor(null).map((m) => m.id);
    expect(anon).not.toContain('qwen3.8-27b');
    expect(anon).not.toContain('gemini-3.7-flash');
  });

  it('订阅闸（08-21）：没订阅资格的账号看得见 Claude 行但 locked；邀请码号/admin 正常；默认模型=ox-alpha', () => {
    const pub = { role: 'user', plan: 'basic' };
    const sub = { role: 'user', plan: 'pro' };
    const pubSel = selectableModelsFor(pub);
    expect(pubSel.find((m) => m.id === 'claude-sonnet-5[1m]')?.locked).toBe(true);
    expect(pubSel.find((m) => m.id === 'ox-alpha')?.locked).toBeUndefined();
    expect(allowedModelsFor(pub).map((m) => m.id)).not.toContain('claude-sonnet-5[1m]');
    expect(allowedModelsFor(pub).map((m) => m.id)).toContain('ox-alpha');
    expect(isModelLockedFor(pub, 'claude-opus-5[1m]')).toBe(true);
    expect(isModelLockedFor(sub, 'claude-opus-5[1m]')).toBe(false);
    expect(isModelLockedFor(pub, 'gemini-3.7-flash')).toBe(false);   // 看不见的不是 locked，是不存在
    expect(selectableModelsFor(sub).some((m) => m.locked)).toBe(false);
    expect(selectableModelsFor({ role: 'admin' }).some((m) => m.locked)).toBe(false);
    for (const u of [pub, sub, { role: 'admin' }, null]) expect(defaultModelFor(u)).toBe('ox-alpha');
    expect(modelIsFree('ox-alpha')).toBe(true);
    expect(modelIsFree('claude-sonnet-5[1m]')).toBe(false);
    expect(modelIsFree('gemini-3.7-flash')).toBe(false);
    // 会话中途 Ox → Claude 拦（空签名 thinking 回传会 400）；其它方向放行
    expect(crossLaneSwitchReason('ox-alpha', 'claude-sonnet-5[1m]')).toMatch(/新开一个会话/);
    expect(crossLaneSwitchReason('claude-sonnet-5[1m]', 'ox-alpha')).toBeNull();
    expect(crossLaneSwitchReason('ox-alpha', 'ox-alpha')).toBeNull();
    // 08-21 晚：高/深想两行同是 Ox，互切不算跨线；深想行也是免费行但不是默认
    expect(crossLaneSwitchReason('ox-alpha', 'ox-alpha-max')).toBeNull();
    expect(crossLaneSwitchReason('ox-alpha-max', 'claude-opus-5[1m]')).toMatch(/新开一个会话/);
    expect(modelIsFree('ox-alpha-max')).toBe(true);
    expect(pubSel.find((m) => m.id === 'ox-alpha-max')?.locked).toBeUndefined();
    expect(resolveWireModel('ox-alpha-max')?.reasoningEffort).toBe('max');
    expect(resolveWireModel('ox-alpha')?.reasoningEffort).toBe('high');
  });

  it('spoof：API 行给 alias，订阅/未知原样返回', () => {
    expect(resolveSdkSpoofModel('deepseek-v4-flash-vision')).toBe('claude-opus-4-7[1m]');
    expect(resolveSdkSpoofModel('gemini-3.7-flash')).toBe('claude-opus-4-6[1m]');
    expect(resolveSdkSpoofModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5[1m]');
    expect(resolveSdkSpoofModel('made-up-model')).toBe('made-up-model');
    expect(resolveSdkSpoofModel(null)).toBe(null);
  });

  it('window：查表 + pattern fallback + null', () => {
    expect(resolveModelContextWindow('gemini-3.7-flash')).toBe(1_000_000);
    expect(resolveModelContextWindow('deepseek-v4-flash-vision')).toBe(272_000);
    expect(resolveModelContextWindow('claude-sonnet-5')).toBe(200_000);
    expect(resolveModelContextWindow('kimi-future-model')).toBe(256_000);
    expect(resolveModelContextWindow('whatever[1m]')).toBe(1_000_000);
    expect(resolveModelContextWindow('unknown')).toBe(null);
  });

  it('thinking：Sonnet5+/Opus4.6+ adaptive+summarized；API 行 enabled+budget；老模型 enabled', () => {
    expect(pickThinkingConfig('claude-sonnet-5[1m]')).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(pickThinkingConfig('claude-opus-4-7[1m]')).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(pickThinkingConfig('gemini-3.7-flash')).toEqual({ type: 'enabled', budgetTokens: 8192 });
    expect(pickThinkingConfig('deepseek-v4-flash-vision')).toEqual({ type: 'enabled', budgetTokens: 8192 });
    expect(pickThinkingConfig('claude-haiku-4-5')).toEqual({ type: 'enabled', budgetTokens: 8192 });
  });
});

describe('路由', () => {
  it('订阅模型 → subscription，API 模型带全套路由信息', () => {
    expect(resolveModelRoute('claude-sonnet-5[1m]')).toEqual({ mode: 'subscription' });
    expect(resolveModelRoute(null)).toEqual({ mode: 'subscription' });
    const r = resolveModelRoute('gemini-3.7-flash');
    expect(r.mode).toBe('api');
    expect(r.sdkAlias).toBe('claude-opus-4-6[1m]');
    expect(r.fastModel).toBe('gemini-3.7-flash');
    expect(r.upstream).toBe(UPSTREAMS.lament);
  });

  it('入口反查认三种形态：appModel / alias / 剥[1m]的 alias', () => {
    for (const name of ['gemini-3.7-flash', 'claude-opus-4-6[1m]', 'claude-opus-4-6']) {
      const w = resolveWireModel(name);
      expect(w?.appModel).toBe('gemini-3.7-flash');
      expect(w?.wireModel).toBe('反重力-流式抗截断/gemini-3.7-flash-high');
      expect(w?.liftImages).toBe(true);
    }
    // 订阅名不该被路由（sonnet-5 没有 API 行）
    expect(resolveWireModel('claude-sonnet-5')).toBe(null);
    expect(resolveWireModel(undefined)).toBe(null);
  });

  it('本地 Qwen 行：无鉴权上游、count_tokens 由上游真答', () => {
    const w = resolveWireModel('claude-opus-5');
    expect(w?.appModel).toBe('qwen3.8-27b');
    expect(w?.upstream.authStyle).toBe('none');
    expect(w?.upstream.keyEnv).toBe(null);
    expect(w?.upstream.countTokens).toBe(true);
    expect(resolveModelRoute('qwen3.8-27b').fastModel).toBe('qwen3.8-27b');
  });

  it('⚠️ 每个 API 行的 sdkAlias 容量必须 ≥ 真实 window —— SDK 压缩窗口取二者较小值', () => {
    for (const id of ['qwen3.8-27b', 'gemini-3.7-flash', 'deepseek-v4-flash-vision']) {
      const r = resolveModelRoute(id);
      const aliasWindow = resolveModelContextWindow(r.sdkAlias);
      expect(aliasWindow, `${id} 的 alias ${r.sdkAlias} 容量不足`).toBeGreaterThanOrEqual(r.window);
      expect(r.window).toBe(resolveModelContextWindow(id));   // route.window 就是表里那个
    }
  });
});

describe('repriceUsageDeltas', () => {
  const gUsage = { inputTokens: 68_000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.345 };

  it('API 会话：alias 还原成 appModel、按表价重算', () => {
    const out = repriceUsageDeltas({ 'claude-opus-4-6': gUsage }, 'gemini-3.7-flash');
    expect(Object.keys(out)).toEqual(['gemini-3.7-flash']);
    // 68k×$0.75/M + 500×$3.75/M = 0.051 + 0.001875 = 0.052875
    expect(out['gemini-3.7-flash'].costUsd).toBeCloseTo(0.052875, 5);
    expect(out['gemini-3.7-flash'].inputTokens).toBe(68_000);
  });

  it('⚠️ 订阅会话原样返回 —— 真跑 sonnet-4-6 不能被错记成 Gemini 的账', () => {
    const deltas = { 'claude-opus-4-6': gUsage };
    const out = repriceUsageDeltas(deltas, 'claude-sonnet-5[1m]');
    expect(out).toBe(deltas);   // 同一引用，一个字段没动
  });

  it('同一 appModel 的多个 key 形态归并相加', () => {
    const out = repriceUsageDeltas({
      'claude-opus-4-6': { ...gUsage },
      'gemini-3.7-flash': { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 },
    }, 'gemini-3.7-flash');
    expect(out['gemini-3.7-flash'].inputTokens).toBe(69_000);
  });

  it('null / 空对象语义保持（context.js 的 fallback 分支依赖）', () => {
    expect(repriceUsageDeltas(null, 'gemini-3.7-flash')).toBe(null);
    expect(repriceUsageDeltas({}, 'gemini-3.7-flash')).toEqual({});
  });

  // 「没填价的 API 模型 cost 保留 SDK 值」的样本（kimi 行）08-21 深夜随行删除；表里现在每条 API 行都有 prices

  it('本地 Qwen：零价表让 costUsd 归 0（不然按 opus-5 alias 虚价记账）', () => {
    const out = repriceUsageDeltas({
      'claude-opus-5': { inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 3.21 },
    }, 'qwen3.8-27b');
    expect(Object.keys(out)).toEqual(['qwen3.8-27b']);
    expect(out['qwen3.8-27b'].costUsd).toBe(0);
  });

  it('API 会话里不在表里的 key（helper 走 fast 兜底）归到 fastModel、按 fast 价记', () => {
    const out = repriceUsageDeltas({
      'claude-sonnet-5': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 9.99 },
    }, 'gemini-3.7-flash');
    expect(Object.keys(out)).toEqual(['gemini-3.7-flash']);
    expect(out['gemini-3.7-flash'].costUsd).toBeCloseTo(0.75, 4);   // 3.7 flash input $0.75/M，不是 SDK 的 9.99
  });
});

describe('OpenCode Go · DeepSeek V4 Flash Vision 行（08-21 深夜）', () => {
  it('走 zenGo 上游、真名 deepseek-v4-flash-vision-exp、alias opus-4-7[1m]、窗口 272k、gate localGen、helper 仍是免费 Ox', () => {
    const r = resolveModelRoute('deepseek-v4-flash-vision');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.zenGo);
    expect(r.upstream.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(r.sdkAlias).toBe('claude-opus-4-7[1m]');   // kimi 退役腾出的 1M 名；窗口用户拍板 272k
    expect(r.window).toBe(272_000);
    expect(resolveModelContextWindow(r.sdkAlias)).toBeGreaterThanOrEqual(r.window);
    expect(r.fastModel).toBe('ox-alpha-helper');
    expect(resolveWireModel('claude-opus-4-7')?.wireModel).toBe('deepseek-v4-flash-vision-exp');
    expect(resolveWireModel('claude-opus-4-5')).toBe(null);   // 那个 200k 空名没再占
    expect(resolveWireModel('claude-sonnet-4-6[1m]')).toBe(null);   // 3.1-pro 退役腾出的名空着
    expect(resolveWireModel('claude-sonnet-5')).toBe(null);   // 订阅默认名仍不可路由
    expect(SELECTABLE_MODELS.find((m) => m.id === 'deepseek-v4-flash-vision')?.gate).toBe('localGen');
    expect(selectableModelsFor({ role: 'user', plan: 'pro' }).map((m) => m.id)).not.toContain('deepseek-v4-flash-vision');
    expect(selectableModelsFor({ role: 'admin' }).map((m) => m.id)).toContain('deepseek-v4-flash-vision');
    // Ox 三行已切 /zen/go
    for (const id of ['ox-alpha', 'ox-alpha-max', 'ox-alpha-helper']) {
      expect(resolveModelRoute(id).upstream).toBe(UPSTREAMS.zenGo);
      expect(resolveWireModel(id)?.wireModel).toBe('ox-alpha-free');
    }
  });
});
