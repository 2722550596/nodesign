/**
 * Nodesign upstream providers for pi（M0 最小版）。
 *
 * 读取 NODESIGN_UPSTREAM_* env（key 本体在 ~/.nodesign/.env，由启动方注入进程 env，
 * 见 server/_probe-pi-rpc.mjs），为每个有 key 的上游注册一个 pi provider。
 * key 通过 ProviderConfig.apiKey "$ENV" 插值在请求期解析（pi 内建 env 解析，
 * 不把钥匙写进任何配置文件）。
 *
 * 上游/模型事实（server/engine/agent/model-table.js，2026-08-26 复核）：
 * - gmi：https://api.gmi-serving.com（Anthropic 透传，不带 /v1，SDK 自动拼 /v1/messages；
 *   实测 x-api-key 与 Authorization: Bearer 均被接受），keyEnv NODESIGN_UPSTREAM_GMI_KEY。
 * - minimax-m3：wireModel MiniMaxAI/MiniMax-M3，GMI 免费档，272k 收口，思考是开关不是档位。
 *
 * 本文件是 pi extension（-e <绝对路径> 显式挂载）：jiti 加载，default export 即工厂。
 */

/**
 * 上游表。每行 = 一个 provider + 它的模型清单。
 * 模型字段对齐 pi ProviderModelConfig（core/extensions/types.ts 1600-1698）。
 */
const UPSTREAMS = [
	{
		provider: "gmi",
		name: "GMI Cloud (Nodesign)",
		baseUrl: "https://api.gmi-serving.com",
		keyEnv: "NODESIGN_UPSTREAM_GMI_KEY",
		models: [
			{
				// id 即 GMI 的 wire 模型名（api: anthropic-messages 直接用 model.id 发上游）；
				// --model minimax-m3 可被 parseModelPattern 部分匹配命中（id 子串）。
				id: "MiniMaxAI/MiniMax-M3",
				name: "MiniMax M3 (GMI)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272_000,
				maxTokens: 8192,
			},
		],
	},
];

/**
 * pi extension 工厂。无 key 的上游跳过注册（探针脚本负责把 ~/.nodesign/.env
 * 的 NODESIGN_UPSTREAM_* 注入进程 env；缺 key 时保持沉默，不抛错不污染 stdout）。
 */
export default function setup(pi) {
	for (const u of UPSTREAMS) {
		if (!process.env[u.keyEnv]) continue;
		pi.registerProvider(u.provider, {
			name: u.name,
			baseUrl: u.baseUrl,
			apiKey: `$${u.keyEnv}`,
			api: "anthropic-messages",
			models: u.models,
		});
	}
}
