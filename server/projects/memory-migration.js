/**
 * projects/memory-migration.js — 记忆体系改版迁移（2026-08-24，幂等）
 *
 * ensureProjectWorkspace 每次调用（源不在了就什么都不做）：
 *   ① .claude/CLAUDE.md → <root>/CLAUDE.md（根上已有就把旧文件并进末尾再删）
 *   ② .claude/agent-memory/memory.md、brand/memory.md → 并进根 CLAUDE.md 的
 *      「用户习惯」/「风格档案」节末尾，源删除
 *   ③ .claude/agent-memory/auto/* → 记忆/（SDK auto-memory 新家，画布可见）
 * 三步全是"搬走后源删除"，跑几遍结果一样。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DEFAULT_CLAUDE_MD, MEMORY_DIR_NAME } from './workspace-templates.js';

/** 改版前的默认模板原文（迁移判据用：全文相等 = 用户没写过一个字，不搬） */
const OLD_DEFAULT_CLAUDE_MD = `# Project Instructions

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

export async function migrateMemoryLayout(root, { fileExists }) {
  const rootMd = path.join(root, 'CLAUDE.md');
  const appendTo = async (heading, text, label) => {
    const body = String(text || '').trim();
    if (!body) return;
    let cur = '';
    try { cur = await fs.readFile(rootMd, 'utf8'); } catch { /* 还没有 */ }
    if (!cur.trim()) cur = DEFAULT_CLAUDE_MD;   // 起新文件时以「项目档案」模板打底
    await fs.writeFile(rootMd, `${cur ? `${cur.replace(/\n+$/, '')}\n\n` : ''}${heading}\n（${label}，2026-08-24 自动迁入）\n\n${body}\n`, 'utf8');
  };
  const oldMd = path.join(root, '.claude', 'CLAUDE.md');
  try {
    const t = await fs.readFile(oldMd, 'utf8');
    // 旧英文默认模板（用户一个字没改，**全文精确比对**才算）没有搬运价值 ——
    // 删掉让 ensure 落新版「项目档案」模板。差一个字都按用户内容原样搬，宁可
    // 多搬不可误删（判据宽了会吃掉用户在模板上的增改）。
    if (t.trim() === OLD_DEFAULT_CLAUDE_MD.trim()) {
      await fs.rm(oldMd, { force: true });
    } else {
      if (await fileExists(rootMd)) await appendTo('## 项目指引', t, '原 .claude/CLAUDE.md');
      else await fs.writeFile(rootMd, t, 'utf8');
      await fs.rm(oldMd, { force: true });
    }
  } catch { /* 没有旧文件：新项目 */ }
  const memRoot = path.join(root, '.claude', 'agent-memory');
  try {
    const t = await fs.readFile(path.join(memRoot, 'memory.md'), 'utf8');
    await appendTo('## 用户习惯', t, '原用户偏好记忆');
    await fs.rm(path.join(memRoot, 'memory.md'), { force: true });
  } catch { /* */ }
  try {
    const t = await fs.readFile(path.join(memRoot, 'brand', 'memory.md'), 'utf8');
    await appendTo('## 风格档案', t, '原风格档案');
    await fs.rm(path.join(memRoot, 'brand'), { recursive: true, force: true });
  } catch { /* */ }
  // auto/ 的存量记忆搬去 记忆/（同名不覆盖：目标已有的跳过，宁可留双份可见）
  const autoDir = path.join(memRoot, 'auto');
  try {
    const entries = await fs.readdir(autoDir, { withFileTypes: true });
    const dest = path.join(root, MEMORY_DIR_NAME);
    await fs.mkdir(dest, { recursive: true });
    for (const e of entries) {
      const from = path.join(autoDir, e.name);
      const to = path.join(dest, e.name);
      if (await fileExists(to)) continue;
      await fs.rename(from, to).catch(() => {});
    }
    const left = await fs.readdir(autoDir).catch(() => []);
    if (left.length === 0) await fs.rm(autoDir, { recursive: true, force: true });
  } catch { /* 没有 auto/：多数项目 */ }
}

