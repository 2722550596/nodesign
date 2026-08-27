/**
 * inject.ts — 懒注入族 + 失败建议 + rate-limit 判别（pi extension 薄壳）。
 *
 * 判定逻辑全在 ../inject-rules.js（纯函数，vitest 直测）；本文件只做三件运行时的事：
 *   1. tool_result 成功 → 首调懒注入：按工具名查 injectionFor，命中且本会话没注过，
 *      读 prompts/tools/<file>.md 追加进结果 content（整体替换语义，原 content 带上）。
 *   2. tool_result 失败 → failureAdvice 按工具/错因追加恢复建议。
 *   3. after_provider_response → isRateLimitSignal 命中经 sidecar /emit 发 run.rate_limit；
 *      429/5xx 连续 3 次发 run.error code=UPSTREAM_STREAK（非终态警告），成功响应清零。
 *
 * 语义源（CC SDK 时代 hooks，M2 迁 pi）：agent/hooks/pre-injectors.js（懒注入族）、
 * agent/hooks/failure.js（失败建议，seccomp 分支已随 bwrap 沙盒删除）。
 *
 * 会话级去重：pi 进程 = 会话（lifecycle 每会话独立 spawn），模块级 Set 天然会话级，
 * 对齐原 hooks 的 closure alreadyInjected 模式。
 *
 * 容错纪律：pi runner 会把 handler throw 变成 extension_error 事件（event-bridge 再映射成
 * run.error EXTENSION_ERROR 打扰前端）——注入是增益不是关键路径，全程 try/catch 自己兜住，
 * 失败只 console.warn，绝不让工具结果或 provider 响应因本扩展出错。
 *
 * 本文件是 pi extension（-e <绝对路径> 显式挂载，lifecycle.js 归 Main 接线）：
 * jiti 加载，default export 即工厂。pi 的类型包不在依赖里（jiti 运行时转译），
 * setup 参数与事件形状按 providers.ts 先例不标注 / 本地最小接口。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { injectionFor, failureAdvice, isRateLimitSignal } from "../inject-rules.js";

/**
 * prompts/tools/ 住在 agent/ 层（extensions/ → pi/ → engine/ → agent/，上跳两级）。
 * md 原地不动，经 import.meta.url 相对读（providers.ts 读 providers-models.json 同款先例）。
 */
const TOOLS_MD_DIR = fileURLToPath(new URL("../../agent/prompts/tools/", import.meta.url));

/** md 模块级缓存（首调即缓存，对齐 agent/hooks/tool-prompts.js 的 loadToolPrompt 语义） */
const mdCache = new Map<string, string | null>();

/** 会话级去重：每 key 每会话只注一次 */
const injectedKeys = new Set<string>();

/** 上游失败连击计数（429/5xx）；成功响应清零 */
let upstreamStreak = 0;
const UPSTREAM_STREAK_THRESHOLD = 3;

/** pi tool_result 事件的最小形状（core/extensions/types.ts ToolResultEventBase） */
interface ToolResultLike {
	toolName?: string;
	input?: Record<string, unknown>;
	content?: unknown;
	isError?: boolean;
}

/** pi after_provider_response 事件的最小形状（types.ts AfterProviderResponseEvent） */
interface ProviderResponseLike {
	status?: number;
	headers?: Record<string, string>;
}

/** 错误对象 → 消息文本（unknown 安全） */
function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 读 prompts/tools/<file>。缺失/读失败 → warn + 返 null（跳过本次注入，
 * fail-soft 对齐 tool-prompts.js：注入缺料不能变成新故障源）。
 */
function loadToolMd(file: string): string | null {
	if (mdCache.has(file)) return mdCache.get(file) ?? null;
	let md: string | null = null;
	try {
		md = readFileSync(TOOLS_MD_DIR + file, "utf8");
	} catch (err) {
		console.warn(`[inject] 读取 ${file} 失败（跳过懒注入）: ${errMsg(err)}`);
	}
	mdCache.set(file, md);
	return md;
}

