/**
 * server/projects/project-config.js — 项目级 agent 配置（nodesign.config.json）。
 *
 * 文件：<项目工作区根>/nodesign.config.json（与 CLAUDE.md 并列 —— 画布可见、随项目
 * git 走、任何能写工作区的人都能改，跟 CLAUDE.md 同一信任域）。
 *
 *   {
 *     "$schema": "…",                    // 可选，编辑器提示用
 *     "prompt": {
 *       "append": "…",                   // 追加到 prelude 之后的项目专属指导（utf8 ≤ 64KB）
 *       "sdkPreset": "keep" | "replace", // replace = 整份替换 SDK 内置 claude_code preset
 *       "claudeMd": "keep" | "off",      // off = 项目 CLAUDE.md 不进上下文（仅排 CLAUDE.md，
 *                                        //        settings.json / autoCompact 照常）
 *       "prelude": {
 *         "mode": "global" | "project",  // 必填。global（默认）= 平台 prelude；project = 换成下面给的
 *         "content": "…",                // mode=project 时：内联全文（与 file 二选一）
 *         "file": "prelude.md"           // mode=project 时：工作区根内的 .md 文件名（与 content 二选一）
 *       }
 *     },
 *     "tools": {
 *       "disable": ["Bash", "mcp__nodesign__publish_site", "mcp__nodesign__browser_*"],
 *       "preload": ["mcp__nodesign__generate_image", "web_search"]  // 直接挂载：命中项 schema 常驻，免 ToolSearch
 *     },
 *     "skills": { "enabled": false }     // false = 无 skill catalog、无 Skill 工具
 *   }
 *
 * skills.enabled=false 的语义：SDK 的 plugins+skills 两路 catalog 都置空、'Skill'
 * 工具从可见集摘掉 —— agent 不再有任何技能协议入口；plugin 目录资源仍可 Read
 * （additionalDirectories 保留），但那只是文件访问。
 *
 * ⚠️ prelude 覆盖的语义（2026-08-26 用户拍板）：mode=project 时，平台 prelude 里的
 * 路径地图 / 工作流硬规则 / 产物政策块（nd:policy:full|min）与成人段档位联动**全部不注入**
 * —— 内容由项目作者全权负责。这是「平台强制、用户不可覆盖」那条线的唯一例外，
 * session-loop 装配处打了日志。
 *
 * tools.disable 是**收紧类**（跟 local-config 哲学一致的方向）：命中项整件不注册、
 * 连名字都不进模型上下文。支持两种写法：精确工具名（内置工具 'Bash' / MCP
 * 'mcp__nodesign__publish_site'）或尾缀 `*` 前缀通配（'mcp__nodesign__browser_*'）。
 * 内置工具写**裸名**（模型看到的样子）；MCP 工具写带 `mcp__nodesign__` 前缀的
 * **全名**（模型看到的样子），裸名简写（'publish_site'）也认。
 * 外部 MCP server（站主 .env 的 NODESIGN_MCP_SERVERS）按 **server 粒度**禁用：
 * 禁 `mcp__<server名>`（如 'mcp__nocturne_memory'）或前缀通配（'mcp__nocturne_*'、
 * 'mcp__*'）→ 整台 server 从模型可见集摘掉，连工具名都不进上下文。粒度只到
 * server：外部 server 是 SDK 子进程 client 整组连接的，工具由远端枚举，我们没有
 * 逐工具注册点（mcp__nodesign__* 是 in-process 才做得到逐件过滤）。
 * 站主 env 仍是「这台机器连哪些服务」的根白名单，项目配置在其上**收紧**。
 *
 * 读取哲学（跟 local-config.js 同一条线）：文件缺失 = 默认配置；JSON 坏 / 字段越界 =
 * 一条警告、整份落默认 —— 一个逗号不能把会话初始化拉下来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getWorkspaceRoot } from './workspace.js';

export const PROJECT_CONFIG_NAME = 'nodesign.config.json';
/** 与 CLAUDE.md 同量级（instruction.js 那条 64KB 线） */
export const APPEND_MAX_BYTES = 64 * 1024;
export const PRELUDE_MAX_BYTES = 64 * 1024;
export const DISABLE_MAX = 100;
const TOOL_NAME_MAX = 128;
const FILE_NAME_MAX = 256;

