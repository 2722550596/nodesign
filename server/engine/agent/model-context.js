/**
 * server/engine/agent/model-context.js — 模型的单一真相源（2026-08-19 重建）。
 *
 * 历史形态是三张平行表（APP_TO_SDK_MODEL / APP_MODEL_REAL_WINDOW / SELECTABLE_MODELS），
 * 文件头自己就写着"写错一个字，两处都只会静默降级"。现在收成一张 MODELS 表 +
 * 一张 UPSTREAMS 表，旧的每个导出都从表派生，加载时做一致性断言（撞车当场炸，
 * 不静默）。
 *
 * ## 两条通路
 *
 * - **订阅**（没有 api 字段的行）：模型真名 SDK 认识，session-loop 不注入任何
 *   ANTHROPIC_* env，binary 走 ~/.claude 的 OAuth。今天生产的全部流量。
 * - **API**（有 api 字段的行）：请求经 server/lib/model-ingress.js（进程内
 *   Anthropic 范式通用入口）打到上游。SDK 视角看到的是 sdkAlias（让它把
 *   context window 算对），入口在出口把 alias 还原成 wireModel、按上游换钥匙、
 *   按行开怪癖修补（tool_result 图片提升等）。
 *
 * ## SDK spoofing 为什么存在（Kimi 时代的发现，机制不变）
 *
 * SDK binary 内部 model registry 不识别非 Claude 名 → rawMaxTokens fallback
 * 200k → auto-compact 在 ~180k 触发，浪费上游真实容量。喂 SDK 一个它认识的
 * 1M alias，autoCompactWindow=230400 真生效。SDK 序列化请求时会剥 `[1m]`
 * 后缀，所以入口的反查表要同时认带后缀和不带后缀两种形态。
 *
 * ## 记账
 *
 * SDK 的 costUSD 按 alias 的 Claude 价目表算，API 模型全是虚价（Kimi 时代按
 * Opus 价虚高 30×）。repriceUsageDeltas 把 usage key 还原成 appModel、按行内
 * prices 重算 costUsd。行没填 prices = 沿用 SDK 虚价（接真流量前必须填价）。
 *
 * ⚠️ 硬约束：一个 sdkAlias 不能被两个 API 模型共用 —— 反查靠它，撞了整条
 * 路由和记账都错。模块加载断言兜底。
 */

/**
 * API 上游注册表。keyEnv 是 env 变量名（真钥匙在 .env，不进代码不进 git）。
 * authStyle：'x-api-key'（Anthropic 原生头）| 'bearer'（Authorization: Bearer）。
 * countTokens：上游有没有 /v1/messages/count_tokens。false = 入口直接本地估算；
 * true = 先转发，404 再回退本地（capability 探针缓存见 model-ingress.js）。
 */
export const UPSTREAMS = Object.freeze({
  lament: Object.freeze({
    label: '中转站 api.lament0.link',
    baseUrl: 'https://api.lament0.link',
    keyEnv: 'NODESIGN_UPSTREAM_LAMENT_KEY',
    authStyle: 'x-api-key',
    countTokens: false,   // 08-19 探针：404
  }),
  moonshot: Object.freeze({
    label: 'Moonshot Anthropic 兼容端点',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    keyEnv: 'NODESIGN_UPSTREAM_MOONSHOT_KEY',
    authStyle: 'x-api-key',
    countTokens: true,
  }),
  // 本地盒子（featurize 租的 5090 跑 llama-server，SSH 隧道 -L 到本机）。
  // llama.cpp 2025-11-28 起原生带 /v1/messages（含 count_tokens、SSE、tool_use、
  // vision；工具调用要 --jinja）—— 不需要任何协议转换层。authStyle 'none'：
  // llama-server 无鉴权，隧道只绑环回。箱子不开机时请求 ECONNREFUSED → 502，
  // fail-loud 语义正确。
  qwenLocal: Object.freeze({
    label: '本地 llama-server（SSH 隧道）',
    baseUrl: process.env.NODESIGN_UPSTREAM_QWEN_LOCAL_URL || 'http://127.0.0.1:8080',
    keyEnv: null,
    authStyle: 'none',
    countTokens: true,
  }),
});

