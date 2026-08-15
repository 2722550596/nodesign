/**
 * chatai —— 第二条模型通路（跟 agent 会话完全无关）
 *
 * agent 走 Claude Agent SDK、有工具、会改文件；**chatai 只是一次补全调用**：
 * 传进去 system + messages，回来一段文本和用量。它没有工具、没有会话、
 * 改不了任何东西。
 *
 * 存在的理由不是省钱，是**别让高频生成挤掉设计会话**：订阅通路是全站共享的一个
 * OAuth 额度加并发上限，而生成类动作频次高，一跑起来能把正经设计会话挤没。
 *
 * 通路配置走 env（`CHATAI_BASE_URL` / `CHATAI_API_KEY` / `CHATAI_MODEL`），
 * 密钥不进代码不进 git。
 *
 * 计价：上游中转站的计量口径不透明，所以金额一律按**我们自己的单价表**算，
 * 谁要拿它进配额闸门就用这个数。
 */

import { callOpenAICompat } from './openai-compat.js';

/**
 * 模型表 —— 单价、思考档位、中转站实名，一张表说完（2026-08-15 加思考档）。
 *
 * 单价 USD / 1M token。gemini-3.7-flash 是促销价，2027-01-01 起翻倍到 1.5 / 7.5。
 * 思考 token 按输出计价（Gemini 的口径；Claude 的思考量直接混在 completion_tokens 里）。
 *
 * ⭐ **思考等级在中转站是模型名的一部分，不是请求参数**（2026-08-15 实测它家 100 个
 * 模型：gemini 系是 -low/-medium/-high 三个独立模型名，claude 系是 base 与 -thinking
 * 两个）。所以「档」不发 reasoning_effort，而是换实名。用户那边只看见标准名 + 一个
 * 档位旋钮，换渠道时改这张表就行。
 *
 * 思耗 = 粗估的「思考 token ÷ 正文 token」倍数，只给设置页算预演帐目用，不进计费。
 * 实测（演出类提示，2026-08-15）：gemini flash 正文 234 / 思考 785 ≈ 3.4 倍，且
 * 低/中/高 三档的思考量差异淹在噪声里（785/587/601），别把它当精确旋钮；
 * claude 开思考后正文 363→408、输入 115→144（中转站往提示里塞了东西）。
 */
export const MODEL_SPECS = Object.freeze({
  'gemini-3.7-flash': {
    价: { in: 0.75, out: 3.75 }, 思耗: 3.4,
    注: '$0.75 / $3.75 每百万 · 促销价，思考计入输出',
    默认档: '低',
    档: {
      低: { 名: '反重力-流式抗截断/gemini-3.7-flash-low', 注: '最省，中转站的常规档' },
      中: { 名: '反重力-流式抗截断/gemini-3.7-flash-medium', 注: '中档' },
      高: { 名: '反重力-流式抗截断/gemini-3.7-flash-high', 注: '让它多想一会儿（实测三档差异有限，别指望它是精确旋钮）' },
    },
  },
  'gemini-3.6-flash': {
    价: { in: 0.75, out: 3.75 }, 思耗: 3.4,
    注: '$0.75 / $3.75 每百万 · 上一版，行文更收敛',
    默认档: '低',
    档: {
      低: { 名: '反重力-流式抗截断/gemini-3.6-flash-low', 注: '最省，中转站的常规档' },
      中: { 名: '反重力-流式抗截断/gemini-3.6-flash-medium', 注: '中档' },
      高: { 名: '反重力-流式抗截断/gemini-3.6-flash-high', 注: '让它多想一会儿' },
    },
  },
  'gemini-3-flash': {
    价: { in: 0.50, out: 2.50 }, 思耗: 3.0,
    注: '$0.50 / $2.50 每百万 · 更便宜，思考档不可调',
    实名: '反重力-流式抗截断/gemini-3-flash',
    档: null,
  },
  'claude-sonnet-4-6': {
    价: { in: 3.00, out: 15.00 }, 思耗: 1,
    注: '$3 / $15 每百万 · 文笔更稳，一轮贵一个量级',
    默认档: '关',
    档: {
      关: { 名: '反重力-流式抗截断/claude-sonnet-4-6', 思耗: 1, 注: '不开扩展思考' },
      高: { 名: '反重力-流式抗截断/claude-sonnet-4-6-thinking', 思耗: 1.3, 注: '开扩展思考：思考走单独通道不进台词，但按输出计价' },
    },
  },
  'claude-opus-4-6': {
    价: { in: 15.00, out: 75.00 }, 思耗: 1,
    注: '$15 / $75 每百万 · 只在真的在乎的场合；中转站常报没容量',
    默认档: '关',
    档: {
      关: { 名: '反重力-claude-opus-4-6', 思耗: 1, 注: '不开扩展思考' },
      高: { 名: '反重力-claude-opus-4-6-thinking', 思耗: 1.3, 注: '开扩展思考：思考不进台词，但按输出计价' },
    },
  },
});

/** 档位词表 —— 编排.yaml 只认这四个词，设置页只画模型支持的那几档 */
export const LEVELS = Object.freeze(['关', '低', '中', '高']);

