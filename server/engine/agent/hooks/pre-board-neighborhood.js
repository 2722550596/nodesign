/**
 * PreToolUse(Read|Edit|Write) —— 关系线邻域注入（2026-08-14 切片③）。
 *
 * agent 正要摸的文件身上如果连着线（用户手画的标注、改自/对照谱系），这一刻
 * 就是它最相关的时刻。每个文件一个会话只注一次（线是慢变数据，重复注是噪音）；
 * fail-soft —— 注不上不能挡工具。
 *
 * UserPromptSubmit 的全图摘要截断后，这里做精确补充。
 */
import { fileNeighborhood } from '../../../lib/board-relations.js';
import { toWorkspaceRel } from '../../../lib/workspace-path.js';

export function makePreToolUseBoardNeighborhoodInjector({ workspaceRoot, projectId }) {
  const seen = new Set();
  return async (input) => {
    try {
      if (!projectId) return {};
      const fp = input?.tool_input?.file_path;
      if (typeof fp !== 'string' || !fp) return {};
      const rel = toWorkspaceRel(fp, workspaceRoot);
      if (!rel || seen.has(rel)) return {};
      seen.add(rel);
      const brief = await fileNeighborhood(projectId, rel, { limit: 6 });
      if (!brief) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: `画布上连着 ${rel} 的关系线：\n${brief}`,
        },
      };
    } catch { return {}; }
  };
}
