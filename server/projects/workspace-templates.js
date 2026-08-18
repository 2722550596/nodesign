/**
 * 新工作区的起手模板（2026-08-15 从 workspace.js 拆出 —— 行数棘轮；
 * 这几坨是纯数据，跟工作区的逻辑没有耦合）。
 *
 * ⚠️ DEFAULT_GITIGNORE 是**按行合并**进已有项目的（workspace.js 的
 * ensureGitignore），所以往里加一行，全站老项目下次开会话都会补上。
 */

export const DEFAULT_GITIGNORE = `node_modules/
.DS_Store
*.log
.tmp/
# SDK 转录：一个会话一个 jsonl，一轮几百 KB，不进项目历史
.claude/projects/
# 会话私档（压缩摘要 / plan 弧）——属于对话不属于产物
.nd/
# generate_image 产物 — 通常很大且能从 spec.json 的 prompt 重生
assets/generated/
# 参考素材（web-search 下载的图 + browser_capture 从参照站带回来的）—— 同理：
# 大、可再取、而且不是"你做出了什么"。⚠️ 2026-08-18 加这条时线上已有 8 个项目
# 共 205 文件 / 76MB references 全被 track 进了 per-project git（.git 最大 95M）。
# 这条只管新写入；存量要清得手动 git rm --cached（没做，列进欠账）。
assets/references/
# 画布布局 —— 属于"你怎么摆的"，不属于"你做出了什么"。
# 进历史的坏处是具体的：每拖一次卡就弄脏工作区，而且 revertWorkspace
# 会连着把画布布局一起回退（卡片弹回旧位置、清掉的死 id 复活）。
board.json
# 演出记录（RP）—— 用户的台词是隐私不是产物：不进项目历史，回滚也不该动它。
# 顺带一层防误食：Grep 走 ripgrep，默认跳过被 gitignore 的文件。
对话.jsonl
摘要.json
`;

export const DEFAULT_SPEC_JSON = JSON.stringify(
  { version: '0.1', meta: {}, designTokens: {}, outline: [] },
  null, 2,
) + '\n';

export const DEFAULT_CLAUDE_MD = `# Project Instructions

This file is read by the AI agent at the start of every session as part of its
system prompt. Write project-specific guidance here — design intent,
constraints, vocabulary, must-do / must-not-do.

The agent will see this verbatim. Keep it concise and actionable.

## Examples
- Design tone: minimal, editorial, generous whitespace
- Hard constraints: never use red as a primary color
- Vocabulary: refer to the user as "the team"

(Edit this file from the NoDesign UI — the agent picks up changes on next session.)
`;
