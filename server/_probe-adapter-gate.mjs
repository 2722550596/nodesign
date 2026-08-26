#!/usr/bin/env node
/**
 * Nodesign M1 adapter gate 探针（Wave 3 F）：pi-mcp-adapter 2.27.0（registry 版）
 * 全链路 —— spawn pi(--mode rpc) + providers.ts + adapter index.ts 两个 -e，
 * 项目级 .pi/mcp.json directTools 直挂全量 standalone（M1 版，54 工具），
 * 验证 read_board 工具往返 + extension_error=0。
 *
 * 仿 server/_probe-mcp-tools.mjs（M0 同款探针），差异：
 *  - adapter 来自 agent-dir/npm/node_modules（registry 2.27.0，替换 vendored symlink）；
 *  - standalone 身份走 C1 env（NODESIGN_SID/UID/PROJECT/WORKSPACE/DATA_ROOT），
 *    不再用 argv 静态值；MAIN_URL/TOKEN 刻意缺省（read_board 不走 gate/sidecar，
 *    顺带验证 sidecar 缺席时 standalone 不崩）；
 *  - board 数据由探针直接写进 workspace/board.json（standalone M1 已删 fixture 播种）；
 *  - 结束清理 agent-dir/mcp-cache.json（doc 附录 D.3：改 mcp.json 后必须删，
 *    否则 direct tools 不刷新）。
 *
 * 用法：node server/_probe-adapter-gate.mjs [--provider gmi] [--model minimax-m3]
 * 全绿 = adapter 2.27.0 gate 通过（M1 第一道 gate）。
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
const ADAPTER_DIR = path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter");
const ADAPTER_EXT = path.join(ADAPTER_DIR, "index.ts");
const STANDALONE_JS = path.join(repoRoot, "server", "engine", "mcp", "standalone.js");
const NODESIGN_ENV_FILE = process.env.ND_NODESIGN_ENV || path.join(os.homedir(), ".nodesign", ".env");
const PROBE_ROOT = process.env.ND_PROBE_ROOT || "/tmp/nd-adapter-gate";
const WS_DIR = path.join(PROBE_ROOT, "ws");                 // pi 的 cwd（.pi/mcp.json 住这）
const SESSIONS_DIR = path.join(PROBE_ROOT, "sessions");
const DATA_ROOT = path.join(PROBE_ROOT, "data");            // standalone 的 PROJECTS_DATA_DIR
const PROJECT_ID = "proj_gate01";
const WORKSPACE = path.join(DATA_ROOT, PROJECT_ID, "shared"); // = NODESIGN_WORKSPACE，board.json 住这
const EVENTS_FILE = path.join(PROBE_ROOT, "events.jsonl");
const SUMMARY_FILE = path.join(PROBE_ROOT, "adapter-gate-summary.json");

const TOOL_MARKER = "ND-ADAPTER-GATE-20260827";

function parseArgs(argv) {
	const args = { provider: "gmi", model: "minimax-m3" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--provider") args.provider = argv[++i];
		else if (a === "--model") args.model = argv[++i];
		else if (a === "--message") args.message = argv[++i];
		else if (a === "--help" || a === "-h") {
			console.log("usage: node server/_probe-adapter-gate.mjs [--provider gmi] [--model minimax-m3] [--message <prompt>]");
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
// workspace：.pi/mcp.json（directTools=[read_board]）+ board.json fixture
// ─────────────────────────────────────────────────────────────────────────────
function ensureWorkspace() {
	fs.mkdirSync(path.join(WS_DIR, ".pi"), { recursive: true });
	fs.mkdirSync(WORKSPACE, { recursive: true });

	// adapter 项目覆盖层（最高优先级：pi-project）。directTools 只挂 read_board
	// （非 gate 工具，不依赖 sidecar）；toolPrefix none → 裸名注册。
	const mcpConfig = {
		mcpServers: {
			nodesign: {
				command: "node",
				args: [STANDALONE_JS],
				directTools: ["read_board"],
				lifecycle: "lazy",
				requestTimeoutMs: 60000,
				debug: true, // standalone stderr 透传到 pi stderr（探针可采集）
			},
		},
		settings: { toolPrefix: "none" },
	};
	fs.writeFileSync(path.join(WS_DIR, ".pi", "mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");

	// board 数据：M1 standalone 不再播种 fixture，探针直接写真实 board.json。
	// 标记挂在物件条目里（board.title 会被 sanitizeBoard 剥掉，物件 id/text 才进
	// read_board 输出）。
	const fixture = {
		size: { w: 3000, h: 2000 },
		objects: {
			"probe/ND-ADAPTER-GATE-20260827.md": {
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
	fs.writeFileSync(path.join(WORKSPACE, "board.json"), JSON.stringify(fixture, null, 2) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
function main() {
	const args = parseArgs(process.argv.slice(2));
	fs.mkdirSync(PROBE_ROOT, { recursive: true });
	fs.mkdirSync(SESSIONS_DIR, { recursive: true });
	ensureWorkspace();

	// gate 前置断言：adapter 必须是 registry 2.27.0 且带 index.ts（lifecycle -e 指它）
	let adapterVersion = null;
	try {
		adapterVersion = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, "package.json"), "utf8")).version;
	} catch (e) {
		console.error(`[probe] 读不到 adapter package.json: ${e.message}`);
		process.exit(1);
	}
	if (!fs.existsSync(ADAPTER_EXT)) {
		console.error(`[probe] adapter 缺 index.ts（${ADAPTER_EXT}）——lifecycle 引用的是它，gate 不通过`);
		process.exit(1);
	}
	console.log(`[probe] adapter pi-mcp-adapter@${adapterVersion}（registry 安装，index.ts 存在）`);

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
		// C1 身份 env（standalone 从这取；MAIN_URL/TOKEN 刻意缺省——read_board
		// 不走 gate/sidecar，验证 sidecar 缺席不崩）
		NODESIGN_SID: "gate-s1",
		NODESIGN_UID: "u-gate",
		NODESIGN_PROJECT: PROJECT_ID,
		NODESIGN_WORKSPACE: WORKSPACE,
		NODESIGN_DATA_ROOT: DATA_ROOT,
		...upstreamEnv,
	};
	// 不把 Nodesign 服务端的 MCP 配置带进 pi 进程（doc 附录 D.2）
	delete env.NODESIGN_MCP_SERVERS;
	delete env.MCP_DIRECT_TOOLS;
	delete env.NODESIGN_MAIN_URL;
	delete env.NODESIGN_TOKEN;
	delete env.NODESIGN_DISABLED_TOOLS;

	console.log(`[probe] spawn: pi ${childArgs.join(" ")}`);
	console.log(`[probe] cwd=${WS_DIR}`);
	console.log(`[probe] PI_CODING_AGENT_DIR=${AGENT_DIR}`);
	console.log(`[probe] events -> ${EVENTS_FILE}（每次运行截断）`);

	const child = spawn("pi", childArgs, { cwd: WS_DIR, env, stdio: ["pipe", "pipe", "pipe"] });

	let carry = "";
	let stderrBuf = "";
	let settled = false;
	let promptAccepted = false;
	let firstEventAt = null;
	let finalTextFromCommand = null;
	const textByIndex = new Map(); // contentIndex -> accumulated text
	let errorLines = [];
	let lastAssistantMessage = null;

	// ── 工具执行事件采集（验收证据）──
	const toolStarts = [];  // { toolName, args }
	const toolEnds = [];    // { toolName, isError, resultText }

	const tSpawn = Date.now();
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
			return;
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
				}
				break;
			}
			case "message_end":
				if (ev.message && ev.message.role === "assistant") lastAssistantMessage = ev.message;
				break;
			case "agent_settled":
				settled = true;
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

	const send = (obj) => {
		if (child.stdin.destroyed) return false;
		child.stdin.write(JSON.stringify(obj) + "\n", "utf8");
		return true;
	};

	// adapter 首次连接 standalone 后才把工具元数据落进 mcp-cache.json；directTools
	// 在缓存就绪后注册。探针等缓存出现再发 prompt，把竞态转成确定性等待。
	function waitForDirectTools(timeoutMs = 30000) {
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
		if (!ok) {
			console.error(`[probe] 超时（>${DEADLINE_MS / 1000}s）：走 abort → SIGTERM → SIGKILL 链`);
			killChain();
		} else {
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
		const gatePass = settled && readBoardStarts.length > 0 && readBoardEnds.length > 0
			&& readBoardEnds.every((t) => !t.isError) && extensionErrorCount === 0;
		const summary = {
			adapterVersion,
			provider: args.provider,
			model: args.model,
			startupMs: firstEventAt !== null ? firstEventAt - tSpawn : null,
			promptAccepted,
			settled,
			totalMs,
			toolExecution: {
				allStarts: toolStarts.map((t) => t.toolName),
				allEnds: toolEnds.map((t) => `${t.toolName}:${t.isError ? "ERR" : "ok"}`),
				readBoardStartCount: readBoardStarts.length,
				readBoardEndCount: readBoardEnds.length,
				readBoardEndIsError: readBoardEnds.map((t) => t.isError),
				readBoardResultHasMarker: readBoardEnds.some((t) => t.resultText.includes(TOOL_MARKER)),
			},
			extensionErrorCount,
			replyHasMarker: finalText.includes(TOOL_MARKER),
			gatePass,
		};
		console.log(`[probe] ── 验收结果（adapter ${adapterVersion} gate）──`);
		console.log(`[probe] tool_execution_start(read_board) × ${readBoardStarts.length}`);
		console.log(`[probe] tool_execution_end(read_board) × ${readBoardEnds.length} isError=[${readBoardEnds.map((t) => t.isError).join(",")}] result含标记=${summary.toolExecution.readBoardResultHasMarker}`);
		console.log(`[probe] extension_error 总数 = ${extensionErrorCount}（验收要求 0）`);
		console.log(`[probe] 模型回复含 ${TOOL_MARKER} = ${summary.replyHasMarker}`);
		console.log(`[probe] GATE ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
		if (readBoardEnds.length && readBoardEnds[0].resultText) {
			console.log(`[probe] read_board 结果（首 400 字符）：\n${readBoardEnds[0].resultText.slice(0, 400)}`);
		}
		if (finalText) console.log(`[probe] 模型回复：${JSON.stringify(finalText.slice(0, 600))}`);
		if (errorLines.length > 0) console.error(`[probe] 错误：\n${errorLines.join("\n")}`);
		if (stderrBuf) {
			fs.writeFileSync(path.join(PROBE_ROOT, "adapter-gate-stderr.log"), stderrBuf, "utf8");
			console.log(`[probe] pi+standalone stderr 已存 adapter-gate-stderr.log（${stderrBuf.length} 字符）`);
		}
		fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
		eventsOut.end();

		try { child.stdin.end(); } catch {}
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try { child.kill("SIGTERM"); } catch {}
				setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
					// adapter 元数据缓存是探针产物（doc 附录 D.3：改 mcp.json 后必须删）
					try { fs.rmSync(path.join(AGENT_DIR, "mcp-cache.json"), { force: true }); } catch {}
					console.log("[probe] 已清理 agent-dir/mcp-cache.json");
					process.exit(gatePass ? 0 : 1);
				}, 2000);
			} else {
				try { fs.rmSync(path.join(AGENT_DIR, "mcp-cache.json"), { force: true }); } catch {}
				process.exit(gatePass ? 0 : 1);
			}
		}, 500);
	})();

	process.on("SIGINT", () => {
		console.error("[probe] SIGINT：走 kill 链");
		killChain();
	});
}

main();