const utf8Len = (s) => Buffer.byteLength(s, 'utf8');

const PreludeSchema = z.object({
  mode: z.enum(['global', 'project']),
  content: z.string().refine((s) => utf8Len(s) <= PRELUDE_MAX_BYTES, `content 超 ${PRELUDE_MAX_BYTES} 字节`).optional(),
  file: z.string().trim().min(1).max(FILE_NAME_MAX).optional(),
}).strict()
  // content 与 file 二选一；mode=global 时两者都不得出现（意图必须显式）
  .refine((v) => !(v.content !== undefined && v.file !== undefined), 'content 与 file 只能二选一')
  .refine((v) => !(v.mode === 'global' && (v.content !== undefined || v.file !== undefined)), 'mode=global 时不能带 content/file（想覆盖就写 mode=project）');

const PromptSchema = z.object({
  append: z.string().refine((s) => utf8Len(s) <= APPEND_MAX_BYTES, `append 超 ${APPEND_MAX_BYTES} 字节`).default(''),
  prelude: PreludeSchema.default({ mode: 'global' }),
  /**
   * keep（默认）  = systemPrompt 用 SDK preset 'claude_code' + append（平台现状）
   * replace       = systemPrompt 整份换成我们的文本（prelude + append），SDK 那 27.7KB
   *                 preset 不注入。实测残留（SDK 2.1.237）：顶层 160B 计费头+身份行 +
   *                 messages[1] 10.9KB 动态提醒段（agent 注册表/skill 目录/token 预算），
   *                 后者不走 systemPrompt 字段，需配合 ingress 剥除（stripResidue 标志）。
   */
  sdkPreset: z.enum(['keep', 'replace']).default('keep'),
  /**
   * keep（默认）  = 项目 CLAUDE.md（项目档案）随 settingSources 进上下文
   * off           = 经 SDK 的 claudeMdExcludes 精确排除（按绝对路径），仅 CLAUDE.md
   *                 记忆不加载；项目 settings.json / autoCompact 等照常读。
   */
  claudeMd: z.enum(['keep', 'off']).default('keep'),
}).strict();

const ToolsSchema = z.object({
  // disable 数组宽容处理：空/纯空白条目在 trim 后**整条丢弃**，而不是废掉整份配置。
  // 2026-08-26 实战事故：手改配置误留一个 "" 空串 → 校验失败 → 整份落默认 →
  // sdkPreset 变回 keep、Task/Skill 全回来（看起来像"剥除失效"，其实是配置没生效）。
  // 空工具名没有任何合理语义，丢掉的代价为零，救回整份配置的收益是实打实的。
  disable: z.array(z.string().max(TOOL_NAME_MAX))
    .transform((arr) => arr.map((s) => s.trim()).filter((s) => s.length > 0))
    .refine((arr) => arr.length <= DISABLE_MAX, `disable 条目数（去空后）超 ${DISABLE_MAX}`)
    .default([]),
  // 直接挂载清单：命中的 mcp__nodesign__* 工具跳过 ToolSearch 延迟加载，schema
  // 随第一 turn 常驻（跟 ALWAYS_LOAD_TOOLS 同待遇）。匹配语义与 disable 相同：
  // 精确名或尾缀 `*` 通配，全名/裸名都认。禁用优先于挂载（disable 命中的工具
  // 先被摘掉，挂载列表不复活它）。空条目同样丢弃（同一个事故教训）。
  preload: z.array(z.string().max(TOOL_NAME_MAX))
    .transform((arr) => arr.map((s) => s.trim()).filter((s) => s.length > 0))
    .refine((arr) => arr.length <= DISABLE_MAX, `preload 条目数（去空后）超 ${DISABLE_MAX}`)
    .default([]),
}).strict();