/**
 * 模型总表。字段：
 *   id       appModel —— 全站唯一标识（session-config / NODESIGN_MODEL / 计量落表都用它）
 *   window   真实 context window（ContextUsageBar 分母 + hooks 警告分档）
 *   select   出现在前端 picker 的 {label, desc}；没有 = 不对用户暴露
 *   api      API 通路配置（没有 = 订阅通路）：
 *     upstream   UPSTREAMS 的 key
 *     wireModel  发给上游的真模型名（入口出口替换）
 *     sdkAlias   喂 SDK 的 spoof 名（必须是 SDK 认识的 Claude 名；⚠️全表唯一）
 *     fastModel  该路的 helper/subagent 模型（必须也是本表可路由的 id；
 *                订阅的 haiku 在 API 模式不可用 —— binary 见 API key 即弃 OAuth，
 *                helper 请求同样走唯一的 BASE_URL）
 *     thinking   'strip'（出口删 thinking 字段，上游自决）| 'enabled8k'
 *                （出口把 adaptive 改写成 enabled+budget 8192，Kimi 实测需要）
 *     liftImages tool_result 里的图提升到 user message 顶层（Kimi 与 Gemini 桥
 *                都丢 tool_result 图，08-19 探针实锤 + 修法验证）
 *     prices     每 1M token 的 USD {input, output, cacheRead, cacheWrite}；
 *                没填 = 沿用 SDK 按 alias 算的虚价（接真流量前先填）
 */
