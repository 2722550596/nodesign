/**
 * agent/memory-config.js — auto-memory 的产品化配置（2026-08-24 记忆体系改版）
 *
 * 记忆两层的分工（用户拍板）：
 *   - `记忆/`（工作区根下，画布可见）：SDK auto-memory 的家。提示词、写入、
 *     MEMORY.md 索引加载、权限放行全跟 autoMemoryDirectory 一个值走（二进制 yh()，
 *     08-24 探明）。用户看得到每一条、也可能直接改。
 *   - 根 `CLAUDE.md`：人工筛选的项目档案（指引/风格/习惯），SDK 每会话
 *     确定性全量注入（settingSources 'project' 原生行为，根目录与 .claude/ 两处都读）。
 *
 * ⚠️ EXTRA_GUIDELINES 是**追加**不是替换：SDK 自己的记忆合同（frontmatter 契约、
 * 两步写入、200 行索引上限与截断提醒）原样保留。别换成 CLAUDE_COWORK_MEMORY_GUIDELINES
 * 整段替换 —— 那会把截断提醒一起抹掉，而截断逻辑仍在跑，索引爆了没人说话。
 */

import path from 'node:path';

/** 记忆目录名（工作区根相对）。画布可见是设计要求，不是巧合。 */
export const MEMORY_DIR_NAME = '记忆';

export function memoryDirFor(sharedRoot) {
  return path.join(sharedRoot, MEMORY_DIR_NAME);
}

/** 追加进 SDK 记忆提示末尾的产品口径（env CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES） */
export const MEMORY_EXTRA_GUIDELINES = [
  'This memory directory (记忆/) is VISIBLE on the user\'s canvas — they can read',
  'every file and may edit them between sessions; treat edits as ground truth.',
  'Keep file names as short English kebab-case slugs (the SDK contract), but write',
  'descriptions and content in the user\'s language (中文 for this product).',
  'When a style decision is settled (palette / fonts / materials / art direction),',
  'record it as a `type: project` memory right away — style anchors are the most',
  'expensive thing to lose between sessions.',
  'Hard constraints and curated project guidance live in the workspace-root',
  'CLAUDE.md (deterministically injected every session) — put lasting rules there',
  '(with the user\'s consent), and put evolving facts here.',
].join(' ');

/**
 * 把我们的 settings 跟 isolationOptions.settings **深合并**成 SDK 的最终 settings。
 *
 * ⛔ 存在的理由（08-24 案）：08-15 起 buildIsolationOptions 的返回值里也有
 * settings 键，query options 里对象展开写在后面，把独立写的 settings 整个覆盖 ——
 * autoMemoryEnabled / autoMemoryDirectory / skipWebFetchPreflight 八天没送到
 * SDK 手里（agent 照 SDK 默认路径写记忆被沙盒拒、~/.claude 下堆了 187 个空目录）。
 * 「两处同名键静默互吞」没有任何报错，出口断言在这里兜。
 */
export function mergeAgentSettings(isolationSettings, { skipWebFetchPreflight, sharedRoot }) {
  const settings = {
    ...isolationSettings,
    skipWebFetchPreflight,
    ...(sharedRoot ? {
      autoMemoryEnabled: true,
      autoMemoryDirectory: memoryDirFor(sharedRoot),
    } : {}),
  };
  if (sharedRoot && !settings.autoMemoryDirectory) {
    throw new Error('[memory-config] settings.autoMemoryDirectory 被吞了 —— 检查 settings 合并处');
  }
  return settings;
}
