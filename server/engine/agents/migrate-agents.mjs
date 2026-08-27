#!/usr/bin/env node
/**
 * server/engine/agents/migrate-agents.mjs — 生成脚本：
 * agents/*.md（4 个子代理提示词，真相源）→ agent-dir/prompt-presets/nd-*.json
 * （pi delegatable presets，commit 进仓库的生成物）+ 把 agents/schemas/ 两个
 * JSON Schema 镜像到 agent-dir/schemas/（pi 的 preset.schemas 从
 * join(agentDir,"schemas") 解析，schema-loader.ts:32-34）。
 *
 * 子代理机制（pi-rp 源码核实）：
 *  - preset 加 delegatable:true 即进 subagent_profiles 列表（subagent/extension.ts:34-68）；
 *    主 agent 经 subagent 工具 { profileId, task } 委派（extension.ts:70-141）。
 *  - 子代理会话 = 进程内 in-memory AgentSession，task 追加为最后一条 user 消息
 *    （prepare.ts:228-234）；inheritHistory 缺省 0 → 不继承父会话历史
 *    （prepare.ts:173），所以 items 只需一个 system block，不需要 chat-history 槽。
 *  - 子代理默认工具 = ["read","grep","find","ls","bash"] + 父会话全部扩展工具
 *    （prepare.ts:166-168，inheritExtensionTools 默认 true）—— 含 ~54 件 MCP 工具
 *    里的写类（export_handoff / publish_site / write_on_board…）。preset tools
 *    策略用 allow 白名单收窄（policy.ts:9-11 对 active 基线做过滤，
 *    agent-session.ts:1557-1567），白名单外的 bash / write / edit / 写类 MCP
 *    工具一律不可用。
 *  - model：subagent 工具不传 model/modelRef（extension.ts:106-112），缺省
 *    preset.model 会落 availableModels[0]（prepare.ts:140-144）而非父会话当前
 *    模型 —— 显式钉 gmi/MiniMaxAI/MiniMax-M3（canonical `${provider}/${id}`，
 *    model-resolver.ts:98-103；providers-models.json 的 gmi 档）。
 *  - unresolvedMacroPolicy:'warn'：子代理 preparation 把 error 级诊断当失败
 *    （prepare.ts:216-226），md 已断言无 {{}} 序列，warn 兜底不吞异常。
 *  - autoActivate:false：子代理 preset 绝不能被选成主会话默认 preset
 *    （loader.ts chooseDefaultPreset：preferredId > autoActivate:true > 首个
 *    autoActivate!==false）。
 *
 * **改子代理提示词改 md，再跑 `node server/engine/agents/migrate-agents.mjs` 重新生成。**
 * subagent-presets.test.js 有生成物新鲜度断言：改 md 忘跑脚本会让测试红。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const AGENTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const PRESETS_DIR = fileURLToPath(new URL('../pi/agent-dir/prompt-presets/', import.meta.url));
const SCHEMA_SRC_DIR = fileURLToPath(new URL('./schemas/', import.meta.url));
const SCHEMA_DEST_DIR = fileURLToPath(new URL('../pi/agent-dir/schemas/', import.meta.url));

/**
 * 4 个子代理的规格表。md 是真相源；tools 是 allow 白名单（pi 内建裸名 +
 * MCP 裸名，toolPrefix:'none'，见 pi/mcp-config.js）。
 *
 * tools 取值理由（每个都是"只读侦察"的最小集）：
 *  - explorer：web_search + screenshot_url（搜索 / 外站截图 / hotlink 验证）
 *    + read/grep/find（本地 assets / spec.json）
 *  - vision-checker：screenshot_canvas + list_pages（产物截图逐页评审）+ read（brief / notes）
 *  - ds-extractor / tweak-proposer：只 read（纯 markup 分析，md 里写明 no screenshots）
 */
