/**
 * model-context 单表真相源测试（M3b 删除波后重写，2026-08-28）。
 * 重点不是枚举每行，而是钉住派生逻辑与撞车断言 —— 这张表写错一个字的历史下场
 * 是"两处静默降级没人报错"。
 *
 * M3b 起订阅通道整体删除：表里只剩 API 行，没有 locked 行、没有 subscription 通路、
 * 没有 sdkAlias/fastModel/resolveWireModel 这些 ingress 转换层概念 —— 相关用例全删，
 * 这里钉的是删除后的新口径。
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELECTABLE_MODELS,
  resolveModelContextWindow,
  resolveModelRoute,
  repriceUsageDeltas,
  selectableModelsFor,
  allowedModelsFor, defaultModelFor, modelIsFree, crossLaneSwitchReason, modelSwitchRejection,
  UPSTREAMS, BRANDS, brandOfModel,
} from './model-context.js';
import { MODELS_BUILTIN } from './models-json.js';

describe('派生导出（M3b 口径）', () => {
  it('SELECTABLE_MODELS 只暴露带 select 的行；helper 行 / 摘牌行不进 picker；没有 locked 行', () => {
    const ids = SELECTABLE_MODELS.map((m) => m.id);
    expect(ids).toContain('ox-alpha');
    expect(ids).toContain('minimax-m3');
    expect(ids).toContain('deepseek-v4-flash-vision');
    // helper 专用行（没写 select）一律不露出 —— 按**语义**钉：没有 select 的行不进清单
    for (const id of ['ox-alpha-helper', 'deepseek-v4-flash-helper']) expect(ids).not.toContain(id);
    // 08-20 摘牌：盒子关机，行和线路都留着（api 字段仍在），只是不给人选
    expect(ids).not.toContain('qwen3.8-27b');
    expect(resolveModelRoute('qwen3.8-27b')?.appModel).toBe('qwen3.8-27b');   // ⭐ 摘牌 ≠ 拆线
    expect(SELECTABLE_MODELS.find((m) => m.id === 'gemini-3.7-flash')?.gate).toBe('localGen');
    for (const m of SELECTABLE_MODELS) {
      expect(typeof m.label).toBe('string');
      expect(typeof m.desc).toBe('string');
      // M3b：订阅行删光，清单里不该再有任何 locked 行
      expect(m.locked, m.id).toBeUndefined();
    }
  });

  it('闸门：localGen 闸的行只对 admin/获批账号露出，普通账号看不见', () => {
    const plain = selectableModelsFor({ role: 'user' }).map((m) => m.id);
    expect(plain).not.toContain('gemini-3.7-flash');
    expect(plain).not.toContain('kimi-k3');
    expect(plain).toContain('ox-alpha');          // 无闸门的照常在

    for (const u of [{ role: 'admin' }, { role: 'user', plan: 'pro', allowLocalGen: true }]) {
      const ids = selectableModelsFor(u).map((m) => m.id);
      expect(ids).toContain('gemini-3.7-flash');
      expect(ids).toContain('kimi-k3');
      // 摘了牌的行，连 admin 也选不到（gate 是"谁能看见"，select 是"在不在牌上"）
      expect(ids).not.toContain('qwen3.8-27b');
    }
    // 未登录 / 拿不到用户对象时按最严处理
    const anon = selectableModelsFor(null).map((m) => m.id);
    expect(anon).not.toContain('qwen3.8-27b');
    expect(anon).not.toContain('gemini-3.7-flash');
  });

  it('M3b 订阅闸退役：清单无 locked 行（isModelLockedFor 已删）；默认模型=ox-alpha', () => {
    const pub = { role: 'user', plan: 'basic' };
    for (const u of [pub, { role: 'user', plan: 'pro' }, { role: 'admin' }, null]) {
      expect(defaultModelFor(u)).toBe('ox-alpha');
    }
    expect(modelIsFree('ox-alpha')).toBe(true);
    expect(modelIsFree('ox-alpha-max')).toBe(true);
    expect(modelIsFree('gemini-3.7-flash')).toBe(false);
    expect(modelIsFree('deepseek-v4-flash-vision')).toBe(false);
    expect(modelIsFree('made-up-model')).toBe(false);
  });

  it('crossLaneSwitchReason：openai-chat 上游切到 Anthropic 协议要拦；反向 / 同协议 / 同模型放行', () => {
    // Ox（openai-chat）→ MiniMax（Anthropic 透传）：空签名 thinking 回传会 400
    expect(crossLaneSwitchReason('ox-alpha', 'minimax-m3')).toMatch(/新开一个会话/);
    expect(crossLaneSwitchReason('minimax-m3', 'ox-alpha')).toBeNull();
    expect(crossLaneSwitchReason('ox-alpha', 'ox-alpha')).toBeNull();
    // 话里不许写死"换到 Claude"（订阅行删了，拦的是协议方向）
    expect(crossLaneSwitchReason('ox-alpha', 'minimax-m3')).not.toMatch(/Claude/);
    // 同是 openai-chat 上游互切放行（Ox ↔ DeepSeek/Kimi 同协议）
    expect(crossLaneSwitchReason('ox-alpha', 'deepseek-v4-flash-vision')).toBeNull();
    expect(crossLaneSwitchReason('ox-alpha', 'ox-alpha-max')).toBeNull();
    expect(crossLaneSwitchReason('deepseek-v4-flash-vision', 'kimi-k3')).toBeNull();
    // 未知名 / 缺参 → null（白名单闸另外管）
    expect(crossLaneSwitchReason('made-up', 'ox-alpha')).toBeNull();
    expect(crossLaneSwitchReason(null, 'ox-alpha')).toBeNull();
  });

  it('window：查表 + pattern fallback + null', () => {
    expect(resolveModelContextWindow('gemini-3.7-flash')).toBe(1_000_000);
    expect(resolveModelContextWindow('deepseek-v4-flash-vision')).toBe(272_000);
    expect(resolveModelContextWindow('kimi-future-model')).toBe(256_000);
    expect(resolveModelContextWindow('whatever[1m]')).toBe(1_000_000);
    expect(resolveModelContextWindow('claude-sonnet-5')).toBe(null);   // 订阅名不在表里也不命中 pattern
    expect(resolveModelContextWindow('unknown')).toBe(null);
  });
});

describe('brand（模型出自谁家，08-21）', () => {
  it('每个可选模型都带 brand，且是 BRANDS 之一 —— 前端据此画身份标，漏一个就静默不画图标', () => {
    for (const m of SELECTABLE_MODELS) {
      expect(BRANDS, m.id).toContain(m.brand);
    }
  });

  it('brandOfModel：认识的按表回答，不认识的回 null（调用方自己兜底，不猜）', () => {
    expect(brandOfModel('deepseek-v4-flash-vision')).toBe('deepseek');
    expect(brandOfModel('ox-alpha')).toBe('opencode');          // 隐身免费行画供应商的标
    expect(brandOfModel('ox-alpha-max')).toBe('opencode');
    expect(brandOfModel('minimax-m3')).toBe('minimax');
    expect(brandOfModel('gemini-3.7-flash')).toBe('gemini');
    expect(brandOfModel('没有这个模型')).toBeNull();
    expect(brandOfModel(undefined)).toBeNull();
  });
});

describe('路由（M3b：只有 api 一条通路）', () => {
  it('API 模型带全套路由信息；未知 / null 返 null（调用方 fail-loud）', () => {
    const r = resolveModelRoute('gemini-3.7-flash');
    expect(r.mode).toBe('api');
    expect(r.appModel).toBe('gemini-3.7-flash');
    expect(r.upstream).toBe(UPSTREAMS.lament);
    expect(r.upstreamId).toBe('lament');
    expect(r.wireModel).toBe('反重力-流式抗截断/gemini-3.7-flash-high');
    expect(r.window).toBe(1_000_000);
    expect(r.maxOutput).toBe(null);   // 行里没写 maxOutput
    // ingress 概念随删除波退役：route 不再带 sdkAlias / fastModel
    expect(r.sdkAlias).toBeUndefined();
    expect(r.fastModel).toBeUndefined();
    expect(resolveModelRoute(null)).toBe(null);
    expect(resolveModelRoute('made-up-model')).toBe(null);
  });

  it('M3b 后表里每行都有 api —— 全表皆可路由，subscription 通路不存在', () => {
    for (const m of MODELS_BUILTIN) {
      const r = resolveModelRoute(m.id);
      expect(r, m.id).not.toBe(null);
      expect(r.mode, m.id).toBe('api');
      expect(r.window, m.id).toBe(resolveModelContextWindow(m.id));   // route.window 就是表里那个
    }
  });

  it('本地 Qwen 行：无鉴权上游、count_tokens 由上游真答', () => {
    const r = resolveModelRoute('qwen3.8-27b');
    expect(r.upstream.authStyle).toBe('none');
    expect(r.upstream.keyEnv).toBe(null);
    expect(r.upstream.countTokens).toBe(true);
  });

  it('maxOutput 按行带出（DeepSeek 行 128k）', () => {
    expect(resolveModelRoute('deepseek-v4-flash-vision').maxOutput).toBe(128_000);
    expect(resolveModelRoute('ox-alpha').maxOutput).toBe(131_072);
  });
});

describe('repriceUsageDeltas（M3b：usage key 是 pi wire 名，无 remap）', () => {
  const gUsage = { inputTokens: 68_000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.345 };

  it('API 会话：全部差分归到会话行、按表价重算', () => {
    const out = repriceUsageDeltas({ '反重力-流式抗截断/gemini-3.7-flash-high': gUsage }, 'gemini-3.7-flash');
    expect(Object.keys(out)).toEqual(['gemini-3.7-flash']);
    // 68k×$0.75/M + 500×$3.75/M = 0.051 + 0.001875 = 0.052875
    expect(out['gemini-3.7-flash'].costUsd).toBeCloseTo(0.052875, 5);
    expect(out['gemini-3.7-flash'].inputTokens).toBe(68_000);
  });

  it('多个 key 归并相加到会话行', () => {
    const out = repriceUsageDeltas({
      '反重力-流式抗截断/gemini-3.7-flash-high': { ...gUsage },
      'gemini-3.7-flash': { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 },
    }, 'gemini-3.7-flash');
    expect(Object.keys(out)).toEqual(['gemini-3.7-flash']);
    expect(out['gemini-3.7-flash'].inputTokens).toBe(69_000);
  });

  it('会话行查不到（未知名 / null）→ 原样返回（同一引用，一个字段没动）', () => {
    const deltas = { 'whatever-wire': gUsage };
    expect(repriceUsageDeltas(deltas, 'made-up-model')).toBe(deltas);
    expect(repriceUsageDeltas(deltas, null)).toBe(deltas);
  });

  it('null / 空对象语义保持（context.js 的 fallback 分支依赖）', () => {
    expect(repriceUsageDeltas(null, 'gemini-3.7-flash')).toBe(null);
    expect(repriceUsageDeltas({}, 'gemini-3.7-flash')).toEqual({});
  });

  it('本地 Qwen：零价表让 costUsd 归 0（不按上游虚价记账）', () => {
    const out = repriceUsageDeltas({
      'qwen3.8-27b': { inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 3.21 },
    }, 'qwen3.8-27b');
    expect(Object.keys(out)).toEqual(['qwen3.8-27b']);
    expect(out['qwen3.8-27b'].costUsd).toBe(0);
  });
});

describe('modelSwitchRejection：三条写模型的路共用的那一个判断（08-25 收口）', () => {
  it('协议闸：跑过的 Ox 会话换到 Anthropic 通路要拦；同通路、反向、同模型放行', () => {
    expect(modelSwitchRejection({ from: 'ox-alpha', to: 'minimax-m3' })).toMatch(/新开一个会话/);
    expect(modelSwitchRejection({ from: 'minimax-m3', to: 'ox-alpha' })).toBe(null);
    expect(modelSwitchRejection({ from: 'ox-alpha', to: 'ox-alpha' })).toBe(null);
    expect(modelSwitchRejection({ from: 'ox-alpha', to: 'deepseek-v4-flash-vision' })).toBe(null);
  });

  it('⭐没跑过的会话不拦：这条闸防的是历史里没 signature 的 thinking 块，没历史就没这回事', () => {
    expect(modelSwitchRejection({ from: 'ox-alpha', to: 'minimax-m3', hasHistory: false })).toBe(null);
  });

  it('M3b：running 参数不再有消费（订阅 ↔ API 通路闸随订阅行删除）—— running 时协议闸口径不变', () => {
    expect(modelSwitchRejection({ from: 'ox-alpha', to: 'minimax-m3', running: true })).toMatch(/新开一个会话/);
    expect(modelSwitchRejection({ from: 'minimax-m3', to: 'ox-alpha', running: true })).toBe(null);
  });

  it('缺参数一律放行（调用方还没算出 from/to 时不该误伤）', () => {
    expect(modelSwitchRejection({ from: null, to: 'ox-alpha' })).toBe(null);
    expect(modelSwitchRejection({ from: 'ox-alpha', to: null })).toBe(null);
    expect(modelSwitchRejection({ from: 'ox-alpha', to: undefined, running: true })).toBe(null);
  });

  it('⛔ lint：三条写模型的路只许经这一个函数判，不许自己去调底层闸', () => {
    // 08-21 装的协议闸在 sessions.js 和 turn.js 各手写了一份，两份都写错、活了四天没人发现
    // （一份把闸放在写盘之后、拿写完的值当 from；一份多了个 `override &&` 的条件）。
    // 判据放在这里而不是靠注释：注释里的"调用方必须处理 X"拦不住任何人。
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    for (const f of ['server/api/turn.js', 'server/api/sessions.js', 'server/api/turn-model-switch.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      expect(src, `${f} 不该直接调底层闸，走 modelSwitchRejection`).not.toMatch(/crossLaneSwitchReason\(|hotSwitchLaneReason\(/);
      expect(src, `${f} 应该调 modelSwitchRejection`).toMatch(/modelSwitchRejection\(/);
    }
  });
});

describe('NVIDIA build · Kimi K3 行（08-25）', () => {
  it('走 nvidia 上游、openai-chat 转换层、窗口 272k', () => {
    const r = resolveModelRoute('kimi-k3');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.nvidia);
    expect(r.upstream.baseUrl).toBe('https://integrate.api.nvidia.com/v1');   // openai-chat 路：baseUrl 带 /v1，入口再接 /chat/completions
    expect(r.upstream.protocol).toBe('openai-chat');
    expect(r.upstream.countTokens).toBe(false);   // 没有 count_tokens 端点（404），本地估算
    expect(r.window).toBe(272_000);
    expect(r.wireModel).toBe('moonshotai/kimi-k3');
  });

  it('限流大的行先关在闸后：只对 admin/获批露出，普通账号看不见', () => {
    expect(selectableModelsFor({ role: 'user' }).some((m) => m.id === 'kimi-k3')).toBe(false);
    expect(selectableModelsFor({ role: 'admin' }).some((m) => m.id === 'kimi-k3')).toBe(true);
    expect(allowedModelsFor({ role: 'user' }).some((m) => m.id === 'kimi-k3')).toBe(false);
  });
});

describe('GMI Cloud · MiniMax 行（08-25）', () => {
  it('走 gmi 上游、Anthropic 原生透传（不进 openai-chat 转换层）', () => {
    const r = resolveModelRoute('minimax-m3');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.gmi);
    expect(r.upstream.baseUrl).toBe('https://api.gmi-serving.com');   // ⚠️ 不带 /v1：透传路是 baseUrl + 原始路径
    expect(r.upstream.protocol).toBeUndefined();                      // 没有 protocol = 透传 Anthropic
    expect(r.window).toBe(272_000);
    expect(r.wireModel).toBe('MiniMaxAI/MiniMax-M3');
  });

  it('⛔ M2.7 撤了（GMI 这家部署把图丢掉，判据见 models.json 上游注释与 git 历史）—— 表里和 picker 里都不该有', () => {
    expect(resolveModelRoute('minimax-m2.7')).toBe(null);
    expect(SELECTABLE_MODELS.some((m) => m.id === 'minimax-m2.7')).toBe(false);
    // 留下的这一行仍要能画标：picker 里现在只剩 M3 一行 minimax
    expect(SELECTABLE_MODELS.find((m) => m.id === 'minimax-m3').brand).toBe('minimax');
  });

  it('记账归会话行：免费部署零价表，costUsd 归 0', () => {
    const usage = { inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 1.23 };
    const out = repriceUsageDeltas({ 'MiniMaxAI/MiniMax-M3': { ...usage } }, 'minimax-m3');
    expect(Object.keys(out)).toEqual(['minimax-m3']);
    expect(out['minimax-m3'].costUsd).toBe(0);   // 免费部署，零价表
  });
});

describe('OpenCode Go · DeepSeek V4 Flash Vision 行（08-21 深夜）', () => {
  it('走 zenGo 上游、真名 deepseek-v4-flash-vision-exp、窗口 272k、全档可见', () => {
    const r = resolveModelRoute('deepseek-v4-flash-vision');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.zenGo);
    expect(r.upstream.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(r.window).toBe(272_000);
    expect(r.wireModel).toBe('deepseek-v4-flash-vision-exp');
    // 08-21 深夜开闸给所有档（basic 靠 $5/天日限管着）
    expect(SELECTABLE_MODELS.find((m) => m.id === 'deepseek-v4-flash-vision')?.gate).toBeUndefined();
    for (const u of [{ role: 'user', plan: 'basic' }, { role: 'user', plan: 'pro' }, { role: 'admin' }]) {
      expect(allowedModelsFor(u).map((m) => m.id)).toContain('deepseek-v4-flash-vision');
    }
    expect(modelIsFree('deepseek-v4-flash-vision')).toBe(false);   // 付费行：走 checkQuota 的美元日限，不走免费轮次闸
    // Ox 三行已切 /zen/go
    for (const id of ['ox-alpha', 'ox-alpha-max', 'ox-alpha-helper']) {
      expect(resolveModelRoute(id).upstream).toBe(UPSTREAMS.zenGo);
      expect(resolveModelRoute(id).wireModel).toBe('ox-alpha-free');
    }
  });
});

describe('加载期断言真的会炸（换一张毒表 import 一遍 —— 装了闸就攻一遍，不许只靠代码里写着）', () => {
  const importWithTable = async (mutate) => {
    vi.resetModules();
    const real = await vi.importActual('./models-json.js');
    vi.doMock('./models-json.js', () => ({ ...real, MODELS_BUILTIN: Object.freeze(mutate([...real.MODELS_BUILTIN])) }));
    try {
      return await import('./model-context.js');
    } finally {
      vi.doUnmock('./models-json.js');
      vi.resetModules();
    }
  };

  it('模型 id 撞车 → import 当场 throw，不静默', async () => {
    await expect(importWithTable((rows) => [...rows, {
      id: 'ox-alpha', window: 1_000_000, brand: 'custom',
      api: { upstream: 'gmi', wireModel: 'x' },
    }])).rejects.toThrow(/重复/);
  });

  it('brand 不在 BRANDS → import 当场 throw', async () => {
    await expect(importWithTable((rows) => [...rows, {
      id: 'evil-twin', window: 1_000_000, brand: 'not-a-brand',
      api: { upstream: 'gmi', wireModel: 'x' },
    }])).rejects.toThrow(/brand/);
  });

  it('指向不存在的 upstream → import 当场 throw', async () => {
    await expect(importWithTable((rows) => [...rows, {
      id: 'evil-twin', window: 1_000_000, brand: 'custom',
      api: { upstream: 'no-such-upstream', wireModel: 'x' },
    }])).rejects.toThrow(/upstream/);
  });

  it('对照组：原表原样 import 不炸（证明上面仨不是 import 本身就坏）', async () => {
    const mc = await importWithTable((rows) => rows);
    expect(mc.resolveModelRoute('minimax-m3').mode).toBe('api');
  });
});
