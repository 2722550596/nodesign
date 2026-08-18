/**
 * server/engine/agent/model-context.js — model 双映射 source of truth：
 *
 * 1. **resolveSdkSpoofModel(appModel)** — 决定喂给 SDK 的 model 字符串。
 *    SDK binary 内部 model registry 不识别 kimi-*（cli.js strings 0 hit），
 *    rawMaxTokens fallback 到 Claude 200k 默认值。链式后果：
 *      maxTokens = min(autoCompactWindow=230400, rawMaxTokens=200000) = 200000
 *      SDK auto-compact 触发于 ~180k，浪费 60k+ Kimi gateway 真实容量
 *    把 sdkOptions.model 设成 SDK 认的 1M context alias（claude-opus-4-7[1m]），
 *    SDK 信 rawMaxTokens=1M，autoCompactWindow=230400 真生效，compact 在
 *    256k×0.9=230k 触发，留 26k margin 防 Kimi 网关 400。
 *    proxy（binary-fixup-proxy.js）在出口把 alias 还原成真 model，gateway
 *    收到的仍是 kimi-k2.6，零兼容问题。
 *
 * 2. **resolveModelContextWindow(appModel)** — NoDesign 显示/警告用的真实容量。
 *    用于 ContextUsageBar 进度条 + hooks.js 警告分档计算。SDK 给的 maxTokens
 *    是触发 auto-compact 的阈值（230400），不是 gateway 硬上限（256000）。
 *
 * Claude 真 1M / 标准模型直接用真名（SDK 认）；只有 Kimi 走 spoofing。
 */

const APP_TO_SDK_MODEL = {
  'kimi-k2.6':              'claude-opus-4-7[1m]',
  'kimi-k2':                'claude-opus-4-7[1m]',
  'claude-sonnet-5[1m]':    'claude-sonnet-5[1m]',
  'claude-sonnet-5':        'claude-sonnet-5',
  'claude-opus-5[1m]':      'claude-opus-5[1m]',
  'claude-opus-5':          'claude-opus-5',
  'claude-opus-4-7[1m]':    'claude-opus-4-7[1m]',
  'claude-sonnet-4-6[1m]':  'claude-sonnet-4-6[1m]',
  'claude-opus-4-7':        'claude-opus-4-7',
  'claude-sonnet-4-6':      'claude-sonnet-4-6',
  'claude-haiku-4-5':       'claude-haiku-4-5',
};

const APP_MODEL_REAL_WINDOW = {
  'kimi-k2.6':              256_000,
  'kimi-k2':                256_000,
  'claude-sonnet-5[1m]':    1_000_000,
  'claude-sonnet-5':        200_000,
  'claude-opus-5[1m]':      1_000_000,
  'claude-opus-5':          200_000,
  'claude-opus-4-7[1m]':    1_000_000,
  'claude-sonnet-4-6[1m]':  1_000_000,
  'claude-opus-4-7':        200_000,
  'claude-sonnet-4-6':      200_000,
  'claude-haiku-4-5':       200_000,
};

/**
 * 前端 picker 能选的模型 —— 放在这里而不是前端硬编码，是因为 id 必须跟上面
 * 两张表对得上：写错一个字，spoofing 查不到、真实容量查不到，两处都只会静默
 * 降级（SDK 自己 fallback + 进度条分母掉回 compact 触发线），没人会报错。
 *
 * label / desc 是给用户看的短名；null 那一档（跟随全局默认）由前端自己加，
 * 因为"默认是谁"是运行时的 env，不是这张表的内容。
 */
export const SELECTABLE_MODELS = Object.freeze([
  Object.freeze({
    id: 'claude-sonnet-5[1m]',
    label: 'Sonnet 5',
    desc: '快 · 日常改稿和铺页够用',
  }),
  Object.freeze({
    id: 'claude-opus-5[1m]',
    label: 'Opus 5',
    desc: '前端与审美更强 · 烧订阅额度快得多，重活再开',
  }),
]);

/**
 * 决定 sdkOptions.model 喂什么。未知 model 原样返回（让 SDK 自己 fallback）。
 */
export function resolveSdkSpoofModel(appModel) {
  if (!appModel) return appModel;
  return APP_TO_SDK_MODEL[appModel] || appModel;
}

/**
 * 真实 context window（tokens）。命中表查表；未命中按 pattern fallback；
 * 都不匹配返 null（调用方用 SDK rawMaxTokens 兜底）。
 */
export function resolveModelContextWindow(appModel) {
  if (!appModel) return null;
  if (APP_MODEL_REAL_WINDOW[appModel]) return APP_MODEL_REAL_WINDOW[appModel];
  if (/^kimi[-_]/i.test(appModel)) return 256_000;
  if (/\[1m\]$/i.test(appModel))   return 1_000_000;
  return null;
}

/**
 * 按 model id 选 thinking config（SDK 把 thinking 通道按模型分两路）。
 *
 * sdk.d.ts:1374-1385 + :5342-5368：
 *   - { type: 'adaptive' } 仅 Opus 4.6+ 支持（Claude 自决何时/多少 thinking，是这些模型的 SDK 默认）
 *   - { type: 'enabled', budgetTokens } 是 older-model 路径（Sonnet 4.5 / Sonnet 4 / Haiku 4.5 / 第三方）
 *
 * Kimi K2.6 走 Anthropic 协议但 capability 跟 Sonnet 4.5 同级 —— 视同 older
 * model 走 enabled 路径。adaptive 在非 Opus 4.6+ 上等于不开 thinking
 * （H3 实测：Kimi+adaptive → jsonl 0 thinking blocks），所以默认走 enabled。
 *
 * Future-proof 设计：
 *   - claude-opus-4-[6789] 覆盖 4.6/4.7/4.8/4.9
 *   - claude-opus-[5-9] 覆盖 5.x/6.x/7.x/8.x/9.x（默认假设 Opus 新一代仍走 adaptive）
 *   - 新一代 Opus 改了行为时再扩 regex
 */
export function pickThinkingConfig(model) {
  // adaptive 一族：Opus 4.6+ / Sonnet 5+ / Fable / Mythos。
  // ⚠️ Sonnet 5 起 budgetTokens 已被 API 移除（enabled+budget 会 400），
  // 不能再落到 enabled 分支 —— 2026-07-23 订阅模式切 sonnet-5 时修。
  if (model && /^claude-(?:opus-(?:4-[6789]|[5-9])|sonnet-[5-9]|fable|mythos)/.test(model)) {
    // display 必须显式 'summarized' —— Sonnet 5 / Opus 4.7+ 默认 'omitted'：
    // thinking 照常发生（照常计费）但流出的 thinking 块是空文本 → 前端思考期
    // 完全静默，用户以为后端死了（2026-07-23 "失联"问题的主因）。
    return { type: 'adaptive', display: 'summarized' };
  }
  return { type: 'enabled', budgetTokens: 8192 };
}
