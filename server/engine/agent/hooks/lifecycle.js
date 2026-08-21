/**
 * 会话生命周期族：SessionStart / Stop / PostCompact / SubagentStart / SubagentStop。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 */
import { Events } from '../events.js';
import { getQuery } from '../../runs/active-runs.js';
import { mutateSpecJson } from '../../../projects/workspace.js';
import { listWorkspaceArtifacts } from '../../../lib/artifact-target.js';
import { resetTurnMemory } from './turn-state-memory.js';

/**
 * Context usage 警告分档（按真实容量算，kimi=256k）：
 *   soft   70% — 提醒：还能再写一阵；下个段落收尾时落档
 *   firm   85% — 加紧：开始整理结论 / 准备 spec.json
 *   urgent 92% — 已过 SDK auto-compact 触发线（90%×真实=230k for 256k 容量），立即收尾
 */
const CONTEXT_USAGE_WARN_LEVELS = [
  { percent: 70, tone: 'soft' },
  { percent: 85, tone: 'firm' },
  { percent: 92, tone: 'urgent' },
];

/**
 * SessionStart handler（升级原 noop 占位）。
 *
 * input: SessionStartHookInput (sdk.d.ts:3577)
 *   - source: 'startup' | 'resume' | 'clear' | 'compact'
 *   - agent_type?: string                  父 agent 类型（--agent 时有）
 *   - model?: string
 *
 * Phase 2 范围：仅 emit 事件让上层可见。不注 additionalContext / initialUserMessage —
 * spec.json 的恢复走 UserPromptSubmit 路径（每次用户输入前重新注入），而不是
 * SessionStart 一次性注入（一次性注入只在 session 开头有效，跨多个 turn 后过期）。
 */
