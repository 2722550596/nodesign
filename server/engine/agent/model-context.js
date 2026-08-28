/**
 * server/engine/agent/model-context.js — 模型的单一真相源（2026-08-19 重建，M3b 删除波 2026-08-28）。
 *
 * 历史形态是三张平行表（APP_TO_SDK_MODEL / APP_MODEL_REAL_WINDOW / SELECTABLE_MODELS），
 * 文件头自己就写着"写错一个字，两处都只会静默降级"。现在收成一张 MODELS 表 +
 * 一张 UPSTREAMS 表，旧的每个导出都从表派生，加载时做一致性断言（撞车当场炸，
 * 不静默）。
 *
 * ## M3b 起只剩 API 一条通路
 *
 * 订阅行（Claude 真名、无 api 字段）随 Claude Code SDK 一起在 M3b 删掉 —— 引擎是
 * pi-rp RPC，表里每行都带 api 字段：pi 子进程经 providers.ts 扩展把请求打到上游。
 * ingress 转换层（sdkAlias spoofing / 入口反查 / 会话优先路由）整条退役：
 *   - resolveModelRoute 对查不到的名字返 null（调用方 fail-loud）
 *   - usage key 就是 pi wire model name，repriceUsageDeltas 按会话行价重算 costUsd
 *
 * ## 记账
 *
 * pi 报的 usage 按 wire model 分组；repriceUsageDeltas 按会话行内 prices 重算
 * costUsd。行没填 prices = 原样过（接真流量前必须填价）。
 */

import { localGenApproved } from '../../auth/tier.js';
import { platform } from '../../runtime/platform.js';
import { UPSTREAMS_BUILTIN, MODELS_BUILTIN, BRANDS } from './models-json.js';
import { loadLocalConfig } from '../../runtime/local-config.js';

export { BRANDS };

// ── 内置表 + 用户插槽合并（08-22）──
const external = loadLocalConfig();
export const UPSTREAMS = Object.freeze({ ...UPSTREAMS_BUILTIN, ...external.upstreams });
/** 配置条目 → 表行（字段名一一对应，见 local-config.js 文件头） */
function toExternalRow(m) {
  const { id, label, desc, brand, window, uncensored, upstream, wireModel, fastModel, ...api } = m;
  return Object.freeze({
    id, window, brand, external: true, ...(uncensored ? { uncensored: true } : {}),
    select: Object.freeze({ label, desc }),
    api: Object.freeze({ upstream, wireModel, fastModel: fastModel || id, ...api }),
  });
}
const MODELS = Object.freeze([...MODELS_BUILTIN, ...external.models.map(toExternalRow)]);
/** 外部插槽被整条丢掉的原因（启动日志一份、GET /api/local/config 一份，同一个数组） */
export const MODEL_CONFIG_ERRORS = external.errors;

// ── 派生索引（模块加载时构建 + 断言）──
// 分级：内置行的错照旧当场炸（那是代码错）；外部行的错丢行 + 记进 MODEL_CONFIG_ERRORS（那是用户配置错，别拉下整站）

const BY_ID = new Map();

function checkRow(row) {
  if (!BRANDS.includes(row.brand)) throw new Error(`[model-context] ${row.id} 的 brand 必须是 BRANDS 之一：${row.brand}`);
  if (!row.api) return;
  if (!UPSTREAMS[row.api.upstream]) throw new Error(`[model-context] ${row.id} 指向不存在的 upstream: ${row.api.upstream}`);
}
for (const row of MODELS) {
  if (BY_ID.has(row.id)) throw new Error(`[model-context] 模型 id 重复：${row.id}`);
  BY_ID.set(row.id, row);
}
for (const row of MODELS) {
  try { checkRow(row); } catch (err) {
    if (!row.external) throw err;
    BY_ID.delete(row.id); MODEL_CONFIG_ERRORS.push({ where: `models (${row.id})`, message: err.message }); continue;
  }
}
if (MODEL_CONFIG_ERRORS.length) {
  console.warn(`[model-context] 本地插槽配置有 ${MODEL_CONFIG_ERRORS.length} 处问题（对应条目已跳过）${external.path ? `：${external.path}` : ''}`);
  for (const e of MODEL_CONFIG_ERRORS) console.warn(`  - ${e.where}: ${e.message}`);
}

