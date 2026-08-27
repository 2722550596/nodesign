/**
 * guards.ts —— Nodesign pi 安全闸 + lint 反馈 + 装配断言（M2 GuardsExt 切片）。
 *
 * 本文件是薄壳：判据全在 ../guard-rules.js（纯函数，vitest 直测），这里只做
 * pi 事件接线 + env 取值 + fail-open 兜底。语义源是 agent/hooks/ 四件套
 * （pre-workspace-scope-guard / pre-performance-log-guard / canvas-validate /
 * site-validate），SDK 钩子语义 → pi extension 事件的重映射：
 *
 *   SDK PreToolUse（Read/Grep/Glob/Write/Edit，字段 file_path/path）
 *     → pi on('tool_call')（read/grep/find/ls/write/edit，字段统一 path），
 *       handler 返回 {block:true, reason} 拦截。
 *   SDK PostToolUse（Write/Edit 后读文件 lint，systemMessage 注下一轮）
 *     → pi on('tool_result')（write/edit 成功后读文件 lint），返回
 *       {content:[...原 content, lint 文本]} 整体替换结果（原 content 必须带上）。
 *
 * ⚠️ fail-open 纪律与 pi 语义的冲突：pi 的 tool_call handler **throw 会被当成
 * 拦截**（fail-closed），与"闸自己出错就放行"相反 —— 所以每个 handler 体内都
 * 自己 try/catch 兜住，异常只 warn 不抛。tool_result handler 的 throw 虽被 pi
 * 吞掉，同样兜住保持一致。
 *
 * 装配断言（fail-loud 不是 fail-block）：pi 的 session_start / before_agent_start
 * 都不能中止会话（已验证），所以断言只能喊话 —— session_start 时经 sidecar /emit
 * 发一条非终态 run.error（code=INIT_CONTRACT）报告装配状态（这条事件同时是
 * "扩展已挂载、sidecar 通路活着"的心跳，装配坏了它的缺席本身就是诊断信号）；
 * before_agent_start 时检查组装好的 systemPrompt 含 'NoDesign 平台协议'
 * （prelude H1）——不含说明 preset 没激活（坏 JSON 静默落 pi-default），发警告。
 * 非终态 run.error 只转发前端不杀 turn（session-loop.js TERMINAL_ERROR_CODES
 * 不含 INIT_CONTRACT）。
 *
 * env（lifecycle spawn 注入）：NODESIGN_WORKSPACE / NODESIGN_DATA_ROOT /
 * NODESIGN_MAIN_URL（含 /__nd-sidecar 前缀）/ NODESIGN_TOKEN / NODESIGN_SID /
 * NODESIGN_PROJECT。
 */

import path from "node:path";
import fs from "node:fs/promises";
import {
	checkWorkspaceScope,
	checkPerformanceLog,
	lintCanvasFile,
	lintSiteFile,
} from "../guard-rules.js";

/** 边界闸覆盖的 pi 内建工具（裸名；MCP 工具不在此列，不归闸管） */
const GUARDED_TOOLS: Record<string, true> = { read: true, write: true, edit: true, grep: true, find: true, ls: true };
/** tool_result 期跑 lint 的写工具 */
const LINT_TOOLS: Record<string, true> = { write: true, edit: true };
/** lint 读文件上限（防大文件吞内存，照搬 hooks 的 2MB） */
const LINT_MAX_BYTES = 2 * 1024 * 1024;
/** prelude H1 —— 装配断言的对账锚点（nodesign-prelude.md 第一行） */
const PRELUDE_MARK = "NoDesign 平台协议";
const SIDECAR_TIMEOUT_MS = 5000;

/**
 * 经 sidecar /emit 上报 INIT_CONTRACT（非终态 run.error）。
 * 契约：POST ${NODESIGN_MAIN_URL}/emit，body {sid, pid, event}，
 * Authorization: Bearer ${NODESIGN_TOKEN}（对齐 sidecar-client.js 形状）。
 * 失败只 warn 不抛 —— 上报通路挂了不该影响会话。
 */
async function emitInitContract(message) {
	const baseUrl = process.env.NODESIGN_MAIN_URL;
	const token = process.env.NODESIGN_TOKEN;
	const sid = process.env.NODESIGN_SID;
	if (!baseUrl || !token || !sid) {
		console.warn(`[guards] INIT_CONTRACT 无法上报（sidecar env 缺失）: ${message}`);
		return;
	}
	try {
		const res = await fetch(`${baseUrl}/emit`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({
				sid,
				pid: process.env.NODESIGN_PROJECT,
				event: { type: "run.error", code: "INIT_CONTRACT", message },
			}),
			signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
		});
		if (!res.ok) console.warn(`[guards] INIT_CONTRACT 上报失败: HTTP ${res.status}`);
	} catch (err) {
		console.warn(`[guards] INIT_CONTRACT 上报失败（忽略）: ${err?.message || err}`);
	}
}

