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
 * 单价表（USD / 1M token）。
 * gemini-3.7-flash 是促销价，2027-01-01 起翻倍到 1.5 / 7.5 —— 到时候改这里。
 * 思考 token 按输出计价（Gemini 的口径）。
 */
export const PRICES = Object.freeze({
  'gemini-3.7-flash': { in: 0.75, out: 3.75 },
  'gemini-3.6-flash': { in: 0.75, out: 3.75 },
  'gemini-3-flash': { in: 0.50, out: 2.50 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-opus-4-6': { in: 15.00, out: 75.00 },
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

/**
 * 跑一次 chatai。
 * @param {object} opts  system / messages / model / maxTokens / signal / onDelta
 */
export async function runChatai({
  system = '', messages = [], model, maxTokens = 2000, signal, onDelta,
} = {}) {
  const cfg = chataiConfig();
  if (!cfg.ok) {
    throw Object.assign(
      new Error('chatai 通路没配置（CHATAI_BASE_URL / CHATAI_API_KEY / CHATAI_MODEL）'),
      { code: 'CHATAI_UNCONFIGURED' },
    );
  }
  const useModel = model || cfg.model;
  const out = await callOpenAICompat({
    base: cfg.base, key: cfg.key, model: useModel,
    system, messages, maxTokens, signal, onDelta,
  });
  return { ...out, model: useModel, costUsd: costOf(useModel, out.usage) };
}