const MODELS = Object.freeze([
  // ── 订阅通路（Claude 真名，零注入）──
  {
    id: 'claude-sonnet-5[1m]', window: 1_000_000,
    select: { label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用' },
  },
  {
    id: 'claude-opus-5[1m]', window: 1_000_000,
    select: { label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开' },
  },
  { id: 'claude-sonnet-5',       window: 200_000 },
  { id: 'claude-opus-5',         window: 200_000 },
  { id: 'claude-opus-4-7[1m]',   window: 1_000_000 },
  { id: 'claude-sonnet-4-6[1m]', window: 1_000_000 },
  { id: 'claude-opus-4-7',       window: 200_000 },
  { id: 'claude-sonnet-4-6',     window: 200_000 },
  { id: 'claude-haiku-4-5',      window: 200_000 },

  // ── API 通路 ──
  // kimi-k2 已删：与 k2.6 共用 alias 是历史遗留，反查表容不下撞车，且 NoDesk
  // 退役后那条路本来就没钥匙。session-model.js 的 LEGACY_FALLBACK 是 k2.6，保住。
  {
    id: 'kimi-k2.6', window: 256_000,
    api: {
      upstream: 'moonshot', wireModel: 'kimi-k2.6',
      sdkAlias: 'claude-opus-4-7[1m]',
      fastModel: 'kimi-k2.6',      // 旧的 DMXAPI haiku-cc 随 NoDesk 一起退役
      thinking: 'enabled8k',       // adaptive 在 Kimi 上 = 0 thinking blocks（H3 实测）
      liftImages: true,
      prices: null,                // Moonshot 现价没核实过 —— 接真流量前先填
    },
  },
  // 本地 Qwen（HauhauCS/Qwen3.8-27B-Uncensored-…-Aggressive-MTP-GGUF，底座官方
  // Qwen3.8-27B，有视觉）。⚠️ window 必须跟箱子 llama-server 的 -c 一致：低了
  // 会在 SDK 触发 auto-compact 之前先撞上游 400。262144 = 该模型原生上限
  // （YaRN 可外推到 1M，但那要额外开 rope 参数且短上下文质量有代价，不默认走）。
  // alias 用 1M 档：SDK 按 alias 查 rawMaxTokens，用 200k 名会让 auto-compact 在
  // ~180k 就触发，白扔 80k。⚠️ 这个 alias 同时是线上可选的订阅模型名，安全性靠两点
  // （改动前先确认它们还成立）：①订阅会话根本不进 ingress，WIRE_LOOKUP 只服务
  // API 会话；②repriceUsageDeltas 先看会话通路，订阅会话原样早退不 remap。
  {
    id: 'qwen3.8-27b', window: 262_144,
    // gate 'localGen'：跟 roll_film / paint_still 同一套批准制（admin 免批）——
    // 它本来就跑在同一台本地盒子上，语义天然一致。盒子没开时它会 fail-loud 502，
    // 所以绝不能对没批准的账号露出来。
    select: { label: 'Qwen3.8 27B（本地）', desc: '本地盒子 · 无审查 · 盒子没开时不可用', gate: 'localGen' },
    api: {
      upstream: 'qwenLocal', wireModel: 'qwen3.8-27b',
      sdkAlias: 'claude-opus-5[1m]',
      fastModel: 'qwen3.8-27b',
      thinking: 'enabled8k',
      // ⭐ 08-19 盒上体检 9/9：llama.cpp 的 /v1/messages **原生直通 tool_result 图片**
      // （中转站 Gemini 桥正是死在这一项）。原样直通比提升到顶层更忠实，故关掉 lift。
      liftImages: false,
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },   // 本地盒子按租金付费，token 记 0（不然按 opus-5 虚价记账）
    },
  },
  {
    id: 'gemini-3.1-pro', window: 1_000_000,
    api: {
      upstream: 'lament', wireModel: '中转-gemini-3.1-pro-preview',
      // sonnet-4-6[1m] 对 Gemini 3.1 Pro 是诚实的（真 1M 窗口）。订阅路的真
      // claude-sonnet-4-6 不经入口（无 api 字段），不撞。
      sdkAlias: 'claude-sonnet-4-6[1m]',
      fastModel: 'gemini-3.1-pro',
      thinking: 'strip',           // Gemini thinking 关不掉，参数过桥行为未知 —— 出口删掉让上游自决
      liftImages: true,            // 08-19 探针：桥把 tool_result 图转成文本，提升到顶层修法已验证
      // 官方牌价（>200k 档 $4/$18 未分档 —— 单轮跨档的少数请求会低估，先接受）。
      // ⚠️ 中转站自己的计量单位不明，这里的 USD 是配额/展示用的近似。
      prices: { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 0 },
    },
  },
]);

// ── 派生索引（模块加载时构建 + 断言）──

const BY_ID = new Map();
/** wire 名（appModel / sdkAlias / alias 剥 [1m] 后缀形态）→ 行。入口反查用 */
const WIRE_LOOKUP = new Map();

for (const row of MODELS) {
  if (BY_ID.has(row.id)) throw new Error(`[model-context] 模型 id 重复：${row.id}`);
  BY_ID.set(row.id, row);
}
for (const row of MODELS) {
  if (!row.api) continue;
  if (!UPSTREAMS[row.api.upstream]) {
    throw new Error(`[model-context] ${row.id} 指向不存在的 upstream: ${row.api.upstream}`);
  }
  if (!row.api.sdkAlias || !BY_ID.has(row.api.sdkAlias) || BY_ID.get(row.api.sdkAlias).api) {
    // alias 必须是本表里的订阅 Claude 名 —— SDK 才认识、窗口才查得到
    throw new Error(`[model-context] ${row.id} 的 sdkAlias 必须是表内订阅模型名：${row.api.sdkAlias}`);
  }
  const fast = BY_ID.get(row.api.fastModel);
  if (!fast || !fast.api) {
    throw new Error(`[model-context] ${row.id} 的 fastModel 必须是表内 API 模型：${row.api.fastModel}`);
  }
  const keys = [row.id, row.api.sdkAlias, row.api.sdkAlias.replace(/\[1m\]$/i, '')];
  for (const k of keys) {
    const prev = WIRE_LOOKUP.get(k);
    if (prev && prev !== row) {
      throw new Error(`[model-context] wire 名撞车：'${k}' 同时属于 ${prev.id} 和 ${row.id}（一个 sdkAlias 不能共用）`);
    }
    WIRE_LOOKUP.set(k, row);
  }
}

// ── 旧导出（签名不变，全部改为查表）──

/**
 * picker 的**全量**清单（含带闸门的行）。⚠️ 对外接口一律用
 * `selectableModelsFor(user)`，直接用这个等于把闸门拆了。保留导出是因为它是
 * 「表里哪些行可选」的唯一真相，闸门只是在它上面过滤。
 */
export const SELECTABLE_MODELS = Object.freeze(
  MODELS.filter((m) => m.select).map((m) => Object.freeze({ id: m.id, ...m.select })),
);

/**
 * 按用户过滤可选模型。`gate: 'localGen'` 的行只对 admin / 已批准本地产线的账号
 * 露出（同 roll_film / paint_still 那套批准制）。
 *
 * ⚠️ 三处消费方必须都走它：GET /model 的清单、PUT /model 的校验、turn.js 的
 * body.model 校验。少一处就是一个绕过闸门的后门 —— 2026-08-19 的独立评审
 * 正是在 turn.js 抓到过这种漏校验。
 */
export function selectableModelsFor(user) {
  const approved = user?.role === 'admin' || !!user?.allowLocalGen;
  return SELECTABLE_MODELS.filter((m) => !m.gate || (m.gate === 'localGen' && approved));
}

/** 决定 sdkOptions.model 喂什么。API 行给 alias；订阅/未知原样返回（让 SDK 自己 fallback） */
export function resolveSdkSpoofModel(appModel) {
  if (!appModel) return appModel;
  const row = BY_ID.get(appModel);
  return row?.api ? row.api.sdkAlias : appModel;
}

/** 真实 context window。查表；未命中按 pattern fallback；都不匹配返 null */
export function resolveModelContextWindow(appModel) {
  if (!appModel) return null;
  const row = BY_ID.get(appModel);
  if (row) return row.window;
  if (/^kimi[-_]/i.test(appModel)) return 256_000;
  if (/\[1m\]$/i.test(appModel))   return 1_000_000;
  return null;
}

/**
 * 按 model 选 thinking config（喂 sdkOptions.thinking）。
 *
 * API 行统一走 enabled+budget（older-model 路径）——真正的出口形态由
 * model-ingress 按行内 thinking 字段决定（'strip' 会把字段整个删掉），
 * 这里给 SDK 的值只影响 SDK 内部行为，不到线上。
 *
 * 订阅行沿用原 regex 逻辑：
 *   - adaptive 一族：Opus 4.6+ / Sonnet 5+ / Fable / Mythos。
 *     ⚠️ Sonnet 5 起 budgetTokens 已被 API 移除（enabled+budget 会 400）。
 *   - display 必须显式 'summarized'：默认 'omitted' 时 thinking 块是空文本，
 *     前端思考期完全静默（2026-07-23 "失联"问题主因）。
 */
export function pickThinkingConfig(model) {
  const row = model ? BY_ID.get(model) : null;
  if (row?.api) return { type: 'enabled', budgetTokens: 8192 };
  if (model && /^claude-(?:opus-(?:4-[6789]|[5-9])|sonnet-[5-9]|fable|mythos)/.test(model)) {
    return { type: 'adaptive', display: 'summarized' };
  }
  return { type: 'enabled', budgetTokens: 8192 };
}

// ── 新导出：路由 ──

/**
 * 会话模型 → 通路描述。session-loop 据此决定 env 注入。
 *
 * `window` 要喂给 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：2026-08-19 盒上实测，
 * SDK 的压缩窗口 = **min(该 env, 别名的 rawMaxTokens)**（getContextUsage 的
 * autocompactSource 会从 model-default/auto 变成 env）。两个都得对：
 *   - 只靠别名：200k 名白扔容量，1M 名会一路涨到远超上游 n_ctx 然后炸
 *   - 只靠 env：会被别名的 rawMaxTokens 钳住（200k 别名 + env 262144 = 200000）
 * 所以 sdkAlias 一律选 1M 档打底，真实值由这个 env 钉死。
 *
 * @returns {{ mode: 'subscription' } | {
 *   mode: 'api', appModel: string, sdkAlias: string, fastModel: string,
 *   window: number, upstreamId: string, upstream: object,
 * }}
 */
export function resolveModelRoute(appModel) {
  const row = appModel ? BY_ID.get(appModel) : null;
  if (!row?.api) return { mode: 'subscription' };
  return {
    mode: 'api',
    appModel: row.id,
    sdkAlias: row.api.sdkAlias,
    fastModel: row.api.fastModel,
    window: row.window,
    upstreamId: row.api.upstream,
    upstream: UPSTREAMS[row.api.upstream],
  };
}

/**
 * 入口反查：请求 body.model（可能是 appModel、sdkAlias 或剥了 [1m] 的 alias）
 * → 该发往哪里、怎么修。查不到返回 null（入口 fail-loud 502，不静默转发）。
 */
export function resolveWireModel(bodyModel) {
  const row = typeof bodyModel === 'string' ? WIRE_LOOKUP.get(bodyModel) : null;
  if (!row) return null;
  return {
    appModel: row.id,
    wireModel: row.api.wireModel,
    upstreamId: row.api.upstream,
    upstream: UPSTREAMS[row.api.upstream],
    thinking: row.api.thinking || 'strip',
    liftImages: !!row.api.liftImages,
  };
}

/**
 * usage 差分 reprice：key 从 SDK alias 还原成 appModel，按行内 prices 重算
 * costUsd。多个 key 归并到同一 appModel 时逐字段相加。context.js 的
 * absorbResult 在差分之后调这一步。
 *
 * ⚠️ 必须带 sessionAppModel 且只对 API 会话生效：SDK 报的 usage key 是 alias，
 * 而 alias 同时也是真实存在的订阅 Claude 名（sonnet-4-6[1m] 既是 Gemini 的
 * spoof 也是一个真模型）——不看会话通路就 remap，订阅会话跑 sonnet-4-6 会被
 * 错记成 Gemini 的账。订阅会话原样返回，一个字段都不动。
 *
 * @param {Record<string, {inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd}>} deltas
 * @param {string} sessionAppModel  本会话的 appModel（AgentContext.appModel）
 * @returns 同构对象（API 会话新建；订阅会话原样返回入参）
 */
export function repriceUsageDeltas(deltas, sessionAppModel) {
  if (!deltas || typeof deltas !== 'object') return deltas;
  const sessionRow = sessionAppModel ? BY_ID.get(sessionAppModel) : null;
  if (!sessionRow?.api) return deltas;
  // API 会话的所有请求必经 ingress：表内 key 按表归；不在表里的 key（SDK 内部
  // helper 用 config 默认 Claude 名发的请求）必然被 ingress 的会话 fast 兜底
  // 承接 —— 归到 fastModel 头上是精确归因，不是猜测。
  const fastRow = BY_ID.get(sessionRow.api.fastModel);
  const out = {};
  for (const [key, d] of Object.entries(deltas)) {
    const row = WIRE_LOOKUP.get(key) || fastRow;
    const appKey = row ? row.id : key;
    const p = row?.api?.prices;
    const repriced = p ? {
      ...d,
      costUsd: (
        d.inputTokens * p.input
        + d.outputTokens * p.output
        + d.cacheReadTokens * (p.cacheRead || 0)
        + d.cacheCreateTokens * (p.cacheWrite || 0)
      ) / 1e6,
    } : { ...d };
    const prev = out[appKey];
    out[appKey] = prev ? {
      inputTokens: prev.inputTokens + repriced.inputTokens,
      outputTokens: prev.outputTokens + repriced.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + repriced.cacheReadTokens,
      cacheCreateTokens: prev.cacheCreateTokens + repriced.cacheCreateTokens,
      costUsd: prev.costUsd + repriced.costUsd,
    } : repriced;
  }
  return out;
}
