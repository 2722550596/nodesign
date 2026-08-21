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
    // ⚠️ llama.cpp 的图片解码走 stb_image，**它不认 webp**。而本站 turn-compose 的
    // 白名单是放 webp 进来的（封面和截图链路正是产 webp）。解不开时 mtmd 会顺序
    // 兜底 image → audio → video，最后那条要 ffprobe，盒上没装，于是上游返回的是
    // 一句看不出真因的 400「Failed to load image or audio file」——
    // 08-19 生产真撞过两次，日志里翻到 mtmd_helper 才定位到。
    //
    // 声明成"这个上游真解得开什么"，入口负责把不在表里的转码过去（见
    // model-ingress.normalizeImages）。不填 = 什么都能吃，中转站那两个上游维持原样。
    imageFormats: Object.freeze(['image/png', 'image/jpeg']),
  }),
  // OpenCode Zen（08-21）：免费 stealth 模型 Ox Alpha 只有 OpenAI chat 格式能用工具
  // （它的 /v1/messages 桥一带 tools 就 [1210]，四种写法探死）。protocol 'openai-chat'
  // 让 ingress 走 lib/ingress/openai-chat.js 的协议转换而不是透传；其余上游没有这个
  // 字段 = 透传 Anthropic。钥匙在 .env（NODESIGN_UPSTREAM_ZEN_KEY）。
  zen: Object.freeze({
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyEnv: 'NODESIGN_UPSTREAM_ZEN_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,   // 08-21 探针：404
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
    select: { label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用', gate: 'subscription' },
  },
  {
    id: 'claude-opus-5[1m]', window: 1_000_000,
    select: { label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开', gate: 'subscription' },
  },
  { id: 'claude-sonnet-5',       window: 200_000 },
  { id: 'claude-opus-5',         window: 200_000 },
  { id: 'claude-opus-4-7[1m]',   window: 1_000_000 },
  { id: 'claude-sonnet-4-6[1m]', window: 1_000_000 },
  { id: 'claude-opus-4-7',       window: 200_000 },
  { id: 'claude-sonnet-4-6',     window: 200_000 },
  { id: 'claude-haiku-4-5',      window: 200_000 },
  // 只当 alias 用的订阅名（08-20）：SDK 二进制认识的 1M 名里还空着的一个（strings 扫过：
  // opus-4-6/4-7/4-8/5、sonnet-4-5-20250929/4-6/5 七个 [1m]），给 gemini-3.7-flash 行做 spoof。
  { id: 'claude-opus-4-6[1m]',   window: 1_000_000 },
  // 同上，给 ox-alpha 行做 spoof（08-21）
  { id: 'claude-opus-4-8[1m]',   window: 1_000_000 },

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
    // window 必须等于盒上 llama-server 启动日志里的 `n_ctx_slot`（每槽上下文），低了 SDK
    // 在 auto-compact 之前先撞上游 400。08-20 起盒子是 RTX 5090 32G：OrcaRouter Q5_K_M +
    // 视觉 + MTP 投机 + 1 槽 × 131072，再留 ~5G 给同卡的 ComfyUI（noobai）。换回 96G 盒子
    // 就是 262_144 × 3 槽。盒上配置住 ops/qwen-box/（serve-prod.sh），两边要一起改。
    id: 'qwen3.8-27b', window: 131_072,
    // ⏸ **08-20 用户拍板从 picker 摘牌**（盒子按小时租，已关机）。删掉 `select` 一处，
    // 三个消费方一起拒：GET /api/me/models 的清单、PUT /model 的校验、turn.js 的
    // body.model 校验（都走 selectableModelsFor —— 所以摘牌不会留后门）。
    // **线路原样留着**：下面 api 字段一个字没动，WIRE_LOOKUP / resolveSessionWire /
    // 记账 reprice 全照旧；已经钉在 qwen 的老会话仍会路由过去，盒子没开就 502 fail-loud
    // （这是设计，不是 bug）。同理 gemini-3.1-pro 那行也是「留行不留牌」，先例在下面。
    // 复牌 = 把这一行放回来，别的都不用动：
    //   select: { label: 'Qwen3.8 27B（本地）', desc: '本地盒子 · 无审查 · 盒子没开时不可用', gate: 'localGen' },
    // ⚠️ 复牌时别丢 `gate: 'localGen'` —— 跟 roll_film / paint_still 同一套批准制
    // （admin 免批），它本来就跑在同一台本地盒子上，语义天然一致；没这个闸就是对
    // 所有账号露出一个「一按就 502」的按钮。
    // 无审查权重跑在自己租的盒子上（不出网、零成本、只对获批账号开）。这条路上
    // prelude 的整节「底线」不注入 —— 站主 08-19 拍板，理由是那节是**平台对外
    // 开放**才需要的产物政策（产物能一键挂到站主域名下），而这台盒子上跑的是
    // 个人写作/角色扮演，那节只会让模型对正常输入畏手畏脚。
    //
    // 标记位住在表里而不是写成 `if (model === 'qwen3.8-27b')`：它是**模型属性**，
    // 跟 gate / prices 同级。散在 session-loop 里就是给这张表开第二个真相源，
    // 这个仓库为「同一件东西有多个实例」付过最贵的学费。以后再接一个无审查模型
    // 只加这一个字段，一行逻辑都不用动。
    uncensored: true,
    // ⭐ **盒上 llama-server 的 `-np`（slot 数）应当等于 `NODESIGN_MAX_CONCURRENT_RUNS`。**
    //   slot 比闸多 → 白占显存（每路一份满窗 KV）
    //   slot 比闸少 → 请求在 llama-server 里排队，而 Nodesign 以为自己还有余量，
    //                 用户看到的是无解释的慢，不是「现在有点挤」那句诚实的 BUSY
    // 08-19 的 96G 盒子两边都是 3（巧合不是设计）；**08-20 起的 5090 32G 盒子是 `-np 1`
    // 而闸仍是 3 —— 已知走偏**，出路是按模型给 maxConcurrent（⏸ 未拍板），在那之前
    // 第 2 个 qwen 请求就是在盒上排队。盒上脚本在 ops/qwen-box/（serve.sh=96G，
    // serve-prod.sh=5090），改任何一边都要改另一边；这条契约没法用 lint 拦 ——
    // `server/lib/_ingress-check.mjs` 第 6 项会真查 /slots 比对，换机后跑一次。
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
    // 不进 picker（08-20 用户拍板要 3.7 Flash 不要 3.1 Pro）。行保留：它是中转站唯一稳定的
    // 「中转-」通道，`_ingress-check.mjs` 拿它当接入体检的对照组。
    api: {
      upstream: 'lament', wireModel: '中转-gemini-3.1-pro-preview',
      // sonnet-4-6[1m] 对 Gemini 3.1 Pro 是诚实的（真 1M 窗口）。订阅路的真
      // claude-sonnet-4-6 不经入口（无 api 字段），不撞。
      sdkAlias: 'claude-sonnet-4-6[1m]',
      fastModel: 'gemini-3.1-pro',
      // 'strip' = 出口删掉 thinking 字段让上游自决。08-20 探针（同一题各打两轮）：
      // enabled 2k / 32k / adaptive / output_config.effort=high 在这个中转站上**全无可观测
      // 效果** —— 不 400、不回 thinking 块、output_tokens 是噪声（none 两轮 1417 vs 63）。
      // Gemini 3.1 Pro 自身默认 thinking_level=high，所以"默认高"就是 strip；这里没有
      // 可调的旋钮，别为它造一个。
      thinking: 'strip',
      liftImages: true,            // 08-19 探针：桥把 tool_result 图转成文本，提升到顶层修法已验证
      // 官方牌价（>200k 档 $4/$18 未分档 —— 单轮跨档的少数请求会低估，先接受）。
      // ⚠️ 中转站自己的计量单位不明，这里的 USD 是配额/展示用的近似。
      prices: { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 0 },
    },
  },
  {
    id: 'gemini-3.7-flash', window: 1_000_000,
    // 08-20 用户拍板：要 3.7 Flash，先用中转站 + lift shim 顶着。它只在中转站的「反重力-」
    // 通道上有（转卖 Antigravity OAuth 额度），今天体检 6/9：文本/视觉/非流式 tool_use/
    // prompt cache 真命中（cache_read 8162）都好；流式 stop_reason 恒=end_turn（假上游实验证明
    // CLI 认块不认 stop_reason，无功能后果）；tool_result 图丢靠 liftImages 修。⛔硬伤是
    // 「当前无可用凭证」500 说来就来、不分请求大小、一来就是整段时间 —— 所以同 qwen 走
    // localGen 闸，label 写明不稳定，只给自己人。思考档在模型名里（-high/-medium/-low），
    // 选 high 即"默认高"；thinking 参数照旧 strip。
    select: { label: 'Gemini 3.7 Flash（中转）', desc: '反重力通道 · 随时可能 500 · 思考档 high', gate: 'localGen' },
    api: {
      upstream: 'lament', wireModel: '反重力-流式抗截断/gemini-3.7-flash-high',
      sdkAlias: 'claude-opus-4-6[1m]',     // 3.7 Flash 真 1M 窗口，alias 诚实；见上面那行订阅名的注释
      fastModel: 'gemini-3.7-flash',
      thinking: 'strip',
      liftImages: true,
      // 官方促销价（2027-01-01 起翻倍 $1.5/$7.5）；缓存命中按输入价一折。中转站计量单位不明，
      // 这里的 USD 仍是配额/展示用的近似。
      prices: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    },
  },
  // ── OpenCode Zen · Ox Alpha（08-21，用户称「大事」的第一块）──
  // 真 id x-preview-f-free（models.dev name "Ox Alpha Free"；/models 列表里没有带 ox 的名，别按名猜）。
  // 1M ctx / 131k out / 图+视频 / 工具 / reasoning effort low|high|max / 价 0；官方「free for
  // the next week」（08-20 公告）+ zero-retention 不训练。大概率 GLM 系 stealth（错误码体系 +
  // 社区指纹）。⚠️ 一周后要么变付费 GLM 要么下架 —— 这行是插件，闸和转换层才是耐久资产。
  // 上线顺序：先 gate localGen 给 admin 试跑真任务，过关再开闸并设为全员默认。
  {
    id: 'ox-alpha', window: 1_000_000,
    // 08-21 经营态拍板：全员默认模型（default: true），公开注册号只能用它这类免费行。
    select: { label: 'Ox Alpha（免费）', desc: '限时免费 · 1M 上下文 · 有视觉 · 人人可用', default: true },
    api: {
      upstream: 'zen', wireModel: 'x-preview-f-free',
      sdkAlias: 'claude-opus-4-8[1m]',
      fastModel: 'ox-alpha',
      thinking: 'strip',              // 出口不带 Anthropic thinking 字段；转换层按 reasoningEffort 发 reasoning_effort
      // Ox 三档 low|high|max。08-21 小题实测 reasoning_tokens：不传≈27、low=0、high=3、max=27；
      // 但上生产后 'max' 在真会话里想了 28,930 字 / 4 分 20 秒才出第一个字（用户看到的是
      // "只有绿点没有回复"）。改 'high'：还想，但不把一轮耗在想上
      reasoningEffort: 'high',
      maxOutput: 131_072,
      // 不设 liftImages：openai-chat 转换层本身就把 tool_result 里的图搬进随后的 user 消息
      // （OpenAI 的 tool 角色消息装不下图，上游放了会挂死 120s）。同一件事只留一条路。
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
 * 按用户过滤可选模型。两种闸不同语义（08-21）：
 *   - `gate: 'localGen'`：**看不见**。只对 admin / 已批准本地产线的账号露出（同 roll_film 那套批准制）
 *   - `gate: 'subscription'`：**看得见选不了**。订阅 Claude 行对没有订阅资格的账号
 *     （users.allow_subscription=0：公开注册号）仍在清单里，但带 `locked: true`；
 *     用户拍板「选择器依旧在，无配额账户无法请求，并且弹框提示」—— 让人知道有更强的档、
 *     怎么拿到（邀请码），而不是当它不存在
 *
 * ⚠️ 三处消费方必须都走它/allowedModelsFor：GET /model 的清单、PUT /model 的校验、
 * turn.js 的模型校验。少一处就是一个绕过闸门的后门 —— 2026-08-19 的独立评审正是在
 * turn.js 抓到过这种漏校验。校验用 allowedModelsFor（不含 locked），清单用本函数。
 */
export const SUBSCRIPTION_LOCK_REASON = '需要邀请码账号（订阅 Claude 额度）';

export function hasSubscriptionAccess(user) {
  return user?.role === 'admin' || !!user?.allowSubscription;
}

export function selectableModelsFor(user) {
  const approved = user?.role === 'admin' || !!user?.allowLocalGen;
  const subscribed = hasSubscriptionAccess(user);
  const out = [];
  for (const m of SELECTABLE_MODELS) {
    if (m.gate === 'localGen') { if (approved) out.push(m); continue; }
    if (m.gate === 'subscription' && !subscribed) { out.push({ ...m, locked: true, lockReason: SUBSCRIPTION_LOCK_REASON }); continue; }
    out.push(m);
  }
  return out;
}

/** 真能请求的（不含 locked）。PUT /model 与 turn.js 校验用这份 */
export function allowedModelsFor(user) {
  return selectableModelsFor(user).filter((m) => !m.locked);
}

/** 这个模型对这个用户是「看得见选不了」吗（在清单里且 locked）。turn 拒绝时据此回 403 而不是 400 */
export function isModelLockedFor(user, appModel) {
  return selectableModelsFor(user).some((m) => m.id === appModel && m.locked);
}

/**
 * 这个用户没选过时用哪个：表里标 `default: true` 的行（08-21 = ox-alpha），它对该用户
 * 不可选时退到第一个可选的。前端 picker 与新会话的兜底都问这条，不再各自硬编码。
 */
export function defaultModelFor(user) {
  const allowed = allowedModelsFor(user);
  return (allowed.find((m) => m.default) || allowed[0])?.id || null;
}

/**
 * 会话中途从 openai-chat 行（Ox）切到别的通路要拦（08-21 fable 评审 P3）：转换层合成的 thinking 块
 * 没有 signature，CLI 会把它们原样回传给 Anthropic → 400 invalid signature。返回拒绝理由或 null。
 */
export function crossLaneSwitchReason(fromModel, toModel) {
  if (!fromModel || !toModel || fromModel === toModel) return null;
  const from = resolveWireModel(fromModel);
  const to = resolveWireModel(toModel);
  if (from?.protocol === 'openai-chat' && to?.protocol !== 'openai-chat') {
    return '这个会话是在 Ox（免费）上开的，它的思考记录换到 Claude 会被拒收。想用 Claude 请新开一个会话';
  }
  return null;
}

/** 免费行（API 行且四价全 0）：金额配额对它无意义，turn.js 改走按轮次的免费闸 */
export function modelIsFree(appModel) {
  const p = BY_ID.get(appModel)?.api?.prices;
  return !!p && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => Number(p[k]) === 0);
}

/**
 * 这个模型是不是跑在无审查权重上（表里的 `uncensored` 位）。
 *
 * 唯一消费方是 prelude 渲染：为 true 的行不注入「底线」那一节（见
 * agent-shared.renderPrelude）。查表，未知名字一律 false —— 拼错一个字
 * 只该退回**更严**的那一档，绝不能因为查不到就当成无审查。
 */
export function isUncensoredModel(appModel) {
  if (!appModel) return false;
  return BY_ID.get(appModel)?.uncensored === true;
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
    protocol: UPSTREAMS[row.api.upstream]?.protocol || 'anthropic',
    reasoningEffort: row.api.reasoningEffort || null,
    maxOutput: row.api.maxOutput || null,
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
