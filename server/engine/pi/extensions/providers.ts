/**
 * Nodesign upstream providers for pi（M3a：清单直接读 server/engine/agent/models.json，唯一真相源）。
 *
 * 08-28 起没有生成链：models.json 手编辑，本文件加载时做与旧 migrate-models.mjs
 * 相同的转换（protocol → pi api 映射 / reasoning 启发式 / prices → cost / 同 wireModel
 * 去重），把每个配了钥匙的上游注册进 pi。改模型改 models.json，不用跑任何脚本。
 *
 * 读取 NODESIGN_UPSTREAM_* env（key 本体在 ~/.nodesign/.env，由启动方注入进程 env，
 * 见 lifecycle.js sessionLaunch），为每个有 key 的上游注册一个 pi provider。
 * key 通过 ProviderConfig.apiKey "$ENV" 插值在请求期解析（pi 内建 env 解析，
 * 不把钥匙写进任何配置文件）。keyEnv 为 null 的上游（qwenLocal，无鉴权）不跳过。
 *
 * 外部插槽（M3a A7）：lifecycle.js 把用户 config.json 的路径经 NODESIGN_EXTERNAL_MODELS
 * 传进来，本文件读原始 JSON 注册外部 provider（不能 import local-config.js —— zod 依赖
 * + JS/TS 混合；只做最小校验，坏配置静默跳过不炸 pi 进程）。
 *
 * 本文件是 pi extension（-e <绝对路径> 显式挂载）：jiti 加载，default export 即工厂。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 读 server/engine/agent/models.json（唯一真相源，commit 进仓库）。
 * jiti 加载 extension 时 import.meta.url 指向本文件，相对路径稳定。
 */
const MODELS_JSON_PATH = fileURLToPath(new URL("../../agent/models.json", import.meta.url));
const raw = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));

/**
 * upstream → pi api 映射（原 migrate-models.mjs mapApi，M3a 内联）。
 *
 * pi KnownApi（pi-rp packages/ai/src/types.ts）：openai-completions / openai-responses /
 * anthropic-messages / google-generative-ai / …，**没有 'openai-chat'**。
 * 注意区分：pi 的 'openai-completions' 实现是 OpenAI **chat completions** 协议
 * （client.chat.completions.create → /chat/completions），正是 Nodesign 'openai-chat'
 * 上游说的协议；而 'openai-responses' 是 OpenAI 新一代 /responses API，本站上游不说这个。
 * 所以 openai-chat 上游映射 openai-completions 而不是 openai-responses。
 */
function mapApi(upKey, up) {
	if (up.protocol === "openai-chat") {
		return {
			api: "openai-completions",
			unverified:
				"Nodesign openai-chat 转换层无 pi 对应物；映射到 pi openai-completions 为 best-effort，M1 未验证，仅 GMI/anthropic-messages 是 M0 验证锚点",
		};
	}
	// 无 protocol 字段 = Anthropic 透传（models.json 约定：其余上游没有这个字段 = 透传 Anthropic）。
	// qwenLocal 是 llama.cpp 2025-11-28 起原生的 /v1/messages，同走 anthropic-messages。
	if (up.protocol === undefined || up.protocol === "anthropic") {
		if (!["x-api-key", "bearer", "none"].includes(up.authStyle)) {
			throw new Error(`upstream ${upKey}: authStyle '${up.authStyle}' 不在 anthropic-messages 映射预期内，人工复核`);
		}
		return { api: "anthropic-messages" };
	}
	throw new Error(`upstream ${upKey}: 未知 protocol '${up.protocol}'，无映射规则，人工补`);
}

/**
 * reasoning 判定 —— M3b 起 models.json 删了 thinking/reasoningEffort 死字段，
 * 判定收口成品牌表（逐行核对过：9 个 API 行全是思考模型，2026-08-28）：
 * - minimax：M3 的 GMI 部署实测思考是 adaptive（自己决定想不想、想多久）
 * - kimi：K3 流式实测含 reasoning_content
 * - deepseek：三行都带思考档
 * - gemini：3.7 Flash 思考档在模型名里（-high）
 * - opencode：Ox 三档（high/max/low）都走 reasoning
 * - qwen：本地行 thinking enabled8k
 */
const REASONING_BRANDS: Record<string, true> = {
	minimax: true, kimi: true, deepseek: true, gemini: true, opencode: true, qwen: true,
};

// 输入模态：现有 API 行全部有视觉实测（表注释：qwen 有视觉 / gemini 视觉 / deepseek -vision-exp /
// ox 图+视频 / M3 视觉 / kimi 视觉），一律 ['text','image']。将来接纯文本行时再在 models.json
// 引入行级 input 字段并在这里读取（别按 id 猜）。
const INPUT_TYPES = ["text", "image"];