const SkillsSchema = z.object({
  /** false = 整站技能协议关掉：无 skill catalog、无 Skill 工具（session-loop 装配时剥） */
  enabled: z.boolean().default(true),
}).strict();

// ⚠️ `.default()` 的值是**原样透传**不经内层 schema —— 必须给全量默认形状，
// 给 `{}` 会让 prompt 变成空对象、内层 append/prelude 默认不生效（实测踩过）。
export const ProjectConfigSchema = z.object({
  $schema: z.string().max(512).optional(),
  prompt: PromptSchema.default({ append: '', prelude: { mode: 'global' }, sdkPreset: 'keep', claudeMd: 'keep' }),
  tools: ToolsSchema.default({ disable: [], preload: [] }),
  skills: SkillsSchema.default({ enabled: true }),
}).strict();

export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  prompt: Object.freeze({ append: '', prelude: Object.freeze({ mode: 'global' }), sdkPreset: 'keep', claudeMd: 'keep' }),
  tools: Object.freeze({ disable: Object.freeze([]), preload: Object.freeze([]) }),
  skills: Object.freeze({ enabled: true }),
});

function issueText(issue) {
  return `${issue.path.join('.') || '(根)'}: ${issue.message}`;
}

/**
 * 纯校验 + 归一化。不读文件。坏输入 → 整份默认 + errors（不抛）。
 * @returns {{ config: object, errors: string[] }}
 */
export function validateProjectConfig(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: DEFAULT_PROJECT_CONFIG, errors: ['(根): 必须是 JSON 对象'] };
  }
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { config: DEFAULT_PROJECT_CONFIG, errors: parsed.error.issues.map(issueText) };
  }
  return { config: parsed.data, errors: [] };
}

/**
 * 从工作区根读配置。文件缺失 / 坏 JSON / 越界 → 默认配置（打警告，不抛）。
 * @param {string} [root] 项目工作区绝对路径；null/undefined → 默认（探针/测试路径）
 * @returns {Promise<{ config: object, errors: string[] }>}
 */
