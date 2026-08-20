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
  UPSTREAMS,
} from './model-context.js';

describe('派生导出（旧签名不变）', () => {
  it('SELECTABLE_MODELS 只暴露带 select 的行；没 select 的 API 行（kimi）不进 picker，带闸门的（qwen/gemini）进全量清单', () => {
    const ids = SELECTABLE_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5[1m]');
    expect(ids).toContain('claude-opus-5[1m]');
    expect(ids.some((id) => /kimi/i.test(id))).toBe(false);
    expect(SELECTABLE_MODELS.find((m) => m.id === 'gemini-3.1-pro')?.gate).toBe('localGen');
    for (const m of SELECTABLE_MODELS) {
      expect(typeof m.label).toBe('string');
      expect(typeof m.desc).toBe('string');
    }
  });

  it('闸门：本地 Qwen 与中转 Gemini 只对 admin/获批账号露出，普通账号看不见', () => {
    const plain = selectableModelsFor({ role: 'user' }).map((m) => m.id);
    expect(plain).not.toContain('qwen3.8-27b');
    expect(plain).not.toContain('gemini-3.1-pro');
    expect(plain).toContain('claude-sonnet-5[1m]');          // 无闸门的照常在

    for (const u of [{ role: 'admin' }, { role: 'user', allowLocalGen: true }]) {
      const ids = selectableModelsFor(u).map((m) => m.id);
      expect(ids).toContain('qwen3.8-27b');
      expect(ids).toContain('gemini-3.1-pro');
    }
    // 未登录 / 拿不到用户对象时按最严处理
    const anon = selectableModelsFor(null).map((m) => m.id);
    expect(anon).not.toContain('qwen3.8-27b');
    expect(anon).not.toContain('gemini-3.1-pro');
  });

  it('spoof：API 行给 alias，订阅/未知原样返回', () => {
    expect(resolveSdkSpoofModel('kimi-k2.6')).toBe('claude-opus-4-7[1m]');
    expect(resolveSdkSpoofModel('gemini-3.1-pro')).toBe('claude-sonnet-4-6[1m]');
    expect(resolveSdkSpoofModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5[1m]');
    expect(resolveSdkSpoofModel('made-up-model')).toBe('made-up-model');
    expect(resolveSdkSpoofModel(null)).toBe(null);
  });

  it('window：查表 + pattern fallback + null', () => {
    expect(resolveModelContextWindow('gemini-3.1-pro')).toBe(1_000_000);
    expect(resolveModelContextWindow('kimi-k2.6')).toBe(256_000);
    expect(resolveModelContextWindow('claude-sonnet-5')).toBe(200_000);
    expect(resolveModelContextWindow('kimi-future-model')).toBe(256_000);
    expect(resolveModelContextWindow('whatever[1m]')).toBe(1_000_000);
    expect(resolveModelContextWindow('unknown')).toBe(null);
  });

  it('thinking：Sonnet5+/Opus4.6+ adaptive+summarized；API 行 enabled+budget；老模型 enabled', () => {
    expect(pickThinkingConfig('claude-sonnet-5[1m]')).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(pickThinkingConfig('claude-opus-4-7[1m]')).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(pickThinkingConfig('gemini-3.1-pro')).toEqual({ type: 'enabled', budgetTokens: 8192 });
    expect(pickThinkingConfig('kimi-k2.6')).toEqual({ type: 'enabled', budgetTokens: 8192 });
    expect(pickThinkingConfig('claude-haiku-4-5')).toEqual({ type: 'enabled', budgetTokens: 8192 });
  });
});

describe('路由', () => {
  it('订阅模型 → subscription，API 模型带全套路由信息', () => {
    expect(resolveModelRoute('claude-sonnet-5[1m]')).toEqual({ mode: 'subscription' });
    expect(resolveModelRoute(null)).toEqual({ mode: 'subscription' });
    const r = resolveModelRoute('gemini-3.1-pro');
    expect(r.mode).toBe('api');
    expect(r.sdkAlias).toBe('claude-sonnet-4-6[1m]');
    expect(r.fastModel).toBe('gemini-3.1-pro');
    expect(r.upstream).toBe(UPSTREAMS.lament);
  });

  it('入口反查认三种形态：appModel / alias / 剥[1m]的 alias', () => {
    for (const name of ['gemini-3.1-pro', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6']) {
      const w = resolveWireModel(name);
      expect(w?.appModel).toBe('gemini-3.1-pro');
      expect(w?.wireModel).toBe('中转-gemini-3.1-pro-preview');
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
    for (const id of ['qwen3.8-27b', 'gemini-3.1-pro', 'kimi-k2.6']) {
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
    const out = repriceUsageDeltas({ 'claude-sonnet-4-6': gUsage }, 'gemini-3.1-pro');
    expect(Object.keys(out)).toEqual(['gemini-3.1-pro']);
    // 68k×$2/M + 500×$12/M = 0.136 + 0.006 = 0.142
    expect(out['gemini-3.1-pro'].costUsd).toBeCloseTo(0.142, 4);
    expect(out['gemini-3.1-pro'].inputTokens).toBe(68_000);
  });

  it('⚠️ 订阅会话原样返回 —— 真跑 sonnet-4-6 不能被错记成 Gemini 的账', () => {
    const deltas = { 'claude-sonnet-4-6': gUsage };
    const out = repriceUsageDeltas(deltas, 'claude-sonnet-5[1m]');
    expect(out).toBe(deltas);   // 同一引用，一个字段没动
  });

  it('同一 appModel 的多个 key 形态归并相加', () => {
    const out = repriceUsageDeltas({
      'claude-sonnet-4-6': { ...gUsage },
      'gemini-3.1-pro': { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 },
    }, 'gemini-3.1-pro');
    expect(out['gemini-3.1-pro'].inputTokens).toBe(69_000);
  });

  it('null / 空对象语义保持（context.js 的 fallback 分支依赖）', () => {
    expect(repriceUsageDeltas(null, 'gemini-3.1-pro')).toBe(null);
    expect(repriceUsageDeltas({}, 'gemini-3.1-pro')).toEqual({});
  });

  it('没填价的 API 模型（kimi）：key 还原但 cost 保留 SDK 值', () => {
    const out = repriceUsageDeltas({ 'claude-opus-4-7': { ...gUsage } }, 'kimi-k2.6');
    expect(Object.keys(out)).toEqual(['kimi-k2.6']);
    expect(out['kimi-k2.6'].costUsd).toBeCloseTo(0.345, 4);
  });

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
    }, 'gemini-3.1-pro');
    expect(Object.keys(out)).toEqual(['gemini-3.1-pro']);
    expect(out['gemini-3.1-pro'].costUsd).toBeCloseTo(2.0, 4);   // gemini input $2/M，不是 SDK 的 9.99
  });
});