/** prices → pi cost，对齐 {input,output,cacheRead,cacheWrite}，缺省补 0。 */
function mapCost(prices) {
	const p = prices ?? {};
	return { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite ?? 0 };
}

/** 一行 models.json model（带 .api）→ 一个 provider model 条目。 */
function mapModel(row) {
	const api = row.api;
	return {
		id: api.wireModel,
		name: row.select?.label || row.id,
		reasoning: !!REASONING_BRANDS[row.brand],
		input: [...INPUT_TYPES],
		cost: mapCost(api.prices),
		contextWindow: row.window,
		// 表里有 maxOutput 用表值；没有则默认 8192（M0 的 gmi 行即此值）。
		maxTokens: api.maxOutput ?? 8192,
		// ── 备忘字段（下划线前缀，pi 不认，MODEL_FIELDS 过滤）──
		// appModel id：pi 侧 model.id 是 wireModel，记账/路由对账要回查本站 id 时用。
		_appModels: [row.id],
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

/**
 * models.json → provider 清单（原 migrate-models.mjs 主流程，M3a 内联）。
 * 只取带 .api 的行（API 通路）；订阅行（无 .api，Claude 真名）不进 pi provider。
 * 按 upstreams 的表序产出，清单稳定可读。
 */
function buildProviders() {
	const byUpstream = new Map();
	for (const row of raw.models ?? []) {
		if (!row.api) continue;
		const upKey = row.api.upstream;
		if (!raw.upstreams?.[upKey]) {
			throw new Error(`models.json 行 ${row.id}: upstream '${upKey}' 不在 upstreams`);
		}
		if (!byUpstream.has(upKey)) byUpstream.set(upKey, []);
		byUpstream.get(upKey).push(row);
	}
	const providers = [];
	for (const [upKey, up] of Object.entries(raw.upstreams ?? {})) {
		const rows = byUpstream.get(upKey);
		if (!rows?.length) continue; // 没有 API 行的上游不产出（如 zen：行已全切到 zenGo）
		const { api, unverified } = mapApi(upKey, up);
		providers.push({
			provider: upKey,
			name: up.label,
			// baseUrl env 覆盖在 models-json.js 加载期做；这里也做一遍（pi 子进程 env 与
			// 主进程同源，探针的 NODESIGN_UPSTREAM_*_URL 覆盖两条路都要生效）。
			baseUrl: (up.baseUrlEnv && process.env[up.baseUrlEnv]) || up.baseUrl,
			keyEnv: up.keyEnv ?? null, // qwenLocal 无鉴权，keyEnv 为 null
			authStyle: up.authStyle,
			api,
			...(unverified ? { _unverified: unverified } : {}),
			models: mapModels(rows),
		});
	}
	return providers;
}

const providers = buildProviders();

/**
 * pi ProviderModelConfig 合法字段白名单（core/extensions/types.ts ProviderModelConfig）。
 * 清单里的 _appModels 等是迁移备忘，pi 不认，注册前过滤掉。
 */
const MODEL_FIELDS: Record<string, true> = {
	id: true,
	name: true,
	api: true,
	baseUrl: true,
	reasoning: true,
	thinkingLevelMap: true,
	input: true,
	cost: true,
	contextWindow: true,
	maxTokens: true,
	headers: true,
	compat: true,
};

function toProviderModel(m) {
	const out = {};
	for (const key of Object.keys(m)) {
		if (MODEL_FIELDS[key]) out[key] = m[key];
	}
	return out;
}

/**
 * pi extension 工厂。无 key 的上游跳过注册（探针脚本负责把 ~/.nodesign/.env
 * 的 NODESIGN_UPSTREAM_* 注入进程 env；缺 key 时保持沉默，不抛错不污染 stdout）。
 * keyEnv 为 null 的上游（qwenLocal，authStyle none）不跳过，用哨兵 apiKey 注册。
 *
 * M1.5 env 全家桶 fallback：NODESIGN_BASE_URL + NODESIGN_KEY + NODESIGN_MODEL 三元组
 * 在清单没覆盖 NODESIGN_MODEL 时注册一个 'custom' provider 兜底。
 * 清单优先，env 全家桶只在没匹配时生效。
 *
 * M3a 外部插槽：NODESIGN_EXTERNAL_MODELS 指向用户 config.json（lifecycle.js 注入），
 * 读原始 JSON 注册外部 provider —— 修 M1 起外部行进 picker 却不进 pi 注册面的回归。
 */
export default function setup(pi) {
	// 收集清单已覆盖的 appModel 集合（判 fallback 是否该注册）
	const coveredAppModels = new Set<string>();
	for (const p of providers) {
		for (const m of p.models ?? []) {
			for (const am of m._appModels ?? []) {
				if (typeof am === "string" && am) coveredAppModels.add(am);
			}
		}
	}

	for (const p of providers) {
		// 有 keyEnv 但 env 里没值 → 跳过（保持 M0 语义：缺 key 不注册、不报错）。
		if (p.keyEnv && !process.env[p.keyEnv]) continue;

		pi.registerProvider(p.provider, {
			name: p.name,
			baseUrl: p.baseUrl,
			// keyEnv 存在 → "$ENV" 插值（pi 请求期解析）；null（qwenLocal 无鉴权）→
			// 哨兵字面量，llama-server 忽略 auth 头，pi 侧满足 "有 apiKey" 的注册校验。
			apiKey: p.keyEnv ? `$${p.keyEnv}` : "none",
			api: p.api,
			models: p.models.map(toProviderModel),
		});
	}

	// ── 外部插槽模型（config.json，M3a A7）──
	// lifecycle.js 把 config.json 绝对路径经 NODESIGN_EXTERNAL_MODELS 传进来，并把条目内
	// 联 key 注入 NODESIGN_UPSTREAM_<NAME>_KEY。这里直接读原始 JSON（不 import
	// local-config.js：zod 依赖 + JS/TS 混合），最小校验，坏配置静默跳过不炸 pi 进程。
	// 外部行的 wireModel 就是 pi 的 model id；provider 名 = upstream key（与内置注册同构）。
	const extModelsPath = process.env.NODESIGN_EXTERNAL_MODELS;
	if (extModelsPath) {
		try {
			const extRaw = JSON.parse(readFileSync(extModelsPath, "utf8"));
			const extUps = (extRaw && typeof extRaw.upstreams === "object" && extRaw.upstreams) || {};
			const extModels = Array.isArray(extRaw?.models) ? extRaw.models : [];
			// 按 upstream 分组（保持 config.json 行序）
			const byUp = new Map<string, any[]>();
			for (const m of extModels) {
				if (!m || typeof m !== "object" || !m.id || !m.upstream || !m.wireModel) continue;
				if (!extUps[m.upstream]) continue;
				if (!byUp.has(m.upstream)) byUp.set(m.upstream, []);
				byUp.get(m.upstream)!.push(m);
			}
			for (const [upKey, rows] of byUp) {
				const up = extUps[upKey];
				if (!up || typeof up.baseUrl !== "string" || !up.baseUrl) continue;
				const keyEnv = `NODESIGN_UPSTREAM_${upKey.toUpperCase()}_KEY`;
				// authStyle none 无需钥匙；其余要么 env 有注入的 key、要么条目内联 key
				if (up.authStyle !== "none" && !process.env[keyEnv] && !up.key) continue;
				const { api } = mapApi(upKey, up);
				// 同 wireModel 去重（与内置 mapModels 同口径）
				const byWire = new Map<string, any>();
				for (const row of rows) {
					if (byWire.has(row.wireModel)) continue;
					byWire.set(row.wireModel, {
						id: row.wireModel,
						name: row.label || row.id,
						// 外部行无实测档案：reasoning 只认显式档位（reasoningEffort / thinking 非 strip）
						reasoning: Boolean(row.reasoningEffort || (row.thinking && row.thinking !== "strip")),
						input: [...INPUT_TYPES],
						cost: mapCost(row.prices),
						contextWindow: row.window ?? 128000,
						maxTokens: row.maxOutput ?? 8192,
					});
				}
				pi.registerProvider(upKey, {
					name: up.label || upKey,
					baseUrl: up.baseUrl,
					// 优先 "$ENV" 插值（lifecycle.js 注入的条目内联 key）；只有 keyEnv 没值时
					// 才退到条目内联字面量（key 已在 0600 的 config.json 里，不新增暴露面）
					apiKey: up.authStyle === "none" ? "none" : (process.env[keyEnv] ? `$${keyEnv}` : up.key),
					api,
					models: [...byWire.values()],
				});
			}
		} catch {
			// 外部配置坏（读不了 / 不是 JSON）→ 静默跳过，不炸 pi 进程
		}
	}

	// env 全家桶 fallback：清单没覆盖 NODESIGN_MODEL 时才注册
	const customBaseUrl = process.env.NODESIGN_BASE_URL;
	const customKey = process.env.NODESIGN_KEY;
	const customModel = process.env.NODESIGN_MODEL?.trim();
	if (customBaseUrl && customKey && customModel && !coveredAppModels.has(customModel)) {
		pi.registerProvider("custom", {
			name: "Custom upstream (env)",
			baseUrl: customBaseUrl,
			apiKey: "$NODESIGN_KEY",
			api: process.env.NODESIGN_API || "anthropic-messages",
			models: [{
				id: customModel,
				name: customModel,
				// extension registerProvider 路径（applyExtension）对 model 定义是原样
				// spread，不像 models.json 路径（modelFromJson）会补默认值 —— input /
				// cost / contextWindow / maxTokens 缺了就是 undefined，read.ts 的
				// model.input.includes("image") 当场炸。这里显式给全。
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			}],
		});
	}
}