/** 当前进程里真正生效的外部行 id（配置页据此判「已生效 / 要重启」） */
export function externalModelIds() {
  return [...BY_ID.values()].filter((r) => r.external).map((r) => r.id);
}

// ── 旧导出（签名不变，全部改为查表）──

/**
 * picker 的**全量**清单（含带闸门的行）。⚠️ 对外接口一律用
 * `selectableModelsFor(user)`，直接用这个等于把闸门拆了。保留导出是因为它是
 * 「表里哪些行可选」的唯一真相，闸门只是在它上面过滤。
 */
export const SELECTABLE_MODELS = Object.freeze(
  MODELS.filter((m) => m.select).map((m) => Object.freeze({ id: m.id, brand: m.brand, ...m.select })),
);

/** 这个 appModel 出自谁家（BRANDS 之一）。不认识的 id → null，调用方自己决定兜底，别猜。 */
export function brandOfModel(appModel) {
  return BY_ID.get(appModel)?.brand || null;
}

/**
 * 按用户过滤可选模型。闸门只剩一种（M3b 订阅行删除后）：
 *   - `gate: 'localGen'`：**看不见**。只对 admin / 已批准本地产线的账号露出（同 roll_film 那套批准制）
 *
 * ⚠️ 三处消费方必须都走它/allowedModelsFor：GET /model 的清单、PUT /model 的校验、
 * turn.js 的模型校验。少一处就是一个绕过闸门的后门 —— 2026-08-19 的独立评审正是在
 * turn.js 抓到过这种漏校验。校验用 allowedModelsFor，清单用本函数。
 */
const upstreamKeyPresent = (row) => { const up = UPSTREAMS[row.api.upstream]; return !up || up.authStyle === 'none' || !!up.key || !!(up.keyEnv && process.env[up.keyEnv]); };
export function selectableModelsFor(user) {
  const approved = localGenApproved(user);   // 档位 + 逐人批准，同 paint_still / roll_film / 演出端点一把尺
  const out = [];
  for (const m of SELECTABLE_MODELS) {
    if (platform.isLocal && !upstreamKeyPresent(BY_ID.get(m.id))) continue;   // 本地版藏没配钥匙的行；hosted 不过滤（缺钥匙让请求 502 fail-loud）
    if (m.gate === 'localGen') { if (approved) out.push(m); continue; }
    out.push(m);
  }
  return out;
}