export const AGENTS = [
  {
    id: 'nd-explorer',
    name: 'Nodesign Explorer',
    md: 'explorer.md',
    description: '研究员子代理：web_search / screenshot_url 找外部素材、参考、事实验证，回结构化研究报告',
    tools: ['read', 'grep', 'find', 'web_search', 'screenshot_url'],
  },
  {
    id: 'nd-vision-checker',
    name: 'Nodesign Vision Checker',
    md: 'vision-checker.md',
    description: '视觉评审子代理：screenshot_canvas 逐页截图对照，回结构化 VERDICT/ISSUES critique',
    tools: ['read', 'screenshot_canvas', 'list_pages'],
  },
  {
    id: 'nd-ds-extractor',
    name: 'Nodesign Design System Extractor',
    md: 'ds-extractor.md',
    description: '设计系统抽取子代理：读 canvas.html 出 Design System JSON（配 schemas/design-system）',
    tools: ['read'],
    schemas: ['design-system'],
  },
  {
    id: 'nd-tweak-proposer',
    name: 'Nodesign Tweak Proposer',
    md: 'tweak-proposer.md',
    description: '微调提案子代理：读 canvas.html 出 tweak schema JSON（配 schemas/tweak-schema）',
    tools: ['read'],
    schemas: ['tweak-schema'],
  },
];

/** schemas 镜像清单：agents/schemas/<file> → agent-dir/schemas/<file>（逐字节）。 */
export const SCHEMAS = [
  { file: 'design-system.json' },
  { file: 'tweak-schema.json' },
];

/** SDK 时代残留词 —— md 已迁 pi 原生，出现即断言失败（防回退）。 */
const SDK_LEFTOVERS = [
  'mcp__nodesign__', 'WebFetch', 'TaskCreate', 'TodoWrite', 'AskUserQuestion',
  'run_in_background', 'Task(subagent_type',
];

/**
 * md 原文 → preset block content。CRLF 归一 + trim，其余逐字。
 * 纯函数：测试用它重算生成物做新鲜度对账。
 *
 * @param {string} raw md 原文
 * @returns {string}
 */
export function transformAgent(raw) {
  const content = raw.replace(/\r\n?/g, '\n').trim();
  assert.ok(!content.includes('{{'), '[migrate-agents] md 含 {{ 序列，会被 pi 宏引擎扫（未知宏原样留、{{//...}} 被删）');
  for (const token of SDK_LEFTOVERS) {
    assert.ok(!content.includes(token), `[migrate-agents] md 仍含 SDK 残留「${token}」`);
  }
  return content;
}

/**
 * preset 文档本体（transformAgent 产物 → nd-*.json）。
 * 形状对齐 nodesign.json（schemaVersion/type/items block），子代理差异：
 * delegatable:true、autoActivate:false、tools allow 白名单、无 slot 栈。
 */
export function buildPreset(spec, content) {
  const preset = {
    schemaVersion: 1,
    type: 'pi-forge.prompt-preset',
    id: spec.id,
    name: spec.name,
    description: spec.description,
    autoActivate: false,
    delegatable: true,
    model: 'gmi/MiniMaxAI/MiniMax-M3',
    defaults: { unresolvedMacroPolicy: 'warn' },
    tools: { allow: [...spec.tools] },
  };
  if (spec.schemas) preset.schemas = [...spec.schemas];
  preset.items = [
    { kind: 'block', id: `${spec.id}-prompt`, name: spec.name, enabled: true, role: 'system', content },
  ];
  return preset;
}

/** 序列化（测试用它和盘上文件对账，格式必须与写盘一致）。 */
export function serializePreset(preset) {
  return JSON.stringify(preset, null, 2) + '\n';
}

// ── 主流程（仅直接执行时跑；被测试 import 时不触发）──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  mkdirSync(PRESETS_DIR, { recursive: true });
  mkdirSync(SCHEMA_DEST_DIR, { recursive: true });

  const ids = new Set();
  for (const spec of AGENTS) {
    assert.ok(!ids.has(spec.id), `[migrate-agents] preset id 重复：${spec.id}`);
    ids.add(spec.id);

    const raw = readFileSync(AGENTS_DIR + spec.md, 'utf8');
    const content = transformAgent(raw);
    const out = PRESETS_DIR + spec.id + '.json';
    writeFileSync(out, serializePreset(buildPreset(spec, content)));
    console.log(`${spec.md} → ${out}（tools: ${spec.tools.join(', ')}${spec.schemas ? `；schemas: ${spec.schemas.join(', ')}` : ''}）`);
  }

  for (const { file } of SCHEMAS) {
    const bytes = readFileSync(SCHEMA_SRC_DIR + file);
    writeFileSync(SCHEMA_DEST_DIR + file, bytes);
    console.log(`schemas/${file} → ${SCHEMA_DEST_DIR}${file}（逐字节镜像）`);
  }

  console.log(`完成：${AGENTS.length} 个 delegatable preset + ${SCHEMAS.length} 个 schema 镜像`);
}
