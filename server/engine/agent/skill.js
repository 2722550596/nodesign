/**
 * skill.js — Skill 加载器（YAML frontmatter + Markdown body）
 *
 * 目录结构（2026-05-18 起，对齐 Claude Code plugin convention）：
 *   server/engine/plugins/nodesign/
 *     .claude-plugin/plugin.json       — plugin 元数据
 *     skills/<skill-id>/SKILL.md       — 各 skill
 *     skills/<skill-id>/<其他起手文件>
 *
 * SKILL.md 格式（YAML frontmatter + body）：
 *   ---
 *   name: deskskill-engine-mini
 *   version: 0.0.1
 *   description: 给 LLM 看的"什么时候用我"的描述
 *   ---
 *
 *   # System Prompt
 *
 *   你是一个 deck 设计 agent...（任意 markdown）
 *
 * 本模块职责：
 *   - 解析 SKILL.md 的 YAML frontmatter + body（loadSkill / listSkills）
 *   - 把 skill 起手文件（canvas.template.html 等）拷进 session cwd（ensureSkillStarterFiles）
 *
 * SDK 集成（在 session-loop.js）：
 *   - plugins: [{ type: 'local', path: PLUGIN_ROOT }]  → 让 SDK 识别本 plugin
 *   - skills: [<skill-id>]                              → 让 SDK 把 description 注入 system prompt
 *   - SKILL.md body 通过 SDK 内置 Skill 工具按需加载（不再走 systemPrompt.append 恒驻）
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Plugin 根目录（含 .claude-plugin/plugin.json + skills/）*/
export const PLUGIN_ROOT = path.resolve(
  process.env.NODESIGN_PLUGIN_DIR || path.join(__dirname, '../plugins/nodesign')
);

/** Skills 子目录（plugin convention：<plugin>/skills/<skill-id>/SKILL.md）*/
export const SKILLS_ROOT = path.resolve(
  process.env.NODESIGN_SKILLS_DIR || path.join(PLUGIN_ROOT, 'skills')
);

/**
 * 加载一个 skill。返回 { id, name, version, description, systemPrompt, raw }。
 * 找不到时抛 Error（code='SKILL_NOT_FOUND'）。
 */
export async function loadSkill(skillId) {
  if (!skillId || typeof skillId !== 'string') {
    throw Object.assign(new Error('loadSkill: skillId required'), { code: 'INVALID_SKILL_ID' });
  }

  const skillDir = path.join(SKILLS_ROOT, skillId);
  const skillFile = path.join(skillDir, 'SKILL.md');

  let raw;
  try {
    raw = await fs.readFile(skillFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(
        new Error(`skill not found: ${skillId} (expected at ${skillFile})`),
        { code: 'SKILL_NOT_FOUND' }
      );
    }
    throw err;
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    id: skillId,
    name: frontmatter.name || skillId,
    version: frontmatter.version || '0.0.0',
    description: frontmatter.description || '',
    systemPrompt: body.trim(),
    frontmatter,
    raw,
  };
}

/**
 * 列出 SKILLS_ROOT 下所有 skill。
 * 每条返回 { id, name, version, description }（不读 body）
 */
export async function listSkills() {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile, 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      skills.push({
        id: entry.name,
        name: frontmatter.name || entry.name,
        version: frontmatter.version || '0.0.0',
        description: frontmatter.description || '',
      });
    } catch { /* ignore broken skills */ }
  }
  return skills;
}

/**
 * 把 skill 自带的工作区起手文件（目前主要是 canvas.template.html）拷贝
 * 进 session cwd，让 agent 能直接 `Read canvas.template.html` 而不必去
 * 仓库相对路径找（agent 看不到 server/engine/skills/）。
 *
 * **拷贝不软链**：
 *   - 跨平台稳（Windows symlink 要 admin / Linux bwrap 不解析 symlink）
 *   - 防 agent 误 Edit 改源模板（影响其他 session）
 *   - session 是一次性沙盒，拷贝快照语义合理
 *
 * **幂等**：文件已存在就不覆盖（agent 改过的、或上次 session init 拷过的不动）。
 *
 * 当前只拷一个 `canvas.template.html` 起手文件；未来若 skill 多个起手文件
 * 可加配置（frontmatter 加 `starter_files: [a, b]` 之类）。
 *
 * @param {string} sessionRoot - sessions/<sid>/ 绝对路径
 * @param {string} skillId    - 同 loadSkill 的 skillId
 * @returns {Promise<{ copied: string[], skipped: string[] }>}
 */
export async function ensureSkillStarterFiles(sessionRoot, skillId) {
  const result = { copied: [], skipped: [] };
  if (!sessionRoot || !skillId) return result;

  const skillDir = path.join(SKILLS_ROOT, skillId);
  const STARTER_FILES = ['canvas.template.html'];

  for (const name of STARTER_FILES) {
    const src = path.join(skillDir, name);
    const dst = path.join(sessionRoot, name);

    let srcExists = false;
    try {
      await fs.access(src);
      srcExists = true;
    } catch { /* skill 没这个起手文件 */ }
    if (!srcExists) continue;

    let dstExists = false;
    try {
      await fs.access(dst);
      dstExists = true;
    } catch { /* dst 不存在，需要拷 */ }
    if (dstExists) {
      result.skipped.push(name);
      continue;
    }

    try {
      await fs.copyFile(src, dst);
      result.copied.push(name);
    } catch (err) {
      console.warn(
        `[skill] copy ${name} failed (${err.code || err.message}); `
        + `agent will not have it in cwd`,
      );
    }
  }

  return result;
}

// ── frontmatter 解析（极简 YAML：只支持 key: value）──

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * 解析 SKILL.md 的 frontmatter + body。
 * 不支持嵌套 / 多行 / list — 只接受 `key: value` 形态。
 *
 * 没 frontmatter 的文件：返回 { frontmatter: {}, body: <整个文件> }
 */
function parseFrontmatter(raw) {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };

  const [, yamlText, body] = m;
  const frontmatter = {};
  for (const line of yamlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // 去掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: body || '' };
}

// 暴露供单测
export { parseFrontmatter };
