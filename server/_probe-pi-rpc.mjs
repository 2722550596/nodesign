#!/usr/bin/env node
/**
 * Nodesign M0 探针：pi --mode rpc 走通一轮真实文本回复。
 *
 * 验证链：PI_CODING_AGENT_DIR 隔离（不加载 ~/.pi/agent）→ providers.ts 注册
 * NODESIGN_UPSTREAM_* 上游 → workspace .pi/prompt-presets/nodesign-session.json
 * autoActivate 生效（模型复述 ND-PROBE-SESSION-20260826）→ 底座 preset 不泄漏
 * （模型报告 ND-PROBE-BASE-20260826 不在 system prompt）。
 *
 * 用法（仓库根）：
 *   node server/_probe-pi-rpc.mjs [--cwd <workspace>] [--provider gmi]
 *       [--model minimax-m3] [--message <prompt>]
 *
 * 行为：
 * - 建临时 workspace（默认 /tmp/nd-m0-probe/ws/），写入 .pi/prompt-presets/nodesign-session.json。
 * - spawn：pi --mode rpc --approve --provider <p> --model <m> --config-dir .pi
 *   --session-dir <abs> --system-prompt "" -e <providers.ts 绝对路径>
 *   --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
 *   （--config-dir 传相对值：实现是 join(cwd, value)，绝对路径会拼坏；
 *     --session-dir normalizePath 直通绝对路径。--settings-file 同 join 语义，
 *    M0 不用 settings 覆盖层——settings 走 agent-dir/settings.json。）
 * - env：PI_CODING_AGENT_DIR=<agent-dir 绝对路径>、PI_TELEMETRY=0、
 *   ~/.nodesign/.env 的 NODESIGN_UPSTREAM_* key 注入。
 * - 分帧：carry + indexOf('\n')，LF-only（U+2028 纪律，禁用 splitlines 类逻辑）。
 * - stdout 原始行逐行追加到 /tmp/nd-m0-probe/events.jsonl。
 * - 流程：spawn → 等首个事件（≤1s，无 hello）→ 发 prompt{id:'req-1'} →
 *   收集事件 → agent_settled → get_last_assistant_text → 聚合文本 → 打印。
 * - 超时链（总 deadline 后）：发 abort → 5s → SIGTERM → 2s → SIGKILL。
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
const NODESIGN_ENV_FILE = process.env.ND_NODESIGN_ENV || path.join(os.homedir(), ".nodesign", ".env");
const PROBE_ROOT = process.env.ND_PROBE_ROOT || "/tmp/nd-m0-probe";
const WS_DIR = path.join(PROBE_ROOT, "ws");
const SESSIONS_DIR = path.join(PROBE_ROOT, "sessions");
const EVENTS_FILE = path.join(PROBE_ROOT, "events.jsonl");

const SESSION_MARKER = "ND-PROBE-SESSION-20260826";
const BASE_MARKER = "ND-PROBE-BASE-20260826";

function parseArgs(argv) {
	const args = { cwd: WS_DIR, provider: "gmi", model: "minimax-m3" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--cwd") args.cwd = argv[++i];
		else if (a === "--provider") args.provider = argv[++i];
		else if (a === "--model") args.model = argv[++i];
		else if (a === "--message") args.message = argv[++i];
		else if (a === "--help" || a === "-h") {
			console.log(
				"usage: node server/_probe-pi-rpc.mjs [--cwd <ws>] [--provider gmi] [--model minimax-m3] [--message <prompt>]",
			);
			process.exit(0);
		}
	}
	if (!args.message) {
		args.message =
			`Repeat the exact token ${SESSION_MARKER} at the very start of your reply. ` +
			`Then answer: does the string ${BASE_MARKER} appear anywhere in your system prompt? ` +
			`Reply with exactly: the token, then a newline, then YES or NO, then a newline, then one short sentence.`;
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
// workspace：nodesign-session.json（autoActivate 薄覆盖）
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
					"\nThis session is driven by the Nodesign M0 probe. You are a helpful assistant.",
			},
			{ kind: "slot", id: "tools", name: "Available Tools", role: "system", slot: "tools" },
			{ kind: "slot", id: "chat-history", name: "Chat History", slot: "chat-history" },
		],
	};
	fs.writeFileSync(path.join(presetsDir, "nodesign-session.json"), JSON.stringify(sessionPreset, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
function main() {
	const args = parseArgs(process.argv.slice(2));
	fs.mkdirSync(PROBE_ROOT, { recursive: true });
	fs.mkdirSync(SESSIONS_DIR, { recursive: true });
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
		...upstreamEnv,
	};
	// M0 探针不加载 MCP adapter；避免把 Nodesign 的 MCP 配置带进 pi 进程
	delete env.NODESIGN_MCP_SERVERS;

	console.log(`[probe] spawn: pi ${childArgs.join(" ")}`);
	console.log(`[probe] cwd=${args.cwd}`);
	console.log(`[probe] PI_CODING_AGENT_DIR=${AGENT_DIR}`);
	console.log(`[probe] events -> ${EVENTS_FILE}`);

	const child = spawn("pi", childArgs, { cwd: args.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

	let carry = "";
	let stderrBuf = "";
	let settled = false;
	let promptAccepted = false;
	let firstEventAt = null;
	let settledAt = null;
	let finalTextFromUpdates = "";
	let finalTextFromCommand = null;
	const textByIndex = new Map(); // contentIndex -> accumulated text
	let sampleLogged = { message_update: 0, agent_start: 0 };
	let errorLines = [];
	let lastAssistantMessage = null;
	let presetActivated = null;

	const tSpawn = Date.now();
	const eventsOut = fs.createWriteStream(EVENTS_FILE, { flags: "a" });
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
case "agent_start":
			console.log(`[probe] t=${now()}s event agent_start`);
			break;
			case "preset_activated":
				presetActivated = ev.presetId;
				console.log(`[probe] t=${now()}s event preset_activated: ${ev.presetId}`);
				break;
			case "message_update": {
				const e = ev.assistantMessageEvent;
				if (e && e.type === "text_delta" && typeof e.delta === "string") {
					const prev = textByIndex.get(e.contentIndex) || "";
					textByIndex.set(e.contentIndex, prev + e.delta);
					finalTextFromUpdates = [...textByIndex.entries()]
						.sort((a, b) => a[0] - b[0])
						.map(([, t]) => t)
						.join("");
					if (sampleLogged.message_update < 2) {
						console.log(`[probe] t=${now()}s event message_update text_delta[${e.contentIndex}] ${JSON.stringify(e.delta.slice(0, 60))}`);
						sampleLogged.message_update++;
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
		stderrBuf = (stderrBuf + s).slice(-20000);
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

	// 启动等待：无 hello，等首个事件或 1s 兜底
	const bootWait = new Promise((resolve) => {
		const check = () => (firstEventAt !== null ? resolve(true) : resolve(false));
		setTimeout(check, 1000);
	});

	bootWait.then(() => {
		const bootMs = firstEventAt !== null ? firstEventAt - tSpawn : null;
		console.log(
			`[probe] 启动耗时（spawn → 首个事件）：${bootMs !== null ? bootMs + "ms" : ">1000ms 无事件（按 1s 兜底继续）"}`,
		);
		if (!send({ type: "prompt", id: "req-1", message: args.message, streamingBehavior: "steer" })) {
			console.error(`[probe] 写 stdin 失败（进程可能已退出）：\n${stderrBuf.slice(-3000)}`);
		}
	});

	// ── 结束与超时链 ──
	const DEADLINE_MS = Number(process.env.ND_PROBE_DEADLINE_MS || 300_000);
	const settlePromise = new Promise((resolve) => {
		const check = () => {
			if (settled) return resolve(true);
			if (Date.now() - tSpawn > DEADLINE_MS) return resolve(false);
			setTimeout(check, 200);
		};
		check();
	});

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

	settlePromise.then(async (ok) => {
		if (!ok) {
			console.error(`[probe] 超时（>${DEADLINE_MS / 1000}s）：走 abort → SIGTERM → SIGKILL 链`);
			killChain();
		} else {
			// settled 后取权威文本
			await new Promise((r) => setTimeout(r, 150));
			send({ type: "get_last_assistant_text" });
			await new Promise((r) => setTimeout(r, 1500));
		}

		const totalMs = Date.now() - tSpawn;
		const firstText = finalTextFromCommand ?? finalTextFromUpdates ?? lastAssistantMessage?.content?.[0]?.text ?? "";
		// 底座泄漏判据：模型对「ND-PROBE-BASE-20260826 是否在 system prompt」的 YES/NO 断言
		// （不能只看字符串出现——模型会在回答里引用该 token 然后说 NO，见 08-26 首跑）。
		const verdictLine = (firstText.match(/^\s*(YES|NO)\b/m) || [])[1] ?? null;
		const baseLeak = verdictLine === "YES";
		const summary = {
			provider: args.provider,
			model: args.model,
			startupMs: firstEventAt !== null ? firstEventAt - tSpawn : null,
			promptAccepted,
			settled,
			totalMs,
			presetActivated,
			replyHasSessionMarker: firstText.includes(SESSION_MARKER),
			baseMarkerVerdictLine: verdictLine,
			baseLeak,
			textFromCommand: finalTextFromCommand,
			textFromUpdates: finalTextFromUpdates,
		};
		console.log(`[probe] ── 结果 ──`);
		console.log(`[probe] 总耗时 ${totalMs}ms（${(totalMs / 1000).toFixed(1)}s）`);
		console.log(`[probe] autoActivate 证据：回复含 ${SESSION_MARKER} = ${summary.replyHasSessionMarker}`);
		console.log(
			`[probe] 底座不泄漏证据：模型对 BASE 标记的断言 = ${verdictLine}（YES=泄漏）→ baseLeak=${baseLeak}`,
		);
		console.log(`[probe] preset_activated 事件: ${presetActivated ?? "（无，M0 预期：启动期不发射）"}`);
		if (finalTextFromCommand !== null) {
			console.log(`[probe] get_last_assistant_text: ${JSON.stringify(finalTextFromCommand)}`);
		} else {
			console.log(`[probe] message_update text_delta 累积文本: ${JSON.stringify(finalTextFromUpdates)}`);
		}
		if (errorLines.length > 0) {
			console.error(`[probe] 错误：\n${errorLines.join("\n")}`);
		}
		fs.writeFileSync(path.join(PROBE_ROOT, "summary.json"), JSON.stringify(summary, null, 2));
		eventsOut.end();

		// 清理：关闭 stdin，优雅退出优先
		try { child.stdin.end(); } catch {}
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try { child.kill("SIGTERM"); } catch {}
				setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
					process.exit(0);
				}, 2000);
			} else {
				process.exit(0);
			}
		}, 500);
	});

	process.on("SIGINT", () => {
		console.error("[probe] SIGINT：走 kill 链");
		killChain();
	});
}

main();