export function makeSessionStartHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.sessionStart(input.source, input.agent_type, ctx.appModel || input.model));
    } catch (err) {
      console.warn(`[hooks/SessionStart] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * Stop handler（P0+ s1 C6）—— agent 准备结束 query 时触发。
 *
 * 两件事：
 * 1. emit run.stop_reflection（hasCanvas 信号给前端）
 * 2. SDK getContextUsage 拉上下文占用 → emit run.context_usage + 三档 70/85/92% 注 systemMessage
 *
 * input: StopHookInput (sdk.d.ts:5247)
 *   - stop_hook_active: boolean
 *   - last_assistant_message?: string
 */
export function makeStopReflectionHandler({ ctx, workspaceRoot }) {
  return async (_input, _toolUseId, _options) => {
    let warnContextUsage = null;
    try {
      // 任务模型下产物住 tasks/<任务>/，这里以前只探 cwd 根的 canvas.html —— 自
      // 任务模型上线起就恒为 false，从来没真过。走统一寻址（deck 和站点都算数）。
      const hasCanvas = workspaceRoot
        ? (await listWorkspaceArtifacts(workspaceRoot)).length > 0
        : false;

      ctx.emit({
        type: 'run.stop_reflection',
        hasCanvas,
      });

      // SDK 0.2.86+ getContextUsage —— 每个 turn 收尾时拉一次上下文占用，
      // emit 给前端做可视化条 + 三档（70/85/92%）注 systemMessage 提示 agent 主动收尾
      // （Kimi gateway 上限 256k，曾经爆过 418k；spoofing 后 SDK auto-compact
      //  在 256k×0.9=230k 触发兜底）
      if (ctx.runId) {
        try {
          const query = getQuery(ctx.runId);
          if (query?.getContextUsage) {
            const usage = await query.getContextUsage();
            if (usage && typeof usage.totalTokens === 'number') {
              // 2026-07-30：这里原来手搓了第二种事件体 { used, max, percent, categories }。
              // 事件名跟 session-loop 那条一样，字段名一个都对不上 —— 前端读的是
              // totalTokens / maxTokens / percentage，所以这条在前端一直是纯噪音，
              // 全靠 store 的 merge「不覆盖已有值」才没显形。而每个 turn 的**最后**
              // 一条 context_usage 恰好总是它，任何"取最新一条"的下游拿到的都是
              // 一片 undefined。现在统一走 Events.contextUsage，全局只此一种形状。
              const evt = Events.contextUsage(usage, ctx.appModel);
              ctx.emit({ ...evt, runId: ctx.runId });

              const used = evt.totalTokens;
              const realMax = evt.maxTokens;
              const percent = evt.percentage;

              // realMax 有可能是 null（appModel 认不出、SDK 也没给容量）——
              // 那时 percentage 退回 SDK 自己的值，但下面的文案要拿 realMax 做减法，
              // 算不出容量就不提醒（宁可不说，也别说个编的数字）
              const hit = (Number.isFinite(realMax) && realMax > 0)
                ? [...CONTEXT_USAGE_WARN_LEVELS].reverse().find((l) => percent >= l.percent)
                : null;
              if (hit) {
                const usedStr = used.toLocaleString();
                const maxStr = realMax.toLocaleString();
                const remain = Math.max(0, realMax - used).toLocaleString();
                let body;
                if (hit.tone === 'soft') {
                  body = `上下文已用 ${percent}%（${usedStr}/${maxStr} tokens），还能再写一阵；下一个段落收尾时把当前进度落到 spec.json，避免后续 compact 丢上下文。`;
                } else if (hit.tone === 'firm') {
                  body = `上下文已用 ${percent}%（${usedStr}/${maxStr}，剩 ~${remain}）。从下一轮开始整理结论 / 落档，避免被自动 compact 硬切。`;
                } else {
                  body = `上下文已用 ${percent}%（${usedStr}/${maxStr}）。已逼近 SDK auto-compact 触发线（90%）；立即收尾或主动整理 spec.json，否则下一轮可能被压缩中断当前思路。`;
                }
                warnContextUsage = `<system-reminder>\n[context-usage] ${body}\n</system-reminder>`;
              }
            }
          }
        } catch (err) {
          console.warn(`[hooks/Stop] getContextUsage fail:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[hooks/Stop] handler threw:`, err.message);
    }
    if (warnContextUsage) {
      return { systemMessage: warnContextUsage };
    }
    return {};
  };
}

/**
 * PostCompact handler（P0+ s1 C7）—— SDK 自动 compact 后把 summary 持久化到 spec.json。
 *
 * input: PostCompactHookInput (sdk.d.ts:1879)
 *   - trigger: 'manual' | 'auto'
 *   - compact_summary: string
 *
 * 失败 fail-soft：spec.json 写不进去 console.warn 但不抛错（不阻塞 query）。
 */
export function makePostCompactHandler({ ctx, workspaceRoot, sessionId }) {
  return async (input, _toolUseId, _options) => {
    try {
      // 压缩后上一轮的状态块已经被摘要吞了，"同上轮"没有所指 —— 让下一轮重新全量
      resetTurnMemory(sessionId);
      if (!workspaceRoot) return {};
      const summary = input?.compact_summary;
      if (!summary || typeof summary !== 'string') return {};

      // 串行 read-modify-write 防 spec.json 三路并发覆盖（详见 workspace.js mutateSpecJson）
      // historyCount 在回调内 capture 出去 —— 之前 emit 里直接引用 spec 是 ReferenceError，
      // 整段被 try 静默吞，导致 run.compact_persisted 事件永远不发。
      let historyCount = 0;
      await mutateSpecJson(workspaceRoot, (spec) => {
        if (!Array.isArray(spec.history)) spec.history = [];
        spec.history.push({
          ts: new Date().toISOString(),
          source: 'compact',
          trigger: input.trigger || 'auto',
          summary,
        });
        historyCount = spec.history.length;
      });

      try {
        ctx.emit({
          type: 'run.compact_persisted',
          trigger: input.trigger || 'auto',
          summaryLength: summary.length,
          historyCount,
        });
      } catch { /* emit fail-safe */ }
    } catch (err) {
      console.warn(`[hooks/PostCompact] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * SubagentStart handler — 子代理启动时主动 emit 事件给 EventBus。
 *
 * input: SubagentStartHookInput (sdk.d.ts:5258)
 *   - agent_id: string
 *   - agent_type: string
 *
 * 与 SDK system 'task_started' message 路径并行：task_* message 走的是 SDK
 * agentProgressSummaries 通道（30s 摘要），而 hook 是子代理 spawn 时立即触发，
 * 时序更前 + 更可靠。session-loop.js 已对 task_started 翻译成 run.task.started，
 * 这条 hook emit 的 run.subagent.start 是更主动的入口。
 *
 * Phase 2 仅 emit；不注入 additionalContext（子代理刚启动还没产出，注啥都早）。
 */
export function makeSubagentStartHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStart(input.agent_id, input.agent_type));
    } catch (err) {
      console.warn(`[hooks/SubagentStart] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * SubagentStop handler — 子代理结束时主动 emit。
 *
 * input: SubagentStopHookInput (sdk.d.ts:5269)
 *   - stop_hook_active: boolean
 *   - agent_id: string
 *   - agent_transcript_path: string       子代理转录文件路径
 *   - agent_type: string
 *   - last_assistant_message?: string     子代理最后一条 assistant 文本
 *
 * 注意：SubagentStop 没有 specific output 类型（sdk.d.ts:5291 的 union 里没列），
 * 只能返回通用 SyncHookJSONOutput（continue/decision/systemMessage）。
 * 这里只 emit 不返 specific 输出，符合规范。
 */
export function makeSubagentStopHandler({ ctx }) {
  return async (input, toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStop(
        input.agent_id,
        input.agent_type,
        input.last_assistant_message,
        input.agent_transcript_path,
        toolUseId,    // main agent 调 Task 时的 tool_use_id；前端按它 match 卡
      ));
    } catch (err) {
      console.warn(`[hooks/SubagentStop] handler threw:`, err.message);
    }
    return {};
  };
}
