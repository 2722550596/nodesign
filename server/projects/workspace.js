/**
 * server/projects/workspace.js — Per-project + per-session 文件系统 workspace
 *
 * H3：session-scoped 工作目录。每个 session 一个独立沙盒（含 canvas.html /
 * spec.json / .git），跨 session 共享 shared/.claude/ 配置和 shared/assets/。
 *
 * 结构：
 *   <PROJECTS_DATA_ROOT>/<projectId>/
 *     ├── shared/                    ← project 共享
 *     │   ├── .claude/
 *     │   │   ├── CLAUDE.md          ← 项目 instruction（用户写）
 *     │   │   ├── settings.json      ← 项目 SDK config
 *     │   │   ├── skills/            ← 项目级 skills
 *     │   │   ├── agents/            ← 项目级 subagents
 *     │   │   └── agent-memory/      ← 跨 session memory（agent 写）
 *     │   ├── assets/                ← 用户上传文件
 *     │   └── .gitignore
 *     └── sessions/<sid>/            ← session 独立沙盒
 *         ├── canvas.html
 *         ├── spec.json
 *         ├── assets                 ← softlink → <abs shared>/assets（绝对路径）
 *         ├── skills                 ← softlink → <abs shared>/.claude/skills（绝对路径）
 *         ├── agents                 ← softlink → <abs shared>/.claude/agents（绝对路径）
 *         ├── agent-memory           ← softlink → <abs shared>/.claude/agent-memory（绝对路径）
 *         ├── .claude/
 *         │   ├── CLAUDE.md          ← softlink → <abs shared>/.claude/CLAUDE.md（绝对路径）
 *         │   ├── settings.json      ← softlink → <abs shared>/.claude/settings.json（绝对路径）
 *         │   └── projects/<encoded-cwd>/<sid>.jsonl ← SDK 自动写转录
 *         └── .git/                  ← per-session history
 *
 * agent 跑 run 时 cwd 设到 sessions/<sid>/，SDK settingSources: ['project']
 * 通过软链拿到 shared/.claude/CLAUDE.md。assets 走 SDK additionalDirectories
 * 让 agent 能跨目录 Read。
 *
 * 边界：
 *   - validateProjectId / validateSessionId 防 traversal
 *   - git ops 走 child_process spawn（不开 shell，args 不被 shell 解释）
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { mutex } from 'async-mutex-lite';
import { validateProjectId } from './store.js';
import { resolveModelContextWindow } from '../engine/agent/model-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per-sessionRoot read-modify-write 串行 utility。
 *
 * 解决：record_decision / expose_tweaks / PostCompact 3 处都 readFile→mutate→writeFile
 * 同 spec.json，无锁 → 后写者 silent 覆盖前写者全量内容（"刚 record 的 decision 没了"
 * 类 bug）。三处统一通过本 helper 写，async-mutex-lite 是 module-singleton，所有
 * import 共享 lock map，按 key 串行。
 *
 * @param {string} workspaceRoot - sessions/<sid>/ 路径
 * @param {(spec: object) => (object|void|Promise<object|void>)} mutator
 *        接收已 parse 的 spec object（不存在 / 解析失败时是 {}），同步或异步 mutate；
 *        return 的 object 当新 spec 写回（或 mutate 原 object 不 return 也行）。
 * @returns {Promise<object>} 写入后的 spec
 */