export async function loadProjectConfig(root) {
  if (!root) return { config: DEFAULT_PROJECT_CONFIG, errors: [] };
  const filePath = path.join(root, PROJECT_CONFIG_NAME);
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { config: DEFAULT_PROJECT_CONFIG, errors: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[project-config] ${filePath} JSON 解析失败（${err.message}）→ 整份落默认`);
    return { config: DEFAULT_PROJECT_CONFIG, errors: [`JSON 解析失败: ${err.message}`] };
  }
  const { config, errors } = validateProjectConfig(parsed);
  if (errors.length) {
    // 后果要打出来：落默认 = 工具不过滤 / skill 不关闭 / 提示词回退全局 /
    // sdkPreset 回退 keep —— 用户以为"剥除失效"时先看这里。
    console.error(`[project-config] ${filePath} 校验失败（${errors.length} 条：${errors.join('；')}）→ 整份落默认，项目配置全部失效`);
  }
  return { config, errors };
}

/** 按 projectId 取工作区根再读（API 层用；session-loop 已有根，直接走 loadProjectConfig） */
export function loadProjectConfigForProject(projectId) {
  return loadProjectConfig(getWorkspaceRoot(projectId));
}

// ── tools.disable 匹配 ──

/**
 * 通用工具名匹配：精确名，或尾缀 `*` 前缀通配。带 `prefix`（MCP 命名空间，
 * 如 'mcp__nodesign__'）时两个写法都认：裸名与带前缀全名。
 * disable / preload 两处配置共用这份匹配语义。
 * @param {string} toolName
 * @param {string[]} entries
 * @param {string} [prefix]
 */
export function toolNameMatches(toolName, entries, prefix = '') {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const names = prefix ? [toolName, prefix + toolName] : [toolName];
  for (const entry of entries) {
    for (const n of names) {
      if (entry.endsWith('*') ? n.startsWith(entry.slice(0, -1)) : n === entry) return true;
    }
  }
  return false;
}

/**
 * 工具名是否被 disable 命中（别名：语义 = toolNameMatches）。
 * @param {string} toolName
 * @param {string[]} disable
 * @param {string} [prefix]
 */
export function isToolDisabled(toolName, disable, prefix = '') {
  return toolNameMatches(toolName, disable, prefix);
}

/**
 * 过滤工具列表。disable 为空时返回**原数组引用**（不产生新分配）。
 * @param {string[]} list
 * @param {string[]} disable
 */
export function filterTools(list, disable) {
  if (!Array.isArray(disable) || disable.length === 0) return list;
  return list.filter((t) => !isToolDisabled(t, disable));
}

/**
 * 过滤外部 MCP server 集合（外部 McpServerConfig 展开，见 engine/mcp/external.js）。
 * 按 server 粒度匹配：`mcp__<名字>` 精确，或尾缀 `*` 前缀通配。命中 → 整台 server
 * 摘掉（SDK 子进程 client 整组连接，没有逐工具注册点）。disable 为空 → 原引用。
 * @param {Record<string, object>} servers 名字 → McpServerConfig
 * @param {string[]} disable
 * @returns {Record<string, object>}
 */
export function filterMcpServers(servers, disable) {
  if (!Array.isArray(disable) || disable.length === 0) return servers;
  const out = {};
  let changed = false;
  for (const [name, spec] of Object.entries(servers)) {
    if (isToolDisabled(`mcp__${name}`, disable)) {
      changed = true;   // 命中：整台 server 不进模型可见集
      continue;
    }
    out[name] = spec;
  }
  return changed ? out : servers;
}

/**
 * 外部 MCP server 直接挂载（tools.preload，server 粒度）：命中 → 给 McpServerConfig
 * 加 `alwaysLoad: true`（SDK d.ts:1071 McpSSEServerConfig.alwaysLoad —— "always
 * include all tools from this server in the context window"），整台 server 的工具
 * 跳过 ToolSearch 常驻。匹配语义同 disable：`mcp__<名字>` 精确 / 尾缀 `*` 通配。
 * 粒度只到 server：外部 server 没有逐工具同步点（per-tool 常驻要 in-process 代理，
 * 见模块头）。未命中 → 原引用；命中 → 返回新集合，不污染 externalMcpServers 缓存。
 * @param {Record<string, object>} servers
 * @param {string[]} preload
 * @returns {Record<string, object>}
 */
export function applyMcpServerPreload(servers, preload) {
  if (!Array.isArray(preload) || preload.length === 0) return servers;
  let out = servers;
  let changed = false;
  for (const [name, spec] of Object.entries(servers)) {
    if (toolNameMatches(`mcp__${name}`, preload)) {
      out = changed ? out : { ...servers };
      out[name] = { ...spec, alwaysLoad: true };
      changed = true;
    }
  }
  return out;
}

// ── prelude 覆盖 ──

/** prelude.file 只允许工作区根内的单层 .md 文件名（禁路径分隔，防越界读） */
const PRELUDE_FILE_RE = /^[^/\\]+\.md$/i;

/**
 * mode=project 时取项目 prelude 全文（content 内联或 file 读文件）；
 * mode=global / 文件缺失 / 路径越界 → null（调用方回落全局 prelude）。
 * 越界或读失败只打警告，绝不把会话初始化拉下来。
 * @param {object} config validateProjectConfig 的输出
 * @param {string} [root] 工作区根（file 模式解析用）
 * @returns {Promise<string|null>}
 */
export async function resolveProjectPreludeContent(config, root) {
  const p = config?.prompt?.prelude;
  if (!p || p.mode !== 'project') return null;
  if (p.file !== undefined) {
    if (!root || !PRELUDE_FILE_RE.test(p.file)) {
      console.warn(`[project-config] prelude.file 必须是工作区根内的 .md 文件名（拿到 ${JSON.stringify(p.file)}）→ 回落全局 prelude`);
      return null;
    }
    const filePath = path.join(root, p.file);
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      console.warn(`[project-config] 读 ${filePath} 失败（${err.message}）→ 回落全局 prelude`);
      return null;
    }
  }
  return p.content ?? null;
}
