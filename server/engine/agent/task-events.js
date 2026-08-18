/**
 * task-events.js — SDK 统一任务消息族（task_*）的收口翻译（2026-08-18，
 * 从 agent-shared.js handleSystemMessage 拆出）
 *
 * SDK 0.3.x 起「任务」统一化：task_* 消息不再只代表 Task 子代理 —— 后台
 * Bash（task_type 'local_bash'）、Workflow（'local_workflow'）等也走同一条。
 * 我们 run.task.* 事件的语义是「子代理」，在这个咽喉点收口：只放真子代理
 * 过去，其余不进事件流。不收口的话每条 bash 命令都会在前端顶着「子代理」
 * 的名头出现（舞台便利贴/在场徽记/侧栏状态位全线噪音，2026-08-18 事故）。
 */

import { Events } from './events.js';
import { recordTaskNotification } from './hooks/post-subagent-report.js';

/**
 * 这条 task_* 消息说的是不是真子代理（Task 工具）。靠 subagent_type /
 * task_type 区分；skip_transcript 是 SDK 标的 ambient/housekeeping 任务，
 * 按 SDK 约定对用户隐藏。
 */
export function isSubagentTask(msg) {
  if (msg.skip_transcript) return false;
  return !!msg.subagent_type || msg.task_type === 'local_agent';
}

/**
 * 本轮已放行的子代理 task_id —— task_progress / task_notification 不带
 * subagent_type，靠它过滤非子代理任务。挂在 ctx 上惰性建：task_* 消息
 * 不带 parent_tool_use_id，进来的恒是真 ctx（不是子代理的派生 ctx），
 * own property 不会写丢。
 */
function subagentTaskIds(ctx) {
  if (!ctx._subagentTaskIds) ctx._subagentTaskIds = new Set();
  return ctx._subagentTaskIds;
}

/** handleSystemMessage 的 task_* 四兄弟统一入口 */
export function handleTaskMessage(ctx, msg) {
  switch (msg.subtype) {
    case 'task_started':
      if (!isSubagentTask(msg)) return;
      subagentTaskIds(ctx).add(msg.task_id);
      ctx.emit(Events.taskStarted(
        msg.task_id, msg.description, msg.subagent_type, msg.task_type, msg.prompt, msg.tool_use_id,
      ));
      return;

    case 'task_progress':
      // agentProgressSummaries: true 时每 ~30s 一次："正在调整字号节奏" 之类
      if (!subagentTaskIds(ctx).has(msg.task_id)) return;
      ctx.emit(Events.taskProgress(
        msg.task_id, msg.description, msg.summary, msg.last_tool_name, msg.usage, msg.tool_use_id,
      ));
      return;

    case 'task_updated':
      if (!subagentTaskIds(ctx).has(msg.task_id)) return;
      ctx.emit(Events.taskUpdated(msg.task_id, msg.patch, msg.tool_use_id));
      return;

    case 'task_notification':
      // 收尾用量记账不分任务类型（进 metadata 可观测，不进主 token 列 ——
      // 防止与 result.usage 双重计数，详见 context.absorbSubagentUsage）：
      // 将来若接 workflow 之类带真用量的本地任务，账也不能漏。
      ctx.absorbSubagentUsage?.(msg.usage);
      // 报告丢失的兜底也在闸**前**：把 output_file 记下来，PostToolUse(Agent)
      // 的 handler 在报告看起来是空的时候把转录路径递给主 agent（见
      // hooks/post-subagent-report.js）。它按 tool_use_id 查、只被 Agent 工具
      // 问到，多记非子代理任务无害；安全网不该依赖过滤闸的状态（存储有界 200 条）。
      recordTaskNotification(msg);
      if (!subagentTaskIds(ctx).has(msg.task_id)) return;
      ctx.emit(Events.taskNotification(
        msg.task_id, msg.status, msg.summary, msg.usage, msg.tool_use_id,
      ));
      return;

    default:
  }
}
