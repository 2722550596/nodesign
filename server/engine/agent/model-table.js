/**
 * server/engine/agent/model-table.js — 内置模型表与上游注册表（**只放数据，不放逻辑**）。
 *
 * 08-22 从 model-context.js 拆出来：那边顶在 600 行棘轮上，而本地分发版要在内置行之外合并用户
 * 自己的插槽（runtime/local-config.js）。派生索引、断言、路由查表、picker 闸门全留在 model-context.js，
 * 它 import 这两张表再与外部行合并成 UPSTREAMS / MODELS。改行仍然只改这里；加一家 brand 也在这里。
 *
 * 字段说明见 model-context.js 文件头（两条通路 / spoofing / 记账）。
 */

/**
 * API 上游注册表。keyEnv 是 env 变量名（真钥匙在 .env，不进代码不进 git）。
 * authStyle：'x-api-key'（Anthropic 原生头）| 'bearer'（Authorization: Bearer）。
 * countTokens：上游有没有 /v1/messages/count_tokens。false = 入口直接本地估算；
 * true = 先转发，404 再回退本地（capability 探针缓存见 model-ingress.js）。
 */
export const UPSTREAMS_BUILTIN = Object.freeze({
  lament: Object.freeze({
    label: '中转站 api.lament0.link',
    baseUrl: 'https://api.lament0.link',
    keyEnv: 'NODESIGN_UPSTREAM_LAMENT_KEY',
    authStyle: 'x-api-key',
    countTokens: false,   // 08-19 探针：404
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
    // 覆盖旋钮跟 qwenLocal 同款，**只给探针用**（假上游跑真 ingress+转换层，见 _probe-truncation-e2e.mjs）；
    // 生产 .env 里不设 → 真地址。
    baseUrl: process.env.NODESIGN_UPSTREAM_ZEN_URL || 'https://opencode.ai/zen/v1',
    keyEnv: 'NODESIGN_UPSTREAM_ZEN_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,   // 08-21 探针：404
  }),
  // 08-21 晚：Zen 第二入口 /zen/go（= OpenCode Go 订阅入口）。同钥匙、目录不同（Ox 叫 ox-alpha-free，x-preview-f-free 它回 401）；
  // 响应带 `cost`（流式在 [DONE] 之后补 {"choices":[],"cost":"…"}）与 cached_tokens → lib/ingress/upstream-billing.js。'zen' 留着可切回
  zenGo: Object.freeze({
    label: 'OpenCode Zen Go',
    baseUrl: process.env.NODESIGN_UPSTREAM_ZEN_GO_URL || 'https://opencode.ai/zen/go/v1',   // 探针覆盖，同上
    keyEnv: 'NODESIGN_UPSTREAM_ZEN_KEY',
    authStyle: 'bearer',
    protocol: 'openai-chat',
    countTokens: false,
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

/**
 * 模型出自谁家 —— 前端据此画身份标（picker 图标 / 画布精灵 / 舞台徽记）。
 *
 * **声明，不推断**：不许前端按 id 前缀猜（`/^claude-/` 那种），下一个模型名一变就全错。
 * 每行必须写 brand，加载时断言（下面的派生循环），拼错当场炸。
 * 新增一家 = 这里加一个名字 + 前端 ui/ModelMark.jsx 加一枚标；两边由
 * web/src/components/ui/ModelMark.lint.test.js 对账（它直接读本文件的 BRANDS）。
 *
 * 口径（08-21 用户拍板）：有自己标的用自己的（deepseek 蓝鲸、gemini 星），
 * **隐身/神秘的免费行一律用供应商 OpenCode 的方块标**（Ox 这类不公开身份的模型）。
 */
// 'custom'：本地分发版用户自己配的插槽（runtime/local-config.js）没填 brand 时的默认牌子，前端用通用标
export const BRANDS = Object.freeze(['claude', 'deepseek', 'opencode', 'gemini', 'qwen', 'custom']);

export const MODELS_BUILTIN = Object.freeze([
  // ── 订阅通路（Claude 真名，零注入）──
  {
    id: 'claude-sonnet-5[1m]', window: 1_000_000, brand: 'claude',
    select: { label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用', gate: 'subscription' },
  },
  {
    id: 'claude-opus-5[1m]', window: 1_000_000, brand: 'claude',
    select: { label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开', gate: 'subscription' },
  },
  { id: 'claude-sonnet-5',       window: 200_000, brand: 'claude' },
  { id: 'claude-opus-5',         window: 200_000, brand: 'claude' },
  { id: 'claude-opus-4-7[1m]',   window: 1_000_000, brand: 'claude' },
  { id: 'claude-sonnet-4-6[1m]', window: 1_000_000, brand: 'claude' },
  { id: 'claude-opus-4-7',       window: 200_000, brand: 'claude' },
  { id: 'claude-sonnet-4-6',     window: 200_000, brand: 'claude' },
  { id: 'claude-haiku-4-5',      window: 200_000, brand: 'claude' },
  // 只当 alias 用的订阅名（08-20）：SDK 二进制认识的 1M 名里还空着的一个（strings 扫过：
  // opus-4-6/4-7/4-8/5、sonnet-4-5-20250929/4-6/5 七个 [1m]），给 gemini-3.7-flash 行做 spoof。
  { id: 'claude-opus-4-6[1m]',   window: 1_000_000, brand: 'claude' },
  // 同上，给 ox-alpha 行做 spoof（08-21）
  { id: 'claude-opus-4-8[1m]',   window: 1_000_000, brand: 'claude' },
  // 同上，七个里最后一个空着的，给 ox-alpha-max 行做 spoof（08-21 晚）
  { id: 'claude-sonnet-4-5-20250929[1m]', window: 1_000_000, brand: 'claude' },
  // alias 池现状（08-21 深夜清槽后）：opus-4-6[1m]→gemini-3.7-flash、opus-4-7[1m]→deepseek-v4-flash-vision、opus-4-8[1m]→ox-alpha、
  // opus-5[1m]→qwen、sonnet-4-5-20250929[1m]→ox-alpha-max、haiku-4-5→ox-alpha-helper；**sonnet-4-6[1m] 空着备用**；sonnet-5[1m] 是订阅默认行不许被路由

  // ── API 通路 ──
  // kimi-k2.6 行与 moonshot 上游 08-21 深夜清掉（用户：「把 kimi 3.1pro 的槽都清理一下」）：NoDesk 退役后没走过流量，
  // 它的 alias claude-opus-4-7[1m] 转给 deepseek-v4-flash-vision。'enabled8k' 的 thinking 档逻辑留在 transformForUpstream 里备用。
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
    id: 'qwen3.8-27b', window: 131_072, brand: 'qwen',
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
  // gemini-3.1-pro 行（中转-gemini-3.1-pro-preview，alias claude-sonnet-4-6[1m]）08-21 深夜清掉：退了 picker 后只做体检对照，
  // 对照改用 3.7 Flash 行；sonnet-4-6[1m] 这个 alias 名腾出来备用。中转站 thinking 参数零效果的结论见 08-20 记录。
  {
    id: 'gemini-3.7-flash', window: 1_000_000, brand: 'gemini',
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
  // ── OpenCode Go · DeepSeek V4 Flash Vision Exp（08-21 深夜，第一条付费行）── /zen/go = OpenCode Go 订阅（$10/月换 $12/5h·$30/周·$60/月）：
  // 额度内上游 cost 报 0、余额不扣 → 记账按**表价**（高峰价；北京 09-12/14-18 是高峰）让每用户日限跟 Go 池子一起受控，cost>0 以上游为准
  // （context.applyUpstreamBilling）。探针：文本/图(webp)/工具/流式全通，首字 ~450ms，reasoning_effort 收；DeepSeek ZDR。先 gate localGen 试跑，过关改 'subscription'
  {
    // 真窗口 1M；用户 08-21 深夜拍板压缩窗口 272k（省钱：携带成本 ≈ 1M 的 1/4、缓存失手最坏 $0.12/轮；近 14 天 649 回合只压缩过 11 次）
    id: 'deepseek-v4-flash-vision', window: 272_000, brand: 'deepseek',
    // 08-21 深夜开闸给所有档（含 basic）：basic 的 $5/天日限 + 表价记账管着它；pro/admin 不限
    select: { label: 'DeepSeek V4 Flash · 视觉', desc: '快 · 有视觉 · 272k 上下文 · 按用量计入每日额度（高峰 $0.44/$1.32 缓存 $0.014）' },
    api: {
      upstream: 'zenGo', wireModel: 'deepseek-v4-flash-vision-exp',
      sdkAlias: 'claude-opus-4-7[1m]',   // kimi 退役腾出来的 1M 名；窗口由 CLAUDE_CODE_AUTO_COMPACT_WINDOW=272k 钉住
      fastModel: 'ox-alpha-helper',      // 一句话的活仍走免费 Ox helper
      thinking: 'strip',
      reasoningEffort: 'high',
      maxOutput: 128_000,
      prices: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
    },
  },
  // ── OpenCode Zen · Ox Alpha（08-21，用户称「大事」的第一块）──
  // 真 id x-preview-f-free（models.dev name "Ox Alpha Free"；/models 列表里没有带 ox 的名，别按名猜）。
  // 1M ctx / 131k out / 图+视频 / 工具 / reasoning effort low|high|max / 价 0；官方「free for
  // the next week」（08-20 公告）+ zero-retention 不训练。大概率 GLM 系 stealth（错误码体系 +
  // 社区指纹）。⚠️ 一周后要么变付费 GLM 要么下架 —— 这行是插件，闸和转换层才是耐久资产。
  // 上线顺序：先 gate localGen 给 admin 试跑真任务，过关再开闸并设为全员默认。
  {
    id: 'ox-alpha', window: 1_000_000, brand: 'opencode',
    // 08-21 经营态拍板：全员默认模型（default: true），公开注册号只能用它这类免费行。
    select: { label: 'Ox Alpha（免费）', desc: '限时免费 · 1M 上下文 · 有视觉 · 人人可用 · 思考档 high', default: true },
    api: {
      upstream: 'zenGo', wireModel: 'ox-alpha-free',   // 08-21 晚切 /zen/go 入口（主入口名 x-preview-f-free，upstream 'zen'）
      emptyRetries: 6, retryBudgetMs: 360_000,   // 就地重发放宽，理由见 resolveWireModel 的 emptyRetries 注释
      sdkAlias: 'claude-opus-4-8[1m]',
      fastModel: 'ox-alpha-helper',   // helper 走独立行才分得出 role（会话 env SMALL_FAST_MODEL 发的是 app id）
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
  {
    // 同一个 Ox，思考档 max：真会话里 max 想过 28,930 字 / 4 分 20 秒才出首字，所以不做默认、
    // 单独一行给愿意等的人。两行 protocol 同为 openai-chat，会话中途互切不触发 LANE_SWITCH
    id: 'ox-alpha-max', window: 1_000_000, brand: 'opencode',
    select: { label: 'Ox Alpha · 深想（免费）', desc: '同一个 Ox · 思考档 max · 想得久，首字可能等几分钟 · 重活再开' },
    api: {
      upstream: 'zenGo', wireModel: 'ox-alpha-free',   // 08-21 晚切 /zen/go 入口（主入口名 x-preview-f-free，upstream 'zen'）
      emptyRetries: 6, retryBudgetMs: 360_000,   // 就地重发放宽，理由见 resolveWireModel 的 emptyRetries 注释
      sdkAlias: 'claude-sonnet-4-5-20250929[1m]',
      fastModel: 'ox-alpha-helper',   // helper 一句话的活用 low 档那行，不跟着深想
      thinking: 'strip',
      reasoningEffort: 'max',
      maxOutput: 131_072,
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  },
  {
    // Ox 的 helper 行（08-21 晚）：不进 picker（无 select），只做两个 Ox 主行的 fastModel。
    // 为什么要单独一行：session-loop 给 CLI 的 ANTHROPIC_SMALL_FAST_MODEL 是 app id，
    // ox-alpha 主行自己当 fast 时 helper 请求和主请求同名，ingress 分不出 role、helper
    // 也跟着 high 想。独立行 + alias haiku（表内空着的订阅名，helper 不需要 1M 窗）。
    id: 'ox-alpha-helper', window: 1_000_000, brand: 'opencode',
    api: {
      upstream: 'zenGo', wireModel: 'ox-alpha-free',   // 08-21 晚切 /zen/go 入口（主入口名 x-preview-f-free，upstream 'zen'）
      // helper 不放宽重发（走全局默认 2 次）：它就是标题/分类器一句话的活，
      // 接不上无所谓，多打几发只是白占上游并发。
      sdkAlias: 'claude-haiku-4-5',
      fastModel: 'ox-alpha-helper',
      thinking: 'strip',
      reasoningEffort: 'low',
      maxOutput: 131_072,
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  },
]);
