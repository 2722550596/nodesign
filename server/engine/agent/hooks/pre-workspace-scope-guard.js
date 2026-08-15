/**
 * pre-workspace-scope-guard —— 结构化工具的项目边界闸（2026-08-15）
 *
 * 沙盒（bwrap）只管 Bash。Read / Grep / Glob / Write / Edit 是 SDK 进程内工具，
 * 不进 bwrap —— 2026-08-15 探针实测：沙盒开着，Read 照样能读别的项目的工作区，
 * Write 照样能往 cwd 外落文件。凭据那部分由 permissions.deny 盖住了
 * （runtime/platform.js），**但"别人的项目"盖不住**：deny 规则没有"除了自己这个"
 * 的写法（deny 压过 allow），而项目是动态新建的。
 *
 * 两条判据，读写不一样严：
 *   - **写**（Write/Edit/NotebookEdit）：只准落在自己的工作区或临时目录。
 *     写东西到别处没有任何正当理由 —— 产物都在工作区里。
 *   - **读**（Read/Grep/Glob）：只拦数据根内部的越界。仓库、plugin/skill 目录、
 *     /tmp 照读不误 —— 那是干活要用的（skill 附件就在仓库里）。
 *
 * 边界（故意窄，别自己脑补更严）：
 *   - 凭据不归它管（那是 platform.protectedPathRules 的活，两边别互相假设）。
 *   - 自己出错就放行（fail-open）—— 闸崩了不该把整个会话堵死。
 */

import os from 'node:os';
import path from 'node:path';

const TARGET_FIELDS = ['file_path', 'path', 'notebook_path'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function insideDir(abs, dir) {
  return abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** 临时目录（沙盒会把 TMPDIR 指到自己那份，两个都认） */
function tempDirs() {
  return [process.env.TMPDIR, os.tmpdir(), '/tmp'].filter(Boolean).map(d => path.resolve(d));
}

/**
 * @returns {null | string} null=放行；string=拒绝理由
 */
export function checkWorkspaceScope(toolInput, { workspaceRoot, dataRoot, toolName } = {}) {
  if (!workspaceRoot) return null;
  const ws = path.resolve(workspaceRoot);
  const isWrite = WRITE_TOOLS.has(toolName);
  if (!isWrite && !dataRoot) return null;
  const root = dataRoot ? path.resolve(dataRoot) : null;
  for (const field of TARGET_FIELDS) {
    const v = toolInput?.[field];
    if (typeof v !== 'string' || !v) continue;
    const abs = path.resolve(ws, v);          // 相对路径按工作区解析
    if (insideDir(abs, ws)) continue;         // 自己的工作区，放行
    if (isWrite) {
      if (tempDirs().some(d => insideDir(abs, d))) continue;   // 临时文件随便写
      return `${toolName} 只能落在你自己的工作区里（${ws}），或者临时目录。`
        + '产物、草稿、附件全都归工作区管；往外写一律拒绝。';
    }
    if (!root || !insideDir(abs, root)) continue;   // 数据根之外的读不归这道闸管
    return '这个路径在别的项目的工作区里，不是你这个项目的东西。'
      + `你的工作区是 ${ws} —— 用相对路径就好，越过它去读写别人的项目一律拒绝。`;
  }
  return null;
}

export function makePreToolUseWorkspaceScopeGuard({ workspaceRoot, dataRoot }) {
  return async (input) => {
    try {
      const reason = checkWorkspaceScope(input?.tool_input, {
        workspaceRoot, dataRoot, toolName: input?.tool_name,
      });
      if (!reason) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    } catch { return {}; }                    // 闸自己出错不拦工具（fail-open）
  };
}
