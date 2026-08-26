#!/usr/bin/env node
/**
 * server/engine/pi/extensions/migrate-models.mjs — 一次性脚本：model-table.js → providers-models.json。
 *
 * M1（CC SDK → pi-rp 迁移）：pi 的 provider 注册面（extensions/providers.ts）不再手写上游表，
 * 改为读本脚本从 server/engine/agent/model-table.js 生成的 providers-models.json。
 * **改模型改 model-table.js，然后重跑本脚本**；JSON 产物 commit 进仓库，运行时不跑脚本。
 *
 * 用法：node server/engine/pi/extensions/migrate-models.mjs [--out <path>]
 *
 * 映射规则（保守，逐条注释）：
 * - 只取带 .api 的行（API 通路）；订阅行（无 .api，Claude 真名）不进 pi provider，跳过。
 * - 按 row.api.upstream 分组，一个 upstream 一个 provider；没有 API 行的 upstream 不产出。
 * - api 映射见 mapApi：protocol 'openai-chat' → pi 'openai-completions'（best-effort，打 _unverified）；
 *   无 protocol（Anthropic 透传）→ 'anthropic-messages'。
 * - reasoning 是启发式，见 inferReasoning。
 * - JSON 里刻意保留 thinking / _appModels / _reasoningEffort 等 pi 不认的备忘字段：
 *   providers.ts 注册前会按 ProviderModelConfig 白名单过滤，这些字段留给后续 thinkingLevelMap / 记账对账。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
// ⚠️ 表里的导出名是 MODELS_BUILTIN（MODELS 是 model-context.js 合并用户插槽后的派生表）。
// 相对路径：本文件在 server/engine/pi/extensions/，表在 server/engine/agent/。
import { UPSTREAMS_BUILTIN, MODELS_BUILTIN } from '../../agent/model-table.js';

/**
 * upstream → pi api 映射。
 *
 * pi KnownApi（pi-rp packages/ai/src/types.ts）：openai-completions / openai-responses /
 * anthropic-messages / google-generative-ai / …，**没有 'openai-chat'**。
 * 注意区分：pi 的 'openai-completions' 实现是 OpenAI **chat completions** 协议
 * （packages/ai/src/api/openai-completions.ts，client.chat.completions.create → /chat/completions），
 * 正是 Nodesign 'openai-chat' 转换层对上上游说的协议；而 'openai-responses' 是 OpenAI
 * 新一代 /responses API（client.responses.create），zen/nvidia 那些上游不说这个。
 * 所以 openai-chat 上游映射 openai-completions 而不是 openai-responses。
 */
function mapApi(upKey, up) {
  if (up.protocol === 'openai-chat') {
    return {
      api: 'openai-completions',
      unverified:
        'Nodesign openai-chat 转换层无 pi 对应物；映射到 pi openai-completions 为 best-effort，M1 未验证，仅 GMI/anthropic-messages 是 M0 验证锚点',
    };
  }
  // 无 protocol 字段 = Anthropic 透传（model-table 约定：其余上游没有这个字段 = 透传 Anthropic）。
  // qwenLocal 是 llama.cpp 2025-11-28 起原生的 /v1/messages，同走 anthropic-messages。
  if (up.protocol === undefined || up.protocol === 'anthropic') {
    if (!['x-api-key', 'bearer', 'none'].includes(up.authStyle)) {
      throw new Error(`upstream ${upKey}: authStyle '${up.authStyle}' 不在 anthropic-messages 映射预期内，人工复核`);
    }
    return { api: 'anthropic-messages' };
  }
  throw new Error(`upstream ${upKey}: 未知 protocol '${up.protocol}'，无映射规则，人工补`);
}

/**
 * reasoning 判定 —— **启发式**（表里没有显式「会思考」字段，以下按表注释/实测事实逐行核对，2026-08-27）：
 * - minimax：M3 的 GMI 部署实测思考是 adaptive（自己决定想不想、想多久）→ true
 * - kimi：K3 流式实测含 reasoning_content → true
 * - deepseek：三行都在表里写了 reasoningEffort 档位 → true
 * - gemini：3.7 Flash 思考档在模型名里（-high），默认 high → true
 * 兜底：row.api.reasoningEffort 存在（表显式给思考档，如 Ox 三档）→ true；
 * row.api.thinking 存在且非 'strip'（如 qwen 'enabled8k'）→ true；否则 false。
 */
const REASONING_BRANDS = new Set(['minimax', 'kimi', 'deepseek', 'gemini']);
function inferReasoning(row) {
  if (REASONING_BRANDS.has(row.brand)) return true;
  if (row.api.reasoningEffort) return true;
  const t = row.api.thinking;
  return Boolean(t && t !== 'strip');
}

// 输入模态：现有 API 行全部有视觉实测（表注释：qwen 有视觉 / gemini 视觉 / deepseek -vision-exp /
// ox 图+视频 / M3 视觉 / kimi 视觉），一律 ['text','image']。将来接纯文本行时再在 model-table
// 引入行级 input 字段并在这里读取（别按 id 猜）。
const INPUT_TYPES = ['text', 'image'];

/** prices → pi cost，对齐 {input,output,cacheRead,cacheWrite}，缺省补 0。 */
function mapCost(prices) {
  const p = prices ?? {};
  return { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite ?? 0 };
}

