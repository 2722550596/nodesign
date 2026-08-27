/**
 * subagent-presets.test.js — 4 个子代理 delegatable preset 的回归测试。
 *
 * 生成链：agents/*.md（真相源）→ migrate-agents.mjs → agent-dir/prompt-presets/nd-*.json
 * + agents/schemas/*.json → agent-dir/schemas/*.json（逐字节镜像）。
 *
 * 四组断言：
 *   ① 4 个 preset JSON 结构（delegatable / autoActivate / tools 白名单 / model /
 *      宏兜底策略 / items 单 system block / schemas 接线）；
 *   ② schemas 镜像与源逐字节一致；
 *   ③ nodesign.json 的子代理段落已迁 pi subagent 语法（4 个 profileId 在、
 *      SDK 派遣语法与 M2-待改 注释不在）；
 *   ④ 生成物新鲜度（重跑 transform 与盘上文件逐字节对账 —— 防改 md 忘跑脚本，
 *      做法对齐 prelude-render.test.js ③）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENTS, SCHEMAS, transformAgent, buildPreset, serializePreset } from '../agents/migrate-agents.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENTS_DIR = __dirname + '../agents/';
const PRESETS_DIR = __dirname + 'agent-dir/prompt-presets/';
const SCHEMA_SRC_DIR = AGENTS_DIR + 'schemas/';
const SCHEMA_DEST_DIR = __dirname + 'agent-dir/schemas/';

const PRESETS = Object.fromEntries(AGENTS.map((spec) => [
  spec.id,
  JSON.parse(readFileSync(PRESETS_DIR + spec.id + '.json', 'utf8')),
]));

/** 写类 / 副作用工具 —— 子代理白名单里一个都不该出现（禁写/bash 的硬钉子）。 */
const FORBIDDEN_TOOLS = [
  'bash', 'write', 'edit',
  'export_handoff', 'publish_site', 'build_docx', 'write_on_board',
  'generate_image', 'remove_background',
  'navigate_to_page', 'highlight', 'preview_deck',
  'get_pending_changes', 'clear_pending_changes',
];

describe('① 4 个子代理 preset 结构', () => {
  it('delegatable:true + autoActivate:false + id 唯一且与文件名一致', () => {
    const ids = Object.keys(PRESETS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['nd-ds-extractor', 'nd-explorer', 'nd-tweak-proposer', 'nd-vision-checker']);
    for (const spec of AGENTS) {
      const p = PRESETS[spec.id];
      expect(p.schemaVersion).toBe(1);
      expect(p.type).toBe('pi-forge.prompt-preset');
      // delegatable:true 才进 subagent_profiles 列表（extension.ts:34-68）
      expect(p.delegatable, `${spec.id} 缺 delegatable`).toBe(true);
      // 子代理 preset 绝不能被选成主会话默认（loader.ts chooseDefaultPreset）
      expect(p.autoActivate, `${spec.id} 不能 autoActivate`).toBe(false);
    }
  });

  it('tools 是 allow 白名单：禁写/bash，且与规格表一致', () => {
    for (const spec of AGENTS) {
      const p = PRESETS[spec.id];
      expect(p.tools?.allow, `${spec.id} 缺 tools.allow`).toEqual(spec.tools);
      expect(p.tools.deny).toBeUndefined();
      for (const bad of FORBIDDEN_TOOLS) {
        expect(p.tools.allow, `${spec.id} 白名单混入「${bad}」`).not.toContain(bad);
      }
    }
  });

  it('model 显式钉 gmi/MiniMaxAI/MiniMax-M3（缺省会落 availableModels[0]，prepare.ts:140-144）', () => {
    for (const spec of AGENTS) {
      expect(PRESETS[spec.id].model).toBe('gmi/MiniMaxAI/MiniMax-M3');
    }
  });

  it('宏兜底策略 warn（error 会让子代理 preparation 失败，prepare.ts:216-226）', () => {
    for (const spec of AGENTS) {
      expect(PRESETS[spec.id].defaults.unresolvedMacroPolicy).toBe('warn');
    }
  });

  it('items = 单个 system block，content 是 md 逐字产物，无 {{ / SDK 残留', () => {
    for (const spec of AGENTS) {
      const p = PRESETS[spec.id];
      expect(p.items.length).toBe(1);
      const block = p.items[0];
      expect(block.kind).toBe('block');
      expect(block.role).toBe('system');
      expect(block.enabled).toBe(true);
      const md = readFileSync(AGENTS_DIR + spec.md, 'utf8');
      expect(block.content).toBe(transformAgent(md));
      expect(block.content).not.toContain('{{');
      expect(block.content).not.toContain('mcp__nodesign__');
    }
  });

  it('schemas 接线：ds-extractor / tweak-proposer 有，explorer / vision-checker 无', () => {
    expect(PRESETS['nd-ds-extractor'].schemas).toEqual(['design-system']);
    expect(PRESETS['nd-tweak-proposer'].schemas).toEqual(['tweak-schema']);
    expect(PRESETS['nd-explorer'].schemas).toBeUndefined();
    expect(PRESETS['nd-vision-checker'].schemas).toBeUndefined();
  });
});

describe('② schemas 镜像（preset.schemas 从 join(agentDir,"schemas") 解析，schema-loader.ts:32-34）', () => {
  it('agent-dir/schemas/ 与 agents/schemas/ 逐字节一致', () => {
    for (const { file } of SCHEMAS) {
      expect(readFileSync(SCHEMA_DEST_DIR + file)).toEqual(readFileSync(SCHEMA_SRC_DIR + file));
    }
  });
});

describe('③ nodesign.json 子代理段落（迁 pi subagent 语法）', () => {
  const preset = JSON.parse(readFileSync(PRESETS_DIR + 'nodesign.json', 'utf8'));
  const content = preset.items.find((i) => i.id === 'nodesign-prelude').content;

  it('新派遣语法 + 4 个 profileId 在', () => {
    expect(content).toContain('subagent { profileId, task }');
    for (const id of ['nd-explorer', 'nd-vision-checker', 'nd-ds-extractor', 'nd-tweak-proposer']) {
      expect(content, `子代理段落缺 ${id}`).toContain(id);
    }
  });

  it('SDK 派遣语法与待改注释已清', () => {
    expect(content).not.toContain('run_in_background');
    expect(content).not.toContain('Task(subagent_type');
    expect(content).not.toContain('explorer 已停用');
    expect(content).not.toContain('{{//M2-待改: 子代理将迁');
  });
});

describe('④ 生成物新鲜度（防改 md 忘跑脚本）', () => {
  it('重跑 transform 与盘上 4 个 preset JSON 逐字节一致', () => {
    for (const spec of AGENTS) {
      const md = readFileSync(AGENTS_DIR + spec.md, 'utf8');
      const expected = serializePreset(buildPreset(spec, transformAgent(md)));
      expect(expected, `${spec.id}.json 过期：改 md 后跑 node server/engine/agents/migrate-agents.mjs`)
        .toBe(readFileSync(PRESETS_DIR + spec.id + '.json', 'utf8'));
    }
  });
});
