#!/usr/bin/env node
/**
 * Nodesign M0 探针（Wave B，B1）：standalone MCP server 经 pi-mcp-adapter 直挂工具。
 *
 * 验证链（复用 _probe-pi-rpc.mjs 的 spawn/分帧/kill 流程）：
 *   PI_CODING_AGENT_DIR 隔离 → providers.ts 注册上游 → adapter index.ts
 *   （vendored pi-mcp-adapter@2.20.1）加载 → 项目覆盖层 <cwd>/.pi/mcp.json 命中
 *   （nodesign server：node standalone.js --session test-s1 --uid u-test，
 *   directTools 全白名单 4 件 + toolPrefix none → 工具名无前缀）→ 模型主动调
 *   read_board → 真实 read_board 实现读播种的 board.json（fixture 内容）
 *   → tool_execution_start/end 落 events.jsonl → 模型回复引用标记。
 *
 * 用法（仓库根）：
 *   node server/_probe-mcp-tools.mjs [--cwd <workspace>] [--provider gmi]
 *       [--model minimax-m3] [--message <prompt>]
 *
 * 与 _probe-pi-rpc.mjs 的差异：
 *   - spawn 追加第二个 -e（adapter index.ts），与 providers.ts 并存。
 *   - env 增加 NODESIGN_DATA_ROOT / DB_PATH / NODESIGN_BOARD_FIXTURE
 *     （standalone 子进程经 adapter spawn 继承这些 env）。
 *   - ensureWorkspace 额外写 .pi/mcp.json（adapter 项目覆盖层）与
 *     board-fixture.json（read_board 数据源）。
 *   - events.jsonl 每次运行**截断重写**（本文件是 Wave A 的产物，可再生成）。
 *   - 验收扫描：tool_execution_start/end（read_board）、extension_error 计数、
 *     模型回复是否含标记；结果写 /tmp/nd-m0-probe/mcp-tools-summary.json。
 *   - 结束清理 agent-dir/mcp-cache.json（adapter 元数据缓存，探针产物）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// 路径与参数
// ─────────────────────────────────────────────────────────────────────────────
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const AGENT_DIR = path.join(repoRoot, "server", "engine", "pi", "agent-dir");
const PROVIDERS_EXT = path.join(repoRoot, "server", "engine", "pi", "extensions", "providers.ts");
const ADAPTER_EXT = path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
const STANDALONE_JS = path.join(repoRoot, "server", "engine", "mcp", "standalone.js");
const NODESIGN_ENV_FILE = process.env.ND_NODESIGN_ENV || path.join(os.homedir(), ".nodesign", ".env");
const PROBE_ROOT = process.env.ND_PROBE_ROOT || "/tmp/nd-m0-probe";
const WS_DIR = path.join(PROBE_ROOT, "ws");
const SESSIONS_DIR = path.join(PROBE_ROOT, "sessions");
const DATA_ROOT = path.join(PROBE_ROOT, "data");          // standalone 的 board 数据根
const STANDALONE_DB = path.join(PROBE_ROOT, "standalone.db");
const FIXTURE_FILE = path.join(WS_DIR, "board-fixture.json");
const EVENTS_FILE = path.join(PROBE_ROOT, "events.jsonl"); // 每次运行截断
const SUMMARY_FILE = path.join(PROBE_ROOT, "mcp-tools-summary.json");

const SESSION_MARKER = "ND-PROBE-SESSION-20260826";
const TOOL_MARKER = "ND-MCP-PROBE-20260826";

function parseArgs(argv) {
	const args = { cwd: WS_DIR, provider: "gmi", model: "minimax-m3" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--cwd") args.cwd = argv[++i];
		else if (a === "--provider") args.provider = argv[++i];
		else if (a === "--model") args.model = argv[++i];
		else if (a === "--message") args.message = argv[++i];
		else if (a === "--single-turn") args.singleTurn = true;
		else if (a === "--help" || a === "-h") {
			console.log(
				"usage: node server/_probe-mcp-tools.mjs [--cwd <ws>] [--provider gmi] [--model minimax-m3] [--message <prompt>]",
			);
			process.exit(0);
		}
	}
	if (!args.message) {
		args.message =
			"You have a workbench tool named read_board (no prefix). You MUST call it first, with no arguments. " +
			`After you see its result, reply with a line containing exactly the token ${TOOL_MARKER}, ` +
			"then a one-sentence summary of what the canvas contains (quote the item id and its text).";
	}
	return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// env：加载 ~/.nodesign/.env 的 NODESIGN_UPSTREAM_* key（不打印值）
// ─────────────────────────────────────────────────────────────────────────────
function loadNodesignEnvKeys() {
	const out = {};
	let raw;
	try {
		raw = fs.readFileSync(NODESIGN_ENV_FILE, "utf8");
	} catch (e) {
		console.warn(`[probe] 无法读取 ${NODESIGN_ENV_FILE}: ${e.message}`);
		return out;
	}
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const k = t.slice(0, eq).trim();
		const v = t.slice(eq + 1).trim();
		if (k.startsWith("NODESIGN_UPSTREAM_")) out[k] = v;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// workspace：preset + adapter 项目覆盖层 .pi/mcp.json + board-fixture.json
// ─────────────────────────────────────────────────────────────────────────────
function ensureWorkspace(cwd) {
	const presetsDir = path.join(cwd, ".pi", "prompt-presets");
	fs.mkdirSync(presetsDir, { recursive: true });
	const sessionPreset = {
		schemaVersion: 1,
		type: "pi-forge.prompt-preset",
		id: "nodesign-session",
		name: "Nodesign Session (M0 probe)",
		description: "M0 探针会话 preset：autoActivate 薄覆盖，含唯一标记 " + SESSION_MARKER,
		autoActivate: true,
		items: [
			{
				kind: "block",
				id: "nd-session-marker",
				name: "Nodesign M0 Probe Marker",
				role: "system",
				content:
					SESSION_MARKER +
					"\nThis session is driven by the Nodesign M0 probe (Wave B: standalone MCP server via pi-mcp-adapter). " +
					"You are a helpful assistant. A read_board tool is available for reading the workbench canvas.",
			},
			{ kind: "slot", id: "tools", name: "Available Tools", role: "system", slot: "tools" },
			{ kind: "slot", id: "chat-history", name: "Chat History", slot: "chat-history" },
		],
	};
	fs.writeFileSync(path.join(presetsDir, "nodesign-session.json"), JSON.stringify(sessionPreset, null, 2));

	// adapter 项目覆盖层（最高优先级：pi-project）。directTools 全白名单 4 件，
	// toolPrefix none → 工具注册名无前缀（read_board 等，events 里 toolName 即裸名）。
	const mcpConfig = {
		mcpServers: {
			nodesign: {
				command: "node",
				args: [STANDALONE_JS, "--session", "test-s1", "--uid", "u-test"],
				directTools: ["screenshot_canvas", "read_board", "web_search", "pin_to_board"],
				lifecycle: "lazy",
				requestTimeoutMs: 60000,
				debug: true, // standalone stderr 透传到 pi stderr（探针可采集）
			},
		},
		settings: { toolPrefix: "none" },
	};
	fs.writeFileSync(path.join(cwd, ".pi", "mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");

	// read_board 数据源：真实 board.json 由 standalone 启动时从这份 fixture 播种
	// （<DATA_ROOT>/proj_m0probe01/shared/board.json）。标记挂在物件条目里——
	// board.title 会被 sanitizeBoard 剥掉（白名单重建），物件 id/text 才会出现在
	// read_board 输出里。
	const fixture = {
		size: { w: 3000, h: 2000 },
		objects: {
			"probe/ND-MCP-PROBE-20260826.md": {
				kind: "text",
				x: 0,
				y: 0,
				w: 260,
				h: 40,
				by: "agent",
				data: { t: TOOL_MARKER, format: "md" },
			},
		},
	};
	fs.writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
function main() {
	const args = parseArgs(process.argv.slice(2));
	fs.mkdirSync(PROBE_ROOT, { recursive: true });
	fs.mkdirSync(SESSIONS_DIR, { recursive: true });
	fs.mkdirSync(DATA_ROOT, { recursive: true });
	ensureWorkspace(args.cwd);

	const upstreamEnv = loadNodesignEnvKeys();
	const keyEnv = { gmi: "NODESIGN_UPSTREAM_GMI_KEY" }[args.provider];
	if (keyEnv && !upstreamEnv[keyEnv]) {
		console.error(`[probe] 缺 key env ${keyEnv}（${NODESIGN_ENV_FILE} 里没有），无法直连上游 ${args.provider}`);
		process.exit(1);
	}

	const childArgs = [
		"--mode", "rpc",
		"--approve",
		"--provider", args.provider,
		"--model", args.model,
		"--config-dir", ".pi",
		"--session-dir", SESSIONS_DIR,
		"--system-prompt", "",
		"-e", PROVIDERS_EXT,
		"-e", ADAPTER_EXT,           // ⚠️ 与 providers.ts 并存，两个 -e
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
	];
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_TELEMETRY: "0",
		NODESIGN_DATA_ROOT: DATA_ROOT,       // standalone 的 board 数据根
		DB_PATH: STANDALONE_DB,              // 独立进程绝不摸生产库
		NODESIGN_BOARD_FIXTURE: FIXTURE_FILE, // fixture 播种源（绝对路径，不赌 cwd）
		...upstreamEnv,
	};
	// M0 探针不把 Nodesign 服务端的 MCP 配置带进 pi 进程；directTools 也只用配置层
	delete env.NODESIGN_MCP_SERVERS;
	delete env.MCP_DIRECT_TOOLS;

	console.log(`[probe] spawn: pi ${childArgs.join(" ")}`);
	console.log(`[probe] cwd=${args.cwd}`);
	console.log(`[probe] PI_CODING_AGENT_DIR=${AGENT_DIR}`);
	console.log(`[probe] adapter=${ADAPTER_EXT}`);
	console.log(`[probe] events -> ${EVENTS_FILE}（每次运行截断）`);

	const child = spawn("pi", childArgs, { cwd: args.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

	let carry = "";
	let stderrBuf = "";
	let settled = false;
	let promptAccepted = false;
	let firstEventAt = null;
	let settledAt = null;
	let finalTextFromCommand = null;
	const textByIndex = new Map(); // contentIndex -> accumulated text
	let sampleLogged = 0;
	let errorLines = [];
	let lastAssistantMessage = null;

	// ── 工具执行事件采集（验收证据）──
	const toolStarts = [];  // { toolName, args }
	const toolEnds = [];    // { toolName, isError, resultText }

	const tSpawn = Date.now();
	// 截断重写：events.jsonl 是探针产物，Wave A 内容已固化进 REPORT.md
	const eventsOut = fs.createWriteStream(EVENTS_FILE, { flags: "w" });
	const logEvent = (raw) => eventsOut.write(raw + "\n");

	const now = () => ((Date.now() - tSpawn) / 1000).toFixed(2);

	function handleLine(raw) {
		logEvent(raw);
		const line = raw.trim();
		if (!line) return;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			return; // 非 JSON 行（理论不该出现，留着给 events.jsonl 排查）
		}
		if (firstEventAt === null) {
			firstEventAt = Date.now();
			console.log(`[probe] 启动耗时（spawn → 首个 stdout 事件）：${firstEventAt - tSpawn}ms`);
		}
		switch (ev.type) {
			case "tool_execution_start":
				toolStarts.push({ toolName: ev.toolName, args: ev.args, toolCallId: ev.toolCallId });
				console.log(`[probe] t=${now()}s tool_execution_start ${ev.toolName} args=${JSON.stringify(ev.args)}`);
				break;
			case "tool_execution_end": {
				const resultText = (ev.result?.content || [])
					.filter((b) => b?.type === "text")
					.map((b) => b.text)
					.join("\n");
				toolEnds.push({ toolName: ev.toolName, isError: ev.isError, resultText });
				console.log(
					`[probe] t=${now()}s tool_execution_end ${ev.toolName} isError=${ev.isError} result=${JSON.stringify(resultText.slice(0, 120))}`,
				);
				break;
			}
			case "message_update": {
				const e = ev.assistantMessageEvent;
				if (e && e.type === "text_delta" && typeof e.delta === "string") {
					const prev = textByIndex.get(e.contentIndex) || "";
					textByIndex.set(e.contentIndex, prev + e.delta);
					if (sampleLogged < 2) {
						console.log(`[probe] t=${now()}s event message_update text_delta[${e.contentIndex}] ${JSON.stringify(e.delta.slice(0, 60))}`);
						sampleLogged++;
					}
				}
				break;
			}
			case "message_end":
				if (ev.message && ev.message.role === "assistant") lastAssistantMessage = ev.message;
				break;
			case "agent_settled":
				settled = true;
				settledAt = Date.now();
				console.log(`[probe] t=${now()}s event agent_settled`);
				break;
			case "extension_error":
				errorLines.push(`extension_error: ${ev.extensionPath} @${ev.event}: ${ev.error}`);
				console.error(`[probe] t=${now()}s ${errorLines[errorLines.length - 1]}`);
				break;
			case "response":
				if (ev.id === "req-1") {
					if (ev.command === "prompt" && ev.success === true) {
						promptAccepted = true;
						console.log(`[probe] t=${now()}s prompt accepted (response req-1)`);
					} else if (ev.success === false) {
						errorLines.push(`prompt rejected: ${ev.error}`);
						console.error(`[probe] t=${now()}s prompt rejected: ${ev.error}`);
					}
				} else if (ev.command === "get_last_assistant_text" && ev.success === true) {
					finalTextFromCommand = ev.data?.text ?? null;
				}
				break;
			default:
				break;
		}
	}

	child.stdout.on("data", (chunk) => {
		carry += chunk.toString("utf8");
		let idx;
		while ((idx = carry.indexOf("\n")) >= 0) {
			const line = carry.slice(0, idx);
			carry = carry.slice(idx + 1);
			handleLine(line);
		}
	});
	child.stderr.on("data", (c) => {
		const s = c.toString("utf8");
		stderrBuf = (stderrBuf + s).slice(-60000);
	});
	child.on("error", (err) => {
		console.error(`[probe] spawn 失败: ${err.message}`);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		console.log(`[probe] pi 进程退出 code=${code} signal=${signal}`);
	});

	// ── 命令发送 ──
	const send = (obj) => {
		if (child.stdin.destroyed) return false;
		child.stdin.write(JSON.stringify(obj) + "\n", "utf8");
		return true;
	};

	// adapter 首次连接 standalone 后才会把 nodesign 的工具元数据落进 mcp-cache.json；
	// directTools 在缓存就绪后（initializeMcp 的 .then → syncToolSurface）注册——
	// RPC prompt 若抢在注册前发出，模型只会看到 mcp 代理（session_start 不 await 初始化，
	// 见 adapter index.ts:351）。探针**等缓存出现再发 prompt**，把竞态转成确定性等待。
	// ⚠️ 探针会新落/更新 agent-dir/mcp-cache.json（运行时状态，同 auth.json 待遇）。
	function waitForDirectTools(timeoutMs = 20000) {
		const cachePath = path.join(AGENT_DIR, "mcp-cache.json");
		const t0 = Date.now();
		return new Promise((resolve) => {
			const check = () => {
				if (Date.now() - t0 > timeoutMs) return resolve(false);
				try {
					const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
					const tools = raw?.servers?.nodesign?.tools;
					if (Array.isArray(tools) && tools.some((t) => t?.name === "read_board")) return resolve(true);
				} catch {}
				setTimeout(check, 200);
			};
			check();
		});
	}

	waitForDirectTools().then(async (ready) => {
		console.log(`[probe] direct tools 缓存就绪=${ready}${ready ? "，等 800ms 让注册落地" : "（超时，按代理路径继续）"}`);
		await new Promise((r) => setTimeout(r, ready ? 800 : 100));
		if (!send({ type: "prompt", id: "req-1", message: args.message, streamingBehavior: "steer" })) {
			console.error(`[probe] 写 stdin 失败（进程可能已退出）：\n${stderrBuf.slice(-3000)}`);
		}
	});

	// ── 结束与超时链 ──
	const DEADLINE_MS = Number(process.env.ND_PROBE_DEADLINE_MS || 300_000);
	// 断言本 turn 的 settled 标志；返回 true=settled，false=总 deadline 超时
	function waitSettled() {
		return new Promise((resolve) => {
			const check = () => {
				if (settled) return resolve(true);
				if (Date.now() - tSpawn > DEADLINE_MS) return resolve(false);
				setTimeout(check, 200);
			};
			check();
		});
	}

	function killChain() {
		// abort → 5s → SIGTERM → 2s → SIGKILL
		send({ type: "abort" });
		setTimeout(() => {
			try { child.kill("SIGTERM"); } catch {}
			setTimeout(() => {
				try { child.kill("SIGKILL"); } catch {}
			}, 2000);
		}, 5000);
	}

	(async () => {
		const ok = await waitSettled();
		let retried = false;
		if (!ok) {
			console.error(`[probe] 超时（>${DEADLINE_MS / 1000}s）：走 abort → SIGTERM → SIGKILL 链`);
			killChain();
		} else {
			const firstTurnHadTool = toolStarts.some((t) => t.toolName === "read_board");
			if (!firstTurnHadTool && !args.singleTurn) {
				// 兜底：缓存门偶尔仍会输给注册时序（极端冷启动），发第二轮指令——
				// 此刻 direct tools 必然已注册，模型能直接看到 read_board
				retried = true;
				console.log("[probe] 首轮未见 read_board 工具调用，发第二轮指令（req-2）…");
				settled = false;
				send({
					type: "prompt",
					id: "req-2",
					message:
						`The read_board tool is now registered. You MUST call it now, with no arguments. ` +
						`After you see its result, reply with a line containing exactly the token ${TOOL_MARKER}, ` +
						"then a one-sentence summary of what the canvas contains.",
					streamingBehavior: "steer",
				});
				const ok2 = await waitSettled();
				if (!ok2) {
					console.error(`[probe] 第二轮也超时：走 kill 链`);
					killChain();
				}
			}
			// settled 后取权威文本（第二轮则取第二轮的回答）
			await new Promise((r) => setTimeout(r, 150));
			send({ type: "get_last_assistant_text" });
			await new Promise((r) => setTimeout(r, 1500));
		}

		const totalMs = Date.now() - tSpawn;
		const finalText = finalTextFromCommand ?? lastAssistantMessage?.content?.[0]?.text ?? "";

		// ── 验收扫描 ──
		const readBoardStarts = toolStarts.filter((t) => t.toolName === "read_board");
		const readBoardEnds = toolEnds.filter((t) => t.toolName === "read_board");
		const extensionErrorCount = errorLines.filter((l) => l.startsWith("extension_error")).length;
		const summary = {
			provider: args.provider,
			model: args.model,
			startupMs: firstEventAt !== null ? firstEventAt - tSpawn : null,
			promptAccepted,
			settled,
			retriedTurn: retried,
			totalMs,
			toolExecution: {
				allStarts: toolStarts.map((t) => t.toolName),
				allEnds: toolEnds.map((t) => `${t.toolName}:${t.isError ? "ERR" : "ok"}`),
				readBoardStartCount: readBoardStarts.length,
				readBoardStartArgs: readBoardStarts[0]?.args ?? null,
				readBoardEndCount: readBoardEnds.length,
				readBoardEndIsError: readBoardEnds.map((t) => t.isError),
				readBoardResultHasMarker: readBoardEnds.some((t) => t.resultText.includes(TOOL_MARKER)),
			},
			extensionErrorCount,
			replyHasMarker: finalText.includes(TOOL_MARKER),
			textFromCommand: finalTextFromCommand,
		};
		console.log(`[probe] ── 验收结果 ──`);
		console.log(`[probe] tool_execution_start(read_board) × ${readBoardStarts.length}${readBoardStarts[0] ? ` args=${JSON.stringify(readBoardStarts[0].args)}` : ""}`);
		console.log(`[probe] tool_execution_end(read_board) × ${readBoardEnds.length} isError=[${readBoardEnds.map((t) => t.isError).join(",")}] result含标记=${summary.toolExecution.readBoardResultHasMarker}`);
		console.log(`[probe] extension_error 总数 = ${extensionErrorCount}（验收要求 0）`);
		console.log(`[probe] 模型回复含 ${TOOL_MARKER} = ${summary.replyHasMarker}`);
		if (readBoardEnds.length && readBoardEnds[0].resultText) {
			console.log(`[probe] read_board 结果（首 400 字符）：\n${readBoardEnds[0].resultText.slice(0, 400)}`);
		}
		if (finalText) console.log(`[probe] 模型回复：${JSON.stringify(finalText.slice(0, 600))}`);
		if (errorLines.length > 0) console.error(`[probe] 错误：\n${errorLines.join("\n")}`);
		if (stderrBuf) {
			fs.writeFileSync(path.join(PROBE_ROOT, "mcp-tools-stderr.log"), stderrBuf, "utf8");
			console.log(`[probe] pi+standalone stderr 已存 mcp-tools-stderr.log（${stderrBuf.length} 字符）`);
		}
		fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
		eventsOut.end();

		// 清理：关闭 stdin，优雅退出优先
		try { child.stdin.end(); } catch {}
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try { child.kill("SIGTERM"); } catch {}
				setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
					// adapter 元数据缓存是探针产物（agent-dir 每次启动都会被写运行时状态，
					// 与 Wave A 的 auth.json/models-store.json 同待遇）
					try { fs.rmSync(path.join(AGENT_DIR, "mcp-cache.json"), { force: true }); } catch {}
					console.log("[probe] 已清理 agent-dir/mcp-cache.json");
					process.exit(0);
				}, 2000);
			} else {
				try { fs.rmSync(path.join(AGENT_DIR, "mcp-cache.json"), { force: true }); } catch {}
				process.exit(0);
			}
		}, 500);
	})();

	process.on("SIGINT", () => {
		console.error("[probe] SIGINT：走 kill 链");
		killChain();
	});
}

main();