export async function mutateSpecJson(workspaceRoot, mutator) {
  return mutex(`spec:${workspaceRoot}`, async () => {
    const specPath = path.join(workspaceRoot, 'spec.json');
    let spec = {};
    try {
      const raw = await fs.readFile(specPath, 'utf8');
      spec = JSON.parse(raw);
      if (!spec || typeof spec !== 'object') spec = {};
    } catch { /* file not exist / parse error → fresh */ }
    const next = (await mutator(spec)) || spec;
    await fs.writeFile(specPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}

export const PROJECTS_DATA_ROOT = path.resolve(
  process.env.PROJECTS_DATA_DIR || path.join(__dirname, '../projects-data'),
);

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SDK sessionId 必须 UUID 格式（防路径 traversal） */
export function validateSessionId(sid) {
  if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
    throw Object.assign(new Error(`非法 sessionId: ${JSON.stringify(sid)}`), { code: 'INVALID_SESSION_ID' });
  }
}

const DEFAULT_GITIGNORE = `node_modules/
.DS_Store
*.log
.tmp/
# generate_image 产物 — 通常很大且能从 spec.json 的 prompt 重生
assets/generated/
`;

const DEFAULT_SPEC_JSON = JSON.stringify(
  { version: '0.1', meta: {}, designTokens: {}, outline: [] },
  null, 2,
) + '\n';

const DEFAULT_CLAUDE_MD = `# Project Instructions

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

/**
 * NoDesign 全局默认 settings.json — 代码是 source of truth。
 *
 * 每次 ensureProjectWorkspace 都会跟 shared/.claude/settings.json merge
 * （existing 字段优先，新增 default 字段补上）。这样升级现存 project 不需要
 * 用户手动改文件。
 *
 * autoCompactEnabled / autoCompactWindow：
 *   2026-05-01 加 — Kimi gateway 上下文上限 256k（262144 tokens）。当前默认
 *   模型 kimi-k2.6 一旦 prompt 累积超 256k → gateway 直接 400 报错（用户实测
 *   request id 20260501104913995449543DV62Dl5F：requested 418547 tokens）。
 *   按 256k × 90% = 230400 tokens 触发自动 compact，SDK 用同模型压缩对话历史。
 *   PostCompact hook（hooks.js:84）已就位，compact 后摘要写 spec.json 长期记忆。
 *
 *   ⚠️ 历史坑（2026-05-08 修）：SDK binary 内部 model registry 不识别 kimi-*，
 *   rawMaxTokens fallback 到 Anthropic 标准 200000，链式后果 maxTokens
 *   = min(autoCompactWindow=230400, rawMaxTokens=200000) = 200000，
 *   autoCompactWindow=230400 永远被卡 200k，浪费 60k+ Kimi gateway 真实容量。
 *   修法：engine/agent/model-context.js 把 sdkOptions.model spoofing 成
 *   `claude-opus-4-7[1m]`（SDK 认 1M context），rawMaxTokens=1M 不再卡 230400；
 *   binary-fixup-proxy 在出口把 model 还原成真 kimi-k2.6 给 gateway。
 *   现在 230400 真生效，SDK auto-compact 在 230k 触发，留 26k margin 防 400。
 *
 *   2026-07-27 起不再写死 230400：按 NODESIGN_MODEL 真实窗口 × 0.9 计算。
 *   sonnet-5[1m] → 900000（SDK 在此再扣内部 reserve，实际 compact 触发 ~86w）；
 *   kimi-k2.6 → 230400（原值，256000 × 0.9）；未知模型兜底 200000 × 0.9。
 *   SDK 接受 1e5 ~ 1e6 区间。切回 kimi 只需改 env 重启，默认值自动跟随。
 *   旧项目 settings.json 里遗留的 230400 视为 stale default 强制迁移
 *  （mergeSettingsDefaults 内特判），用户手改过的其他值不动。
 */
const MAIN_MODEL = process.env.NODESIGN_MODEL || 'kimi-k2.6';
const LEGACY_DEFAULT_WINDOWS = new Set([230400]);

function defaultAutoCompactWindow() {
  const realWindow = resolveModelContextWindow(MAIN_MODEL) ?? 200_000;
  return Math.min(Math.round(realWindow * 0.9), 1_000_000);
}

const DEFAULT_NODESIGN_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  autoCompactEnabled: true,
  autoCompactWindow: defaultAutoCompactWindow(),
};

/**
 * Merge NoDesign defaults 到现存 settings.json（existing 字段优先）。
 * 文件不存在时直接落 defaults。
 *
 * @returns {Promise<boolean>} 是否有改动（true = 写入了，false = 完全相同跳过）
 */
async function mergeSettingsDefaults(settingsPath) {
  let existing = {};
  if (await fileExists(settingsPath)) {
    try {
      existing = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch (err) {
      // 损坏的 JSON：保留备份后用 defaults 覆盖
      const backup = settingsPath + `.broken-${Date.now()}`;
      await fs.rename(settingsPath, backup).catch(() => {});
      console.warn(`[workspace] settings.json parse failed, backed up to ${backup}`);
      existing = {};
    }
  }
  const merged = { ...DEFAULT_NODESIGN_SETTINGS, ...existing };
  // stale default 迁移：旧代码把 230400 写进过所有项目的 settings.json，
  // existing 优先的 merge 规则会让新默认值永远进不去 —— 命中旧默认值时视为
  // "非用户自定义"，跟随当前默认。用户改成其他数字则尊重不动。
  if (
    LEGACY_DEFAULT_WINDOWS.has(existing.autoCompactWindow) &&
    existing.autoCompactWindow !== DEFAULT_NODESIGN_SETTINGS.autoCompactWindow
  ) {
    merged.autoCompactWindow = DEFAULT_NODESIGN_SETTINGS.autoCompactWindow;
  }
  // 旧 _comment 字段不再写默认（曾经的 placeholder），用户自定义保留
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return false;
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return true;
}

// .claude/ 内只保留 SDK 原生支持的文件型软链（避免目录型软链触发 bwrap 冲突）
const CLAUDE_DOT_LINKS = ['CLAUDE.md', 'settings.json'];
// 目录型共享软链放 session root（bwrap 不会扫 session root 做 bind 冲突判断）
const ROOT_DIR_LINKS = ['skills', 'agents', 'agent-memory'];

// ── 路径 helpers ──

/** project workspace 根（不保证存在） */
export function getProjectWorkspace(projectId) {
  validateProjectId(projectId);
  return path.join(PROJECTS_DATA_ROOT, projectId);
}

/** project 共享配置 + 资源目录（shared/） */
export function getSharedDir(projectId) {
  return path.join(getProjectWorkspace(projectId), 'shared');
}

/** 单个 session 的工作目录（sessions/<sid>/） */
export function getSessionWorkspace(projectId, sessionId) {
  validateSessionId(sessionId);
  return path.join(getProjectWorkspace(projectId), 'sessions', sessionId);
}

// ── ensure ──

/**
 * 创建 project workspace（幂等）。完成后保证：
 *   - shared/.claude/{CLAUDE.md, settings.json} 模板写入（仅不存在时）
 *   - shared/.claude/{skills, agents, agent-memory} 目录存在（让 sessions 软链有效）
 *   - shared/assets/ 存在
 *   - shared/.gitignore 写入
 *
 * 不在此处 git init shared/ —— shared 内容（CLAUDE.md / assets）的版本管理走
 * NoDesign 业务层（用户改 CLAUDE.md 直接覆盖；H4 加 audit 再说）。
 *
 * 启动时先调 removeRootLegacyArtifacts 清掉老结构（用户决策"删了"）。
 */
export async function ensureProjectWorkspace(projectId) {
  await removeRootLegacyArtifacts(projectId);

  const shared = getSharedDir(projectId);
  await fs.mkdir(path.join(shared, '.claude', 'skills'), { recursive: true });
  await fs.mkdir(path.join(shared, '.claude', 'agents'), { recursive: true });
  await fs.mkdir(path.join(shared, '.claude', 'agent-memory'), { recursive: true });
  await fs.mkdir(path.join(shared, 'assets'), { recursive: true });
  // 任务模型（2026-07-28）：任务=文件夹=产出的家。agent 按需 mkdir tasks/<名>/
  // 并在其中工作（deck=canvas.html 放任务目录）；会话只是对话通道，与任务解绑
  await fs.mkdir(path.join(shared, 'tasks'), { recursive: true });

  if (!(await fileExists(path.join(shared, '.gitignore')))) {
    await fs.writeFile(path.join(shared, '.gitignore'), DEFAULT_GITIGNORE, 'utf8');
  }
  if (!(await fileExists(path.join(shared, '.claude', 'CLAUDE.md')))) {
    await fs.writeFile(path.join(shared, '.claude', 'CLAUDE.md'), DEFAULT_CLAUDE_MD, 'utf8');
  }
  // settings.json：每次 merge defaults 让代码层 default 升级时现存 project 自动跟上
  // （用户字段优先，缺失的 NoDesign default 字段补进去）
  await mergeSettingsDefaults(path.join(shared, '.claude', 'settings.json'));

  return getProjectWorkspace(projectId);
}

/**
 * 创建 session workspace（幂等）。完成后保证：
 *   - sessions/<sid>/.claude/projects/ 存在（SDK 落 JSONL 处）
 *   - sessions/<sid>/.claude/{CLAUDE.md, settings.json} 文件型软链 → shared（绝对路径）
 *   - sessions/<sid>/{skills, agents, agent-memory} 目录型软链 → shared（绝对路径）
 *   - sessions/<sid>/assets 软链 → shared/assets/（绝对路径）
 *   - sessions/<sid>/.git/ 已 init + empty commit
 *
 * 调用前需先 ensureProjectWorkspace（保证 shared/.claude 子目录存在让软链有效）。
 *
 * @returns {Promise<string>} sessions/<sid>/ 绝对路径
 */
export async function ensureSessionWorkspace(projectId, sessionId) {
  await ensureProjectWorkspace(projectId);

  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  await fs.mkdir(path.join(sessionRoot, '.claude', 'projects'), { recursive: true });

  // ── 软链策略（bwrap 兼容）──
  // bwrap sandbox 会扫 .claude/ 并尝试 bind-mount 各子项；如果碰到目录型 symlink
  // 会报 "Can't create file at .../<name>: Is a directory" 导致整个 sandbox 启动失败。
  // 因此：
  //   1. .claude/ 内只放文件型 symlink（CLAUDE.md / settings.json）
  //   2. 目录型 symlink（skills / agents / agent-memory）放 session root
  //   3. 全部使用绝对路径（bwrap 内相对路径 ../../ 无法遍历未 bind 的中间目录）
  //
  // env NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级 warn（Windows / 部分 docker volume）
  const allowSymlinkFallback = process.env.NODESIGN_ALLOW_SYMLINK_FALLBACK === '1';
  const shared = getSharedDir(projectId);

  // 1) .claude/ 内文件型软链（绝对路径）
  for (const name of CLAUDE_DOT_LINKS) {
    const link = path.join(sessionRoot, '.claude', name);
    if (await pathExists(link)) continue;
    const target = path.join(shared, '.claude', name);  // 绝对路径
    try {
      await fs.symlink(target, link);
    } catch (err) {
      const msg = `symlink failed for .claude/${name} (${err.code || err.message})`;
      if (allowSymlinkFallback) {
        console.warn(`[workspace] ${msg}（降级 warn）`);
      } else {
        throw new Error(`[workspace] ${msg}。设 NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级`);
      }
    }
  }

  // 2) session root 级目录型软链（绝对路径；bwrap 不冲突）
  for (const name of ROOT_DIR_LINKS) {
    const link = path.join(sessionRoot, name);
    if (await pathExists(link)) continue;
    const target = path.join(shared, '.claude', name);  // 绝对路径
    try {
      await fs.symlink(target, link);
    } catch (err) {
      const msg = `symlink failed for ${name} (${err.code || err.message}); agent 写 memory 会丢`;
      if (allowSymlinkFallback) {
        console.warn(`[workspace] ${msg}（降级 warn）`);
      } else {
        throw new Error(`[workspace] ${msg}。设 NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级`);
      }
    }
  }

  // 3) assets 软链（绝对路径）
  const assetsLink = path.join(sessionRoot, 'assets');
  if (!(await pathExists(assetsLink))) {
    const assetsTarget = path.join(shared, 'assets');  // 绝对路径
    try {
      await fs.symlink(assetsTarget, assetsLink);
    } catch (err) {
      const msg = `assets symlink failed (${err.code || err.message}); agent 将看不到 ./assets/`;
      if (allowSymlinkFallback) {
        console.warn(`[workspace] ${msg}（降级 warn）`);
      } else {
        throw new Error(`[workspace] ${msg}。设 NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级`);
      }
    }
  }

  // 3.5) tasks 软链（绝对路径）—— agent 用相对路径 tasks/<名>/ 建任务文件夹并工作
  const tasksLink = path.join(sessionRoot, 'tasks');
  if (!(await pathExists(tasksLink))) {
    const tasksTarget = path.join(shared, 'tasks');
    try {
      await fs.symlink(tasksTarget, tasksLink);
    } catch (err) {
      const msg = `tasks symlink failed (${err.code || err.message}); agent 将看不到 ./tasks/`;
      if (allowSymlinkFallback) {
        console.warn(`[workspace] ${msg}（降级 warn）`);
      } else {
        throw new Error(`[workspace] ${msg}。设 NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级`);
      }
    }
  }

  // per-session .git
  if (!(await fileExists(path.join(sessionRoot, '.git')))) {
    await runGit(sessionRoot, ['init', '-q', '-b', 'main']);
    await runGit(sessionRoot, ['add', '-A']);
    await runGit(sessionRoot, [
      '-c', 'user.email=nodesign@local',
      '-c', 'user.name=NoDesign',
      'commit', '-q', '--allow-empty', '-m', 'init',
    ]);
  }

  return sessionRoot;
}

// ── workspace 主动提醒（C8 SKILL/prelude 改造）──
//
// 给 turn.js composeUserMessage 用 —— 检测 sessionRoot 下 assets/ 软链指向的
// shared/assets/ 是否有内容，有就让 agent 看见 "<system>workspace 里有 N 个文
// 件……" 提示。空目录就不注入，agent 不必每个 turn 都硬 Glob 一遍。
//
// 之前的设计：prelude 强制 agent 首跑前 Glob assets/**/* —— 浪费一次 turn 即便
// 目录是空的。改成 workspace 主动 prepend 提示，把"是否需要看 assets" 这个
// 决策从"agent 必须先做"翻译成"agent 看到提示自己判断"。

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const TEXT_DOC_EXT = new Set(['.md', '.txt', '.json']);
// Office / PDF：二进制或 OOXML zip 包，Read 直接看是字节流，需 python 解
const BINARY_DOC_EXT = new Set(['.pdf', '.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls']);

/**
 * @param {string} sessionRoot - sessions/<sid>/ 绝对路径
 * @returns {Promise<{ count: number, summary: string, hasBinaryDocs: boolean }>}
 *   count=0 时 summary 为空字符串，调用方据此判断是否注入提示。
 *   hasBinaryDocs=true 时调用方追加 python 处理提醒（Read 拿不到这些的内容）。
 */
export async function readAssetsSummary(sessionRoot) {
  try {
    const assetsLink = path.join(sessionRoot, 'assets');
    const stat = await fs.stat(assetsLink).catch(() => null);
    if (!stat) return { count: 0, summary: '', hasBinaryDocs: false };

    const entries = await fs.readdir(assetsLink, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((e) => !e.name.startsWith('.') && (e.isFile() || e.isSymbolicLink()));
    if (files.length === 0) return { count: 0, summary: '', hasBinaryDocs: false };

    const images = [];
    const textDocs = [];
    const binaryDocs = [];
    const others = [];
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) images.push(f.name);
      else if (TEXT_DOC_EXT.has(ext)) textDocs.push(f.name);
      else if (BINARY_DOC_EXT.has(ext)) binaryDocs.push(f.name);
      else others.push(f.name);
    }

    // 摘要：种类 + 头几个文件名（避免太长）
    const parts = [];
    if (images.length > 0) {
      const sample = images.slice(0, 3).join('、');
      parts.push(`${images.length} 张图（${sample}${images.length > 3 ? ` 等` : ''}）`);
    }
    if (textDocs.length > 0) {
      const sample = textDocs.slice(0, 3).join('、');
      parts.push(`${textDocs.length} 个文本文档（${sample}${textDocs.length > 3 ? ` 等` : ''}）`);
    }
    if (binaryDocs.length > 0) {
      const sample = binaryDocs.slice(0, 3).join('、');
      parts.push(`${binaryDocs.length} 个 PDF/Office 文档（${sample}${binaryDocs.length > 3 ? ` 等` : ''}）`);
    }
    if (others.length > 0) {
      parts.push(`${others.length} 个其他文件`);
    }

    // 完整文件清单（按路径列）—— 让 agent 不用再 Glob/LS 探。assets/ 是 symlink
    // → shared/assets/，SDK Glob 走 ripgrep 默认不跟 symlink，agent 调
    // `Glob("assets/*")` 会拿 "No files found" 误判工作区为空（plan mode 还没 Bash
    // 兜底）。把全名列在这条 system 里，agent 直接 Read assets/<name> 即可。
    const allNames = [...images, ...textDocs, ...binaryDocs, ...others];
    return {
      count: files.length,
      summary: `workspace 里已有 ${files.length} 个参考素材：${parts.join('、')}`,
      hasBinaryDocs: binaryDocs.length > 0,
      paths: allNames.map((n) => `assets/${n}`),
    };
  } catch {
    return { count: 0, summary: '', hasBinaryDocs: false, paths: [] };
  }
}

// ── 老结构清理（用户决策"删了"）──

/**
 * 检测 project workspace 根有 canvas.html / spec.json / .git / .claude 这些
 * S1 时代的老 artifacts，且 shared/ 不存在 → 这是老结构 → 全删。
 *
 * 运行一次性，每个 project 第一次进入新代码时清理。idempotent。
 */
export async function removeRootLegacyArtifacts(projectId) {
  const root = getProjectWorkspace(projectId);
  if (!(await fileExists(root))) return;
  if (await fileExists(path.join(root, 'shared'))) return;

  // 只有当老 artifacts 至少一个存在时，认定是老 project
  const legacyTargets = ['canvas.html', 'spec.json', '.git', '.gitignore', '.claude', 'assets'];
  let hadLegacy = false;
  for (const name of legacyTargets) {
    if (await fileExists(path.join(root, name))) { hadLegacy = true; break; }
  }
  if (!hadLegacy) return;

  for (const name of legacyTargets) {
    const p = path.join(root, name);
    if (await fileExists(p)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }
  console.log(`[workspace] removed legacy root artifacts for ${projectId}`);
}

// ── 删除 ──

export async function removeProjectWorkspace(projectId) {
  const root = getProjectWorkspace(projectId);
  await fs.rm(root, { recursive: true, force: true });
}

/** 删 sessions/<sid>/ */
export async function removeSessionWorkspace(projectId, sessionId) {
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  await fs.rm(sessionRoot, { recursive: true, force: true });
}

// ── git ops（per-session）──

/**
 * 在 sessions/<sid>/.git 上 commit working tree。无改动 silent skip。
 */
export async function commitWorkspace(projectId, sessionId, message, { author = 'system' } = {}) {
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  if (!(await fileExists(sessionRoot))) return null;
  // git race guard：用户 PUT canvas（DirectEdit 上行）+ agent Edit canvas.html
  // 同时触发会撞 .git/index.lock，最坏 lock 残留导致后续 commit 全卡死。per-sessionRoot
  // mutex 串行所有 git 写操作（commit / revert）。同 sid 共享 key=`git:${sessionRoot}`。
  return mutex(`git:${sessionRoot}`, async () => {
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(sessionRoot, [
      '-c', `user.email=${author}@nodesign`,
      '-c', `user.name=${author}`,
      'commit', '-q', '-m', message,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

export async function listHistory(projectId, sessionId, { limit = 50 } = {}) {
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  if (!(await fileExists(sessionRoot))) return [];
  const { stdout, code } = await runGit(
    sessionRoot,
    ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%cI%x09%an%x09%s'],
    { capture: true },
  );
  if (code !== 0) return [];
  return stdout
    .trim().split('\n').filter(Boolean)
    .map((line) => {
      const [hash, isoDate, gitAuthor, ...msgParts] = line.split('\t');
      return { hash, date: isoDate, author: gitAuthor, message: msgParts.join('\t') };
    });
}

export async function revertWorkspace(projectId, sessionId, commitHash) {
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    throw Object.assign(new Error(`invalid commit hash: ${commitHash}`), { code: 'INVALID_COMMIT' });
  }
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  // git race guard: 同 commitWorkspace —— checkout + 后续 commit 全 wrap mutex
  // 串行。注意：内层调 commitWorkspace 也会进 mutex，async-mutex-lite 对同 key 同
  // 调用栈会按 prev Promise chain，**不会死锁**（mutex 拿到后释放 prev、await prev
  // 已是 resolved 立即继续）—— 但为简洁还是把 checkout + commit 做成原子段，避免
  // checkout 完别的 commit 抢进来覆盖待 commit 的 staged 状态。
  return mutex(`git:${sessionRoot}`, async () => {
    await runGit(sessionRoot, ['checkout', commitHash, '--', '.']);
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(sessionRoot, [
      '-c', 'user.email=user@nodesign',
      '-c', 'user.name=user',
      'commit', '-q', '-m', `revert to ${commitHash.slice(0, 7)}`,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

// ── fork ──

/**
 * Fork session 时复制产物：cp -r sessions/<srcSid> → sessions/<newSid>，但
 * 跳过 .claude/projects（SDK 自己管 JSONL，新 sid 跟旧 sid 不同 jsonl）。
 *
 * 软链用 verbatim 复制（保留软链结构，相对路径 ../../../shared/<name> 在新
 * 目录下仍指向 shared，无需重建）。
 *
 * .git 一并复制 → newSid 继承 srcSid 完整 history（fork 语义"从这里继续"）。
 */
export async function forkSessionWorkspace(projectId, srcSessionId, newSessionId) {
  validateSessionId(srcSessionId);
  validateSessionId(newSessionId);
  const srcRoot = getSessionWorkspace(projectId, srcSessionId);
  const newRoot = getSessionWorkspace(projectId, newSessionId);

  if (!(await fileExists(srcRoot))) {
    throw Object.assign(new Error(`fork source session not found: ${srcSessionId}`), { code: 'SRC_NOT_FOUND' });
  }
  if (await fileExists(newRoot)) {
    throw Object.assign(new Error(`fork target session already exists: ${newSessionId}`), { code: 'TARGET_EXISTS' });
  }

  // 用 fs.cp recursive + verbatimSymlinks 保留软链结构。
  // filter 跳 .claude/projects（SDK 会写新 sid 的 JSONL 到这里，老 jsonl 别带）
  const skipPathSegment = path.join('.claude', 'projects');
  await fs.cp(srcRoot, newRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(srcRoot, src);
      // 顶层 + 路径不含 .claude/projects 的都复制
      return !rel.startsWith(skipPathSegment);
    },
  });

  // 确保 .claude/projects/ 存在（fs.cp filter 跳掉后没建）
  await fs.mkdir(path.join(newRoot, '.claude', 'projects'), { recursive: true });

  return newRoot;
}

// ── helpers ──

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p) {
  // 区分 fileExists 用于"包括软链 dangling"的检查（lstat 不 follow）
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (capture) resolve({ code, stdout, stderr });
      else if (code === 0) resolve({ code });
      else reject(new Error(`git ${args.join(' ')} failed (code=${code})`));
    });
  });
}