/** 真能请求的。PUT /model 与 turn.js 校验用这份 */
export function allowedModelsFor(user) {
  return selectableModelsFor(user);
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
 * 会话中途从 openai-chat 上游（Ox / DeepSeek / Kimi）切到别的上游要拦（08-21 fable 评审 P3）：
 * openai-chat 上游合成的 thinking 块没有 signature，换到说 Anthropic 协议的那一头会被拒收
 * （400 invalid signature）。返回拒绝理由或 null。
 *
 * ⚠️ 拦的是**协议方向**不是"要不要 Claude"：08-25 接了 MiniMax（Anthropic 原生透传）之后，
 * 从 Ox 切到 MiniMax 同样是这条路，所以话里不许再写死"换到 Claude"。
 * M3b：协议从行内字段改查上游表（UPSTREAMS[upstream].protocol，缺省 anthropic）。
 */
export function crossLaneSwitchReason(fromModel, toModel) {
  if (!fromModel || !toModel || fromModel === toModel) return null;
  const from = BY_ID.get(fromModel);
  const to = BY_ID.get(toModel);
  if (!from?.api || !to?.api) return null;
  const fromProto = UPSTREAMS[from.api.upstream]?.protocol || 'anthropic';
  const toProto = UPSTREAMS[to.api.upstream]?.protocol || 'anthropic';
  if (fromProto === 'openai-chat' && toProto !== 'openai-chat') {
    const fromLabel = from.select?.label || from.id;
    return `这个会话是在 ${fromLabel} 上开的，它的思考记录换到别的模型会被拒收。想换模型请新开一个会话`;
  }
  return null;
}

/**
 * **换模型该不该拒**（null = 放行）。三条写模型的路共用这一个判断：turn.js 的 body.model、
 * sessions.js 的 PUT /model、turn-model-switch.js 的运行中热切。
 *
 * 收成一份是因为 08-21 装的那条协议闸在两处都没真工作过（08-25 发现）：sessions.js 那份把闸写在
 * applySessionModel **之后**、又拿 apply 之后的模型当 from，等于自己跟自己比，恒返 null；turn.js 那份
 * 带着 `override &&`，跑在全局默认上的会话整个逃过检查。同一个判断散成三份手写代码就是这个下场 ——
 * 这个仓库为「同一件事有多个实例」付过最贵的学费。
 *
 * `running` 参数 M3b 起无消费（订阅 ↔ API 通路闸随订阅行删除），保留签名不逼调用方改。
 *
 * @param {object} p
 * @param {string} p.from        **改之前**的有效模型（⚠️ 不是刚写进去的那个 —— 那正是旧 bug）
 * @param {string} p.to          要换成的模型（清覆盖时传全局默认那一行，别传 null）
 * @param {boolean} [p.hasHistory] 这个会话跑过没有。没跑过就没有历史，协议闸不该拦（拦了只是让人换不了模型）
 * @param {boolean} [p.running]  已无消费，保留签名
 * @returns {string|null} 给用户看的拒绝理由
 */
export function modelSwitchRejection({ from, to, hasHistory = true, running = false }) {
  if (!from || !to || from === to) return null;
  return hasHistory ? crossLaneSwitchReason(from, to) : null;
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

/**
 * 表里所有带 `uncensored` 位的行 id（今天只有 qwen3.8-27b）。
 * session-loop spawn 时用它算「无审查 wire-key 集合」经 env 交给 pi 子进程，
 * ndPolicy 宏按**当轮实际模型**查集合（会话内热换模型政策随之翻转，见 policy-render.js）。
 */
export function uncensoredModelIds() {
  return [...BY_ID.values()].filter((r) => r.uncensored === true).map((r) => r.id);
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

// ── 新导出：路由 ──

/**
 * 会话模型 → 通路描述。session-loop / 探针据此决定 env 注入与上游。
 * M3b 起只有 API 一条通路：查不到（未知名 / 无 api 行）返 **null**，调用方 fail-loud。
 *
 * @returns {null | {
 *   mode: 'api', appModel: string, window: number, upstreamId: string,
 *   upstream: object, wireModel: string, maxOutput: number|null,
 * }}
 */
export function resolveModelRoute(appModel) {
  const row = appModel ? BY_ID.get(appModel) : null;
  if (!row?.api) return null;
  return {
    mode: 'api',
    appModel: row.id,
    window: row.window,
    upstreamId: row.api.upstream,
    upstream: UPSTREAMS[row.api.upstream],
    wireModel: row.api.wireModel,
    maxOutput: row.api.maxOutput || null,
  };
}

/**
 * usage 差分 reprice：按会话行内 prices 重算 costUsd。context.js 的
 * absorbResult 在差分之后调这一步。
 *
 * M3b 起 usage key 就是 pi wire model name（不再有 SDK alias 还原 / fast 兜底
 * remap —— 那些是 ingress 转换层的概念，随 ingress 删了）。全部差分归到会话行，
 * 按行价重算；会话行没填 prices = 原样过（一个字段都不动）。
 *
 * @param {Record<string, {inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd}>} deltas
 * @param {string} sessionAppModel  本会话的 appModel（AgentContext.appModel）
 * @returns 同构对象（有 prices 的 API 会话新建；其余原样返回入参）
 */
export function repriceUsageDeltas(deltas, sessionAppModel) {
  if (!deltas || typeof deltas !== 'object') return deltas;
  const sessionRow = sessionAppModel ? BY_ID.get(sessionAppModel) : null;
  if (!sessionRow?.api) return deltas;
  const p = sessionRow.api.prices;
  if (!p) return deltas;
  const out = {};
  for (const d of Object.values(deltas)) {
    const repriced = {
      ...d,
      costUsd: (
        d.inputTokens * p.input
        + d.outputTokens * p.output
        + d.cacheReadTokens * (p.cacheRead || 0)
        + d.cacheCreateTokens * (p.cacheWrite || 0)
      ) / 1e6,
    };
    const prev = out[sessionRow.id];
    out[sessionRow.id] = prev ? {
      inputTokens: prev.inputTokens + repriced.inputTokens,
      outputTokens: prev.outputTokens + repriced.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + repriced.cacheReadTokens,
      cacheCreateTokens: prev.cacheCreateTokens + repriced.cacheCreateTokens,
      costUsd: prev.costUsd + repriced.costUsd,
    } : repriced;
  }
  return out;
}