/** tool_result 的文本内容拼起来（失败结果的错误文本从这里取） */
function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (c && typeof c === "object" && "type" in c && (c as { type: unknown }).type === "text") {
			const text = (c as { text: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

/**
 * sidecar /emit —— 事件进主进程项目 bus（契约同 sidecar-client.js / guards.ts：
 * POST ${NODESIGN_MAIN_URL}/emit，Bearer ${NODESIGN_TOKEN}，body {sid, pid, event}）。
 * fire-and-forget：失败只 warn 不抛（事件桥挂掉不该影响 provider 响应处理）。
 */
function emitSidecar(event: Record<string, unknown>): void {
	const baseUrl = process.env.NODESIGN_MAIN_URL;
	const token = process.env.NODESIGN_TOKEN;
	if (!baseUrl || !token) return; // sidecar 桥不可用（lifecycle 未注入）→ 静默跳过
	fetch(`${baseUrl}/emit`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({
			sid: process.env.NODESIGN_SID ?? "",
			pid: process.env.NODESIGN_PROJECT ?? "",
			event,
		}),
		signal: AbortSignal.timeout(5000),
	}).catch((err) => {
		console.warn(`[inject] sidecar emit ${event?.type || "?"} 失败（忽略）: ${errMsg(err)}`);
	});
}

/**
 * pi extension 工厂。
 */
export default function setup(pi) {
	// ── 懒注入 + 失败建议（tool_result）──────────────────────────────────────
	pi.on("tool_result", (event: ToolResultLike) => {
		try {
			const base = Array.isArray(event?.content) ? event.content : [];

			if (!event?.isError) {
				// 成功路径：首调懒注入（每会话每 key 一次）
				const hit = injectionFor(event?.toolName, event?.input);
				if (!hit || injectedKeys.has(hit.key)) return;
				const md = loadToolMd(hit.file);
				if (md === null) return; // 缺失已 warn，跳过
				injectedKeys.add(hit.key);
				// generate_image 的 ReadPageReminder 内联文本拼在 cookbook 前（对齐
				// hooks.js 两 hook 串联的次序：先目标页提醒，再 cookbook）
				const body = hit.inlinePrefix ? `${hit.inlinePrefix}\n\n${md}` : md;
				return {
					content: [...base, { type: "text", text: `\n\n<system>\n${body}\n</system>` }],
				};
			}

			// 失败路径：按工具/错因追加恢复建议（每次失败都给，不去重——对齐源 PostToolUseFailure）
			const advice = failureAdvice({
				toolName: event?.toolName,
				isError: true,
				errorText: textOf(base),
				input: event?.input,
			});
			if (!advice) return;
			return {
				content: [...base, { type: "text", text: `\n\n<system>\n${advice}\n</system>` }],
			};
		} catch (err) {
			console.warn(`[inject] tool_result 注入失败（忽略）: ${errMsg(err)}`);
			return;
		}
	});

	// ── rate-limit 判别 + 上游失败连击（after_provider_response）─────────────
	pi.on("after_provider_response", (event: ProviderResponseLike) => {
		try {
			const status = Number(event?.status) || 0;
			const rl = isRateLimitSignal({ status, headers: event?.headers });
			if (rl) {
				emitSidecar({ type: "run.rate_limit", message: rl.detail });
			}
			// 429/5xx 记连击；连续 3 次发非终态警告（越过阈值那一次发，不刷屏；
			// 继续失败由 pi auto_retry 耗尽 → event-bridge 的 AUTO_RETRY_EXHAUSTED 收场）
			if (status === 429 || status >= 500) {
				upstreamStreak += 1;
				if (upstreamStreak === UPSTREAM_STREAK_THRESHOLD) {
					emitSidecar({
						type: "run.error",
						message: `上游连续 ${UPSTREAM_STREAK_THRESHOLD} 次失败（429/5xx），可能限流或上游故障`,
						code: "UPSTREAM_STREAK",
					});
				}
			} else {
				upstreamStreak = 0; // 成功（含 4xx 客户端错——不是上游故障）清零
			}
		} catch (err) {
			console.warn(`[inject] after_provider_response 处理失败（忽略）: ${errMsg(err)}`);
		}
	});
}
