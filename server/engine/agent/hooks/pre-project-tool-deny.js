/**
 * hooks/pre-project-tool-deny.js — 项目级工具禁用闸（nodesign.config.json tools.disable）。
 *
 * 与可见集过滤的互补关系（谁负责什么，别重造）：
 *   - 内置工具 / mcp__nodesign__*：session-loop 在装配时就从可见集（tools 字段 /
 *     MCP 工具表）摘掉了 —— 命中项连名字都不进模型上下文，这条闸对它们只是兜底。
 *   - 外部 MCP（mcp__<server名>__<工具>）：SDK 子进程 client 整组连接、工具由远端
 *     枚举，我们没有逐工具注册点，可见集摘不掉 —— 这里是**唯一**能精确禁用单工具的
 *     地方：调用期拒绝（permissionDecision='deny'），模型仍看得到工具名，一调就被拒
 *     并拿到理由，然后转向。
 *
 * ⚠️ 只拦调用、不拦可见性 —— 这是外部 MCP 单工具禁用的物理上限，不是疏漏。
 * 想连工具名都不给看，只能让外部 server 自己收敛暴露面（源头）或上 in-process
 * 代理（大工程），见 project-config.js 文件头。
 *
 * deny 的语义：
 *   - 放行/闸自己出错 → 返回 {}（fail-open，跟 workspace-scope-guard 同一纪律）
 *   - 命中 → { permissionDecision: 'deny', permissionDecisionReason }
 */

import { isToolDisabled } from '../../../projects/project-config.js';

export function makePreToolUseProjectToolDeny({ disable = [] } = {}) {
  return async (input) => {
    try {
      const toolName = input?.tool_name;
      if (!toolName) return {};
      const matched = Array.isArray(disable) && disable.find((entry) => isToolDisabled(toolName, [entry]));
      if (!matched) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `工具 ${toolName} 被项目配置禁用（nodesign.config.json 的 tools.disable 命中「${matched}」）。`
            + `换不依赖它的做法完成目标；确实需要这个工具的话，向用户说明并让他改项目配置。`,
        },
      };
    } catch {
      return {};   // 闸自己出错不拦工具（fail-open）
    }
  };
}