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
