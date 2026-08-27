/**
 * Nodesign AskUserQuestion for pi（M2 第二步，doc §5.3 方案 A）。
 *
 * pi 无 canUseTool/elicitation —— 用 registerTool 复刻：agent 调
 * ask_user_question → execute 里 POST sidecar /ask 长轮询（pi 工具 execute
 * 裸 await 无超时，可无限阻塞，语义等同 SDK canUseTool 阻塞）→ sidecar 登记
 * 挂起 + emit run.ask_user_question → 前端问题卡片 → 用户答 → POST
 * /api/…/answer → ask-registry resolve → /ask 返回 answers → 本工具返回。
 *
 * 取消链：run cancel / session close → cancelAsksForSession reject 挂起 Promise
 * → /ask 返 503 → 这里 throw → pi 生成错误 tool result，turn 照常收尾。
 * AbortSignal（pi abort）直接中止 fetch。
 *
 * 协议文本（preview 约定等）SDK 时代是首调注入（ask-user-question-protocol.md）；
 * pi 侧收进 description —— 模型写参数前就得知道 preview 规则。
 */

import { Type } from "typebox";

const ASK_TIMEOUT_MS = 0;   // 无超时：与 SDK canUseTool 阻塞语义对齐，取消靠 abort/cancel 链

export default function setup(pi) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: [
			"向用户提结构化选择题，前端渲染成选项卡片。",
			"用法判据：有明确候选项的决策（A/B/C、视觉方向、配色字体）用它；开放问题和 yes/no 直接聊天文本问。",
			"单次 1-4 个 question，每个 2-4 个 option。选项要互斥；label 1-5 词；description 一句话讲 trade-off。",
			"不要加\"Other/其他\"选项——系统自动提供（用户可自由输入，答案在 customText）。",
			"preview 字段（可选，让用户\"看到\"差异）：",
			"- data:image/…;base64 或 .png/.jpg 结尾的地址（含 assets/ 相对路径）→ 直接显图；",
			"- 含 <…> 的文本 → 240×140 sandbox iframe 渲染 HTML 片段：只能 inline style 属性（禁 <style>/<script>/<html>/<body>），≤5KB；",
			"- 纯文本 → mono 兜底。",
			"别把 web_search 搜来的图片网址直接当 preview（多数图床地址不满足后缀判据会静默退成纯文本）；要让用户看图就先 generate_image 再贴 base64/asset 路径。",
			"调用后会阻塞等用户回答——这是正常的，回答会以结构化结果返回。",
		].join("\n"),
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ minLength: 1 }),
					header: Type.Optional(Type.String()),
					options: Type.Array(
						Type.Object({
							label: Type.String({ minLength: 1 }),
							description: Type.Optional(Type.String()),
							preview: Type.Optional(Type.String()),
						}),
						{ minItems: 2, maxItems: 4 },
					),
					multiSelect: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 1, maxItems: 4 },
			),
		}),
		executionMode: "parallel",
		async execute(toolCallId, params, signal) {
			const baseUrl = process.env.NODESIGN_MAIN_URL;
			const token = process.env.NODESIGN_TOKEN;
			const sid = process.env.NODESIGN_SID;
			const pid = process.env.NODESIGN_PROJECT;
			if (!baseUrl || !token || !sid) {
				throw new Error("ask_user_question: NODESIGN_MAIN_URL/TOKEN/SID env 缺失（sidecar 未接线）");
			}

			const res = await fetch(`${baseUrl}/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ sid, pid, questions: params.questions }),
				signal: signal ?? (ASK_TIMEOUT_MS > 0 ? AbortSignal.timeout(ASK_TIMEOUT_MS) : undefined),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(`ask_user_question 失败（${res.status}）: ${body?.error || "unknown"}`);
			}
			const { answers } = await res.json();

			// answers 与 questions 平行：[{ selectedLabels?: string[], customText?: string }]
			const lines = [];
			const list = Array.isArray(answers) ? answers : [];
			params.questions.forEach((q, i) => {
				const a = list[i] ?? {};
				const picks = Array.isArray(a.selectedLabels) && a.selectedLabels.length > 0
					? a.selectedLabels.join("、")
					: "（未选）";
				lines.push(`问：${q.question}\n答：${picks}${a.customText ? `\n用户补充：${a.customText}` : ""}`);
			});
			const text = lines.join("\n\n");
			return {
				content: [{ type: "text", text: `用户回答：\n\n${text}` }],
				details: { answers: list },
			};
		},
	});
}
