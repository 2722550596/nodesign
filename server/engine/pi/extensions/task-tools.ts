/**
 * task-tools.ts —— Nodesign pi 任务清单工具（TaskCreate/TaskUpdate/TaskList）。
 *
 * 复刻 SDK 时代 agent-shared.js（M2 已删）的 todo 镜像管线生产端：
 * 模型调三个任务工具 → 本扩展改 per-turn store → 经 sidecar /emit 发
 * run.todo.updated（payload = store.mirror()，[{content,status,activeForm?}]
 * 不带 id，对齐 SDK 形状）→ 消费端零改动：board-tasklist.js 把它落成画布
 * 「步骤清单」板书，live-turn.js 快照 todos 字段。
 * 存储语义：SDK 是 per-ctx WeakMap；pi 扩展是 per-session 进程 → agent_start
 * 时 reset（agent_start 每次用户 prompt 发一次；turn_start 是每个 LLM round
 * 都发 —— 用它 reset 会在 TaskCreate 与 TaskUpdate 之间把清单清空，实测栽过）。
 *
 * 并发：三个工具都标 executionMode:"sequential"。pi 默认 toolExecution=parallel
 * （agent.ts:237），一条消息里 TaskCreate×3 会并发跑、各自并发发 /emit，
 * board-tasklist 的异步落盘 read-modify-write 会竞态、后到者覆盖先到者
 * （板书少行/丢勾选，实测栽过）。agent-loop.ts:420-422 认 per-tool sequential：
 * 批内任一 sequential 就整批串行 —— 正好把共享 store 的写串行化。
 *
 * 发射通路（guards.ts/inject.ts 同款）：POST ${NODESIGN_MAIN_URL}/emit，
 * body {sid, pid, event}，Authorization: Bearer ${NODESIGN_TOKEN}。
 * 失败只 warn 不抛 —— 上报通路挂了不该影响会话（板书缺席本身就是诊断信号）。
 *
 * env（lifecycle spawn 注入）：NODESIGN_MAIN_URL / NODESIGN_TOKEN /
 * NODESIGN_SID / NODESIGN_PROJECT / NODESIGN_DISABLED_TOOLS（逗号分隔禁用名）。
 */

import { Type } from "typebox";
import { createTaskStore } from "../task-store.js";

const SIDECAR_TIMEOUT_MS = 5000;

/** 三个工具共享的纪律文本（模型写参数前就得知道清单会上板书、用户实时可见）。 */
const DISCIPLINE = [
	"纪律：多步任务（三步以上）开工前先逐条 TaskCreate 列出步骤，步骤写成人看得懂的一句话",
	"（如「读取现有板书结构」而不是「read files」）；开始做某一步时 TaskUpdate 标 in_progress，",
	"做完立刻标 completed。系统会把清单镜像成画布上的「步骤清单」板书，用户实时可见，",
	"不要在回复文本里再手写一遍清单。",
].join("");

/**
 * 经 sidecar /emit 上报 run.todo.updated。
 * 契约：POST ${NODESIGN_MAIN_URL}/emit，body {sid, pid, event}，
 * Authorization: Bearer ${NODESIGN_TOKEN}（对齐 sidecar-client.js 形状）。
 * 失败只 warn 不抛（对齐 guards.ts emitInitContract 的兜底风格）。
 */
async function emitTodo(store) {
	const baseUrl = process.env.NODESIGN_MAIN_URL;
	const token = process.env.NODESIGN_TOKEN;
	const sid = process.env.NODESIGN_SID;
	if (!baseUrl || !token || !sid) {
		console.warn("[task-tools] run.todo.updated 无法上报（sidecar env 缺失）");
		return;
	}
	try {
		const res = await fetch(`${baseUrl}/emit`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({
				sid,
				pid: process.env.NODESIGN_PROJECT,
				event: { type: "run.todo.updated", todos: store.mirror() },
			}),
			signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
		});
		if (!res.ok) console.warn(`[task-tools] run.todo.updated 上报失败: HTTP ${res.status}`);
	} catch (err) {
		console.warn(`[task-tools] run.todo.updated 上报失败（忽略）: ${err?.message || err}`);
	}
}

/** NODESIGN_DISABLED_TOOLS（逗号分隔）里点名的工具不注册。 */
function disabledTools() {
	const set = Object.create(null);
	for (const part of (process.env.NODESIGN_DISABLED_TOOLS || "").split(",")) {
		const name = part.trim();
		if (name) set[name] = true;
	}
	return set;
}

/**
 * pi extension 工厂。-e 绝对路径挂载归 lifecycle.js（Main 统一接），本文件
 * 不碰 spawn 侧。
 */
export default function setup(pi) {
	const store = createTaskStore();

	// per-turn 语义：每次用户 prompt（agent_start）清空，清单跟 run 走（板书按 runId 分键）。
	pi.on("agent_start", () => {
		try {
			store.reset();
		} catch (err) {
			console.warn(`[task-tools] agent_start reset 失败（忽略）: ${err?.message || err}`);
		}
	});

	const disabled = disabledTools();

	if (!disabled.TaskCreate) {
		pi.registerTool({
			name: "TaskCreate",
			label: "Task Create",
			description: [
				"新增一条任务到本轮步骤清单（初始 status=pending），返回任务编号。",
				DISCIPLINE,
			].join("\n"),
			parameters: Type.Object({
				subject: Type.String({ minLength: 1 }),
				activeForm: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			async execute(toolCallId, params) {
				const id = store.create(params.subject, params.activeForm);
				await emitTodo(store);
				const n = String(id).replace(/^t/, "");
				return {
					content: [{ type: "text", text: `Task #${n} created: ${params.subject}` }],
				};
			},
		});
	}

	if (!disabled.TaskUpdate) {
		pi.registerTool({
			name: "TaskUpdate",
			label: "Task Update",
			description: [
				"更新清单中某条任务：status（pending/in_progress/completed，deleted=删除该条）、",
				"activeForm、subject 均可选，只改传入的字段。taskId 形如 t1、t2（TaskCreate 返回值）。",
				DISCIPLINE,
			].join("\n"),
			parameters: Type.Object({
				taskId: Type.String({ minLength: 1 }),
				status: Type.Optional(Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
					Type.Literal("deleted"),
				])),
				activeForm: Type.Optional(Type.String()),
				subject: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			async execute(toolCallId, params) {
				const hit = store.update(params.taskId, {
					status: params.status,
					activeForm: params.activeForm,
					subject: params.subject,
				});
				if (hit) await emitTodo(store);
				return {
					content: [{ type: "text", text: hit ? `Updated ${params.taskId}` : `No task ${params.taskId}` }],
				};
			},
		});
	}

	if (!disabled.TaskList) {
		pi.registerTool({
			name: "TaskList",
			label: "Task List",
			description: [
				"返回本轮全部任务（JSON，含 id/content/status/activeForm）。",
				DISCIPLINE,
			].join("\n"),
			parameters: Type.Object({}),
			executionMode: "sequential",
			async execute() {
				return {
					content: [{ type: "text", text: JSON.stringify({ tasks: store.list() }) }],
				};
			},
		});
	}
}