/** 单价表（USD / 1M token），从模型表派生 —— 价格只有一处定义 */
export const PRICES = Object.freeze({
  ...Object.fromEntries(Object.entries(MODEL_SPECS).map(([k, v]) => [k, v.价])),
  _default: { in: 1.00, out: 5.00 },
});

/** 从中转站的花式模型名里认出计价用的底模（`反重力-流式抗截断/gemini-3.7-flash-low`） */
export function priceKeyOf(model) {
  const s = String(model || '').toLowerCase();
  for (const k of Object.keys(PRICES)) {
    if (k !== '_default' && s.includes(k)) return k;
  }
  return '_default';
}

/** 按单价表估这次调用多少钱。缓存读按输入价一折（隐式缓存的通行口径） */
export function costOf(model, usage) {
  const p = PRICES[priceKeyOf(model)];
  const inTok = Math.max(0, (usage.inputTokens || 0) - (usage.cacheReadTokens || 0));
  const cached = usage.cacheReadTokens || 0;
  const outTok = (usage.outputTokens || 0) + (usage.reasoningTokens || 0);
  return (inTok * p.in + cached * p.in * 0.1 + outTok * p.out) / 1e6;
}

export function chataiConfig() {
  const base = (process.env.CHATAI_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.CHATAI_API_KEY || '';
  const model = process.env.CHATAI_MODEL || '';
  return { base, key, model, ok: !!(base && key && model) };
}

/** 简写 → 标准名（历史遗留的手写值，别再往里加） */
const SHORTHAND = Object.freeze({ 'claude-sonnet': 'claude-sonnet-4-6' });

/**
 * 标准模型名 + 思考档 → 中转站实名（2026-08-15 时停之城 503 案 + 思考档）。
 *
 * 中转站的 100 个模型**没有一个裸标准名**，全是「反重力-流式抗截断/xxx」这类
 * 前缀变体，思考等级也编在名字里。而 编排.yaml / 设置页 / skill 教的都是标准名
 * （用户不该学中转站的命名黑话，换渠道也不用改配置）。这层在发请求前换成实名。
 *
 * 档给空或者这个模型不支持这档 → 落到模型的默认档（每个模型的默认档都是最便宜
 * 那档），并把降级理由报回去：设置页只画支持的档，但 编排.yaml 是 agent 和人手写的，
 * 写岔了不该拒开演出，只该说清楚跑的是哪档。
 * 表里没有的模型名原样放行（直接写实名也合法）。env `CHATAI_MODEL_ALIASES`（JSON）
 * 覆盖标准名→实名，写了就绕开档位（中转站哪天改名，改 env 不用动代码）。
 *
 * @returns {{ 名: string, 档: string|null, 降级: string|null, 思耗: number }}
 */
export function resolveModelVariant(model, 档) {
  const empty = { 名: model, 档: null, 降级: null, 思耗: 1 };
  if (!model) return empty;
  let extra = {};
  try { extra = JSON.parse(process.env.CHATAI_MODEL_ALIASES || '{}'); } catch { /* 坏 JSON 当没配 */ }
  if (extra[model]) return { ...empty, 名: extra[model] };

  const canonical = SHORTHAND[model] || model;
  const spec = MODEL_SPECS[canonical];
  if (!spec) return empty;
  if (!spec.档) {
    return {
      名: spec.实名, 档: null, 思耗: spec.思耗,
      降级: 档 ? `${canonical} 的思考档不可调，「${档}」没生效` : null,
    };
  }
  const 生效 = spec.档[档] ? 档 : spec.默认档;
  const v = spec.档[生效];
  return {
    名: v.名, 档: 生效, 思耗: v.思耗 ?? spec.思耗,
    降级: 档 && 生效 !== 档 ? `${canonical} 没有「${档}」档，按默认档「${生效}」跑` : null,
  };
}

/** 只要实名的老口径（默认档） */
export function resolveModelAlias(model) {
  return resolveModelVariant(model).名;
}

/** 给设置页的模型目录：单价、档位、注释都从这一张表来，前端不再各存一份 */
export function modelCatalog() {
  return Object.entries(MODEL_SPECS).map(([id, s]) => ({
    id, 入: s.价.in, 出: s.价.out, 注: s.注, 思耗: s.思耗,
    档: s.档 ? Object.entries(s.档).map(([名, v]) => ({ 名, 思耗: v.思耗 ?? s.思耗, 注: v.注 ?? null })) : [],
    默认档: s.默认档 ?? null,
  }));
}

/**
 * 跑一次 chatai。
 * @param {object} opts  system / messages / model / 思考 / maxTokens / signal / onDelta
 */
export async function runChatai({
  system = '', messages = [], model, 思考 = null, maxTokens = 2000, signal, onDelta,
} = {}) {
  const cfg = chataiConfig();
  if (!cfg.ok) {
    throw Object.assign(
      new Error('chatai 通路没配置（CHATAI_BASE_URL / CHATAI_API_KEY / CHATAI_MODEL）'),
      { code: 'CHATAI_UNCONFIGURED' },
    );
  }
  const v = resolveModelVariant(model || cfg.model, 思考);
  const out = await callOpenAICompat({
    base: cfg.base, key: cfg.key, model: v.名,
    system, messages, maxTokens, signal, onDelta,
  });
  return { ...out, model: v.名, 档: v.档, 降级: v.降级, costUsd: costOf(v.名, out.usage) };
}
