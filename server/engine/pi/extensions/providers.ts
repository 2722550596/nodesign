/**
 * Nodesign upstream providers for pi（M1：清单由 migrate-models.mjs 从 model-table.js 生成）。
 *
 * 模型/上游清单不再手写：同目录 providers-models.json 是 migrate-models.mjs 的产物
 * （generatedFrom: server/engine/agent/model-table.js）。**改模型改 model-table.js，
 * 再跑 `node server/engine/pi/extensions/migrate-models.mjs` 重新生成**，本文件只负责
 * 把清单注册进 pi。
 *
 * 读取 NODESIGN_UPSTREAM_* env（key 本体在 ~/.nodesign/.env，由启动方注入进程 env，
 * 见 server/_probe-pi-rpc.mjs），为每个有 key 的上游注册一个 pi provider。
 * key 通过 ProviderConfig.apiKey "$ENV" 插值在请求期解析（pi 内建 env 解析，
 * 不把钥匙写进任何配置文件）。keyEnv 为 null 的上游（qwenLocal，无鉴权）不跳过。
 *
 * 上游/模型事实（server/engine/agent/model-table.js，2026-08-26 复核）：
 * - gmi：https://api.gmi-serving.com（Anthropic 透传，不带 /v1，SDK 自动拼 /v1/messages；
 *   实测 x-api-key 与 Authorization: Bearer 均被接受），keyEnv NODESIGN_UPSTREAM_GMI_KEY。
 * - minimax-m3：wireModel MiniMaxAI/MiniMax-M3，GMI 免费档，272k 收口，思考是开关不是档位。
 *
 * 本文件是 pi extension（-e <绝对路径> 显式挂载）：jiti 加载，default export 即工厂。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 读同目录 providers-models.json（migrate-models.mjs 产物，commit 进仓库）。
 * jiti 加载 extension 时 import.meta.url 指向本文件，相对路径稳定。
 */
const MANIFEST_PATH = fileURLToPath(new URL("./providers-models.json", import.meta.url));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

/**
 * pi ProviderModelConfig 合法字段白名单（core/extensions/types.ts ProviderModelConfig）。
 * 清单里的 thinking / _appModels / _reasoningEffort 等是迁移备忘，pi 不认，注册前过滤掉。
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
 * 在 manifest 没覆盖 NODESIGN_MODEL 时注册一个 'custom' provider 兜底。
 * manifest 优先，env 全家桶只在没匹配时生效。
 */
export default function setup(pi) {
	// 收集 manifest 已覆盖的 appModel 集合（判 fallback 是否该注册）
	const coveredAppModels = new Set<string>();
	for (const p of manifest.providers) {
		for (const m of p.models ?? []) {
			for (const am of m._appModels ?? []) {
				if (typeof am === "string" && am) coveredAppModels.add(am);
			}
		}
	}

	for (const p of manifest.providers) {
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

	// env 全家桶 fallback：manifest 没覆盖 NODESIGN_MODEL 时才注册
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