/** 装配状态盘点：env 全家桶哪些在场（缺谁谁的安全闸/lint 降级）。 */
function assemblyStatus() {
	const keys = [
		"NODESIGN_WORKSPACE",
		"NODESIGN_DATA_ROOT",
		"NODESIGN_MAIN_URL",
		"NODESIGN_TOKEN",
		"NODESIGN_SID",
		"NODESIGN_PROJECT",
	];
	const missing = keys.filter((k) => !process.env[k]);
	return missing.length
		? `guards 已挂载，但 env 缺失: ${missing.join(", ")}（对应闸降级放行）`
		: "guards 已挂载，env 齐全（边界闸/演出隐私闸/lint/装配断言全部在岗）";
}

/**
 * pi extension 工厂。-e 绝对路径挂载归 lifecycle.js（Main 统一接），本文件
 * 不碰 spawn 侧。
 */
export default function setup(pi) {
	let preludeChecked = false;

	// ── 装配断言（心跳 + 状态）：session_start 发一条非终态 run.error ──
	pi.on("session_start", async () => {
		try {
			await emitInitContract(`[guards] 装配状态：${assemblyStatus()}`);
		} catch (err) {
			// session_start handler throw 无拦截语义，但保持一致兜住不脏事件循环
			console.warn("[guards] session_start 断言异常（忽略）:", err?.message || err);
		}
	});

	// ── 装配断言（对账）：组装好的 systemPrompt 必须含 prelude H1 ──
	pi.on("before_agent_start", async (event) => {
		try {
			if (preludeChecked) return;
			preludeChecked = true;
			const sp = event?.systemPrompt;
			if (typeof sp === "string" && sp.includes(PRELUDE_MARK)) return;
			const msg =
				`[guards] 装配断言失败：systemPrompt 里没有「${PRELUDE_MARK}」（prelude H1）` +
				" —— nodesign preset 大概率没激活（坏 JSON 会静默落 pi-default），平台协议未注入。";
			console.warn(msg);
			await emitInitContract(msg);
		} catch (err) {
			console.warn("[guards] before_agent_start 断言异常（忽略）:", err?.message || err);
		}
	});

	// ── 安全闸：tool_call 期拦越界读写 + 演出记录点名读 ──
	pi.on("tool_call", async (event) => {
		try {
			if (!GUARDED_TOOLS[event.toolName]) return;
			const workspaceRoot = process.env.NODESIGN_WORKSPACE;
			const dataRoot = process.env.NODESIGN_DATA_ROOT;
			const scopeHit = checkWorkspaceScope({
				toolName: event.toolName,
				input: event.input,
				workspaceRoot,
				dataRoot,
			});
			if (scopeHit) return scopeHit;
			const perfHit = await checkPerformanceLog({
				toolName: event.toolName,
				input: event.input,
				workspaceRoot,
			});
			if (perfHit) return perfHit;
		} catch (err) {
			// ⚠️ 必须自己兜住：pi 里 tool_call handler throw = fail-closed 拦截，
			// 与"闸自己出错就放行"的纪律相反。
			console.warn("[guards] tool_call 闸异常（fail-open 放行）:", err?.message || err);
		}
	});

	// ── lint 反馈：write/edit 成功后读刚写的文件跑 deck/站点 lint ──
	pi.on("tool_result", async (event) => {
		try {
			if (!LINT_TOOLS[event.toolName] || event.isError) return;
			const fp = event.input?.path;
			if (typeof fp !== "string" || !fp || !/\.html?$/i.test(fp)) return;
			const workspaceRoot = process.env.NODESIGN_WORKSPACE;
			// pi 工具相对路径按 cwd 解析，cwd 就是工作区（lifecycle 定的）
			const abs = path.resolve(workspaceRoot || "", fp);
			let html;
			try {
				const st = await fs.stat(abs);
				if (st.size > LINT_MAX_BYTES) return; // 大文件跳过
				html = await fs.readFile(abs, "utf8");
			} catch {
				return; // 读文件失败静默跳过（文件可能已被删/改名）
			}
			const issues = [
				...lintCanvasFile(fp, html),
				...lintSiteFile(fp, html, workspaceRoot),
			];
			if (!issues.length) return;
			const body = issues.map((i, idx) => `${idx + 1}. ${i.title}\n   ${i.detail}`).join("\n\n");
			const text =
				`\n\n[canvas-validate] 你刚改完 ${fp}，系统检测到 ${issues.length} 项可疑：\n\n` +
				body +
				"\n\n如果有意为之（custom mode / 故意命名重复 等）忽略；否则在下一轮主动修。" +
				"\n（站点页硬规则同源检查：缺 viewport / 根路径 href/src 见上列条目。）";
			// 整体替换语义：原 content 必须带上，lint 文本追加在后
			return { content: [...(event.content || []), { type: "text", text }] };
		} catch (err) {
			console.warn("[guards] tool_result lint 异常（忽略）:", err?.message || err);
		}
	});
}