/** 一行 MODELS_BUILTIN（带 .api）→ 一个 provider model 条目。 */
function mapModel(row) {
  const api = row.api;
  return {
    id: api.wireModel,
    name: row.select?.label || row.id,
    reasoning: inferReasoning(row),
    input: [...INPUT_TYPES],
    cost: mapCost(api.prices),
    contextWindow: row.window,
    // 表里有 maxOutput 用表值；没有则默认 8192（M0 的 gmi 行即此值）。
    maxTokens: api.maxOutput ?? 8192,
    // 透传 'adaptive'/'strip'/'enabled8k' 等，供后续 thinkingLevelMap 用。
    // ⚠️ thinking 不是 pi ProviderModelConfig 字段，providers.ts 注册前会过滤掉。
    thinking: api.thinking,
    // ── 迁移备忘字段（下划线前缀，pi 不认，providers.ts 过滤）──
    // appModel id：pi 侧 model.id 是 wireModel，记账/路由对账要回查本站 id 时用。
    _appModels: [row.id],
    ...(api.reasoningEffort ? { _reasoningEffort: api.reasoningEffort } : {}),
  };
}

/**
 * 一个 upstream 的行 → models[]。同一 wireModel 的多行（如 zenGo 的 ox-alpha / ox-alpha-max /
 * ox-alpha-helper 三行都是 ox-alpha-free）在 pi 侧是**同一个模型**（registry 按 id 索引，
 * 重复 id 会互相覆盖），这里按 wireModel 去重：保留表里第一行（主行）的展示与档位字段，
 * 其余行的 appModel id 并进 _appModels 备忘。
 */
function mapModels(rows) {
  const byWire = new Map();
  for (const row of rows) {
    const wire = row.api.wireModel;
    const existing = byWire.get(wire);
    if (existing) {
      existing._appModels.push(row.id);
      continue;
    }
    byWire.set(wire, mapModel(row));
  }
  return [...byWire.values()];
}

// ── 主流程 ──

// 按 upstream 分组（只取 API 行；订阅行无 .api，不进 pi provider）。
const byUpstream = new Map();
for (const row of MODELS_BUILTIN) {
  if (!row.api) continue;
  const upKey = row.api.upstream;
  if (!UPSTREAMS_BUILTIN[upKey]) {
    throw new Error(`MODELS_BUILTIN 行 ${row.id}: upstream '${upKey}' 不在 UPSTREAMS_BUILTIN`);
  }
  if (!byUpstream.has(upKey)) byUpstream.set(upKey, []);
  byUpstream.get(upKey).push(row);
}

// 按 UPSTREAMS_BUILTIN 的表序产出，产物稳定可读。
const providers = [];
for (const [upKey, up] of Object.entries(UPSTREAMS_BUILTIN)) {
  const rows = byUpstream.get(upKey);
  if (!rows?.length) continue; // 没有 API 行的上游不产出（如 zen：行已全切到 zenGo）
  const { api, unverified } = mapApi(upKey, up);
  providers.push({
    provider: upKey,
    name: up.label,
    // 取模块加载后的实际值（表里 baseUrl 可被 NODESIGN_UPSTREAM_*_URL 覆盖，那只给探针用，见 model-table 注释）。
    baseUrl: up.baseUrl,
    keyEnv: up.keyEnv ?? null, // qwenLocal 无鉴权，keyEnv 为 null
    authStyle: up.authStyle,
    api,
    ...(unverified ? { _unverified: unverified } : {}),
    models: mapModels(rows),
  });
}

const doc = {
  generatedFrom: 'server/engine/agent/model-table.js',
  generatedAt: new Date().toISOString(),
  providers,
};

// 内置自检：M0 验证锚点（GMI / MiniMax-M3）必须在且字段正确，否则拒绝产出。
try {
  const gmi = providers.find((p) => p.provider === 'gmi');
  assert.ok(gmi, '缺 provider gmi');
  assert.equal(gmi.baseUrl, 'https://api.gmi-serving.com');
  assert.equal(gmi.keyEnv, 'NODESIGN_UPSTREAM_GMI_KEY');
  assert.ok(gmi.models.some((m) => m.id === 'MiniMaxAI/MiniMax-M3'), 'gmi.models 缺 MiniMaxAI/MiniMax-M3');
} catch (err) {
  console.error(`自检失败：${err.message}`);
  console.error('（若设置了 NODESIGN_UPSTREAM_*_URL 探针覆盖 env，unset 后重跑）');
  process.exit(1);
}

// 默认写到同目录 providers-models.json；--out <path> 覆盖。
const argv = process.argv.slice(2);
let outPath = fileURLToPath(new URL('./providers-models.json', import.meta.url));
const outIdx = argv.indexOf('--out');
if (outIdx !== -1) {
  const target = argv[outIdx + 1];
  if (!target) {
    console.error('--out 需要一个路径');
    process.exit(1);
  }
  outPath = path.resolve(target);
}

writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

const totalModels = providers.reduce((n, p) => n + p.models.length, 0);
console.log(`providers-models.json 已写 → ${outPath}`);
console.log(`providers: ${providers.length}, models: ${totalModels}`);
for (const p of providers) {
  console.log(`  - ${p.provider} [${p.api}${p._unverified ? '，未验证' : ''}] ${p.models.length} 个模型：${p.models.map((m) => m.id).join(', ')}`);
}
