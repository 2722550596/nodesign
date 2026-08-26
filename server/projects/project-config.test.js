/**
 * server/projects/project-config.js 的校验钉子：schema 归一化 / 坏输入落默认 /
 * tools.disable 匹配（精确 + 前缀通配）/ prelude 覆盖取文（content 内联、file 读文件、
 * 越界与缺失回落 null）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateProjectConfig, loadProjectConfig, isToolDisabled, toolNameMatches,
  filterTools, filterMcpServers, applyMcpServerPreload, resolveProjectPreludeContent,
  PROJECT_CONFIG_NAME, DEFAULT_PROJECT_CONFIG,
} from './project-config.js';

const GOOD = {
  $schema: 'https://example.com/nodesign.project.json',
  prompt: {
    append: '本项目专注书法风长页。',
    prelude: { mode: 'project', content: '你是本站主，按站规办事。' },
  },
  tools: { disable: ['Bash', 'mcp__nodesign__publish_site', 'mcp__nodesign__browser_*'] },
};

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), 'nd-projcfg-'));
}

describe('validateProjectConfig', () => {
  it('好配置：归一化默认值（prelude mode、append、disable）', () => {
    const v = validateProjectConfig(GOOD);
    expect(v.errors).toEqual([]);
    expect(v.config.prompt.append).toBe('本项目专注书法风长页。');
    expect(v.config.prompt.prelude).toEqual({ mode: 'project', content: '你是本站主，按站规办事。' });
    expect(v.config.tools.disable).toEqual(['Bash', 'mcp__nodesign__publish_site', 'mcp__nodesign__browser_*']);
  });

  it('缺字段落默认：prelude 省略 → global；append / disable 空；skills 默认开', () => {
    const v = validateProjectConfig({});
    expect(v.errors).toEqual([]);
    expect(v.config).toEqual(DEFAULT_PROJECT_CONFIG);
    expect(v.config.prompt.prelude.mode).toBe('global');
    expect(v.config.skills.enabled).toBe(true);
  });

  it('skills.enabled=false 合法：关掉技能协议', () => {
    const v = validateProjectConfig({ skills: { enabled: false } });
    expect(v.errors).toEqual([]);
    expect(v.config.skills).toEqual({ enabled: false });
  });

  it('sdkPreset 默认 keep；replace 合法；别的值拒绝', () => {
    expect(validateProjectConfig({}).config.prompt.sdkPreset).toBe('keep');
    const ok = validateProjectConfig({ prompt: { sdkPreset: 'replace' } });
    expect(ok.errors).toEqual([]);
    expect(ok.config.prompt.sdkPreset).toBe('replace');
    const bad = validateProjectConfig({ prompt: { sdkPreset: 'nuke' } });
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.config).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('claudeMd 默认 keep；off 合法；别的值拒绝', () => {
    expect(validateProjectConfig({}).config.prompt.claudeMd).toBe('keep');
    const ok = validateProjectConfig({ prompt: { claudeMd: 'off' } });
    expect(ok.errors).toEqual([]);
    expect(ok.config.prompt.claudeMd).toBe('off');
    const bad = validateProjectConfig({ prompt: { claudeMd: 'hide' } });
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.config).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('skills 未知键（strict）→ 错', () => {
    const v = validateProjectConfig({ skills: { magic: 1 } });
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('未知键（strict）→ 整份默认 + errors，不抛', () => {
    const v = validateProjectConfig({ tools: { disable: [] }, magic: 1 });
    expect(v.errors.length).toBeGreaterThan(0);
    expect(v.config).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('不是对象 → 一条错、默认配置', () => {
    for (const bad of [null, 'x', 42, []]) {
      const v = validateProjectConfig(bad);
      expect(v.errors.length).toBeGreaterThan(0);
      expect(v.config).toEqual(DEFAULT_PROJECT_CONFIG);
    }
  });

  it('mode=global 却带 content → 错（覆盖意图必须显式 mode=project）', () => {
    const v = validateProjectConfig({ prompt: { prelude: { mode: 'global', content: 'x' } } });
    expect(v.errors.some((e) => e.includes('mode=global'))).toBe(true);
  });

  it('content 与 file 同给 → 错', () => {
    const v = validateProjectConfig({ prompt: { prelude: { mode: 'project', content: 'x', file: 'p.md' } } });
    expect(v.errors.some((e) => e.includes('二选一'))).toBe(true);
  });

  it('超长 append（> 64KB bytes）→ 错', () => {
    const v = validateProjectConfig({ prompt: { append: '字'.repeat(22_000) } });  // 22k 个 CJK ≈ 66KB
    expect(v.errors.some((e) => e.includes('append 超'))).toBe(true);
  });

  it('disable 数组含空串/纯空白条目 → 丢弃、不废配置、其余生效（2026-08-26 事故回归）', () => {
    const v = validateProjectConfig({
      prompt: { sdkPreset: 'replace' },
      tools: { disable: ['Task', '', '   ', 'mcp__nodesign__publish_site'] },
    });
    expect(v.errors).toEqual([]);
    expect(v.config.tools.disable).toEqual(['Task', 'mcp__nodesign__publish_site']);
    expect(v.config.prompt.sdkPreset).toBe('replace');
  });

  it('disable 数量超上限（> 100）→ 错', () => {
    const v = validateProjectConfig({ tools: { disable: Array.from({ length: 101 }, (_, i) => `t${i}`) } });
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('preload 默认空数组；挂载清单可解析；空条目丢弃；超上限拒绝', () => {
    expect(validateProjectConfig({}).config.tools.preload).toEqual([]);
    const ok = validateProjectConfig({ tools: { preload: ['mcp__nodesign__read_board', 'browser_*', ''] } });
    expect(ok.errors).toEqual([]);
    expect(ok.config.tools.preload).toEqual(['mcp__nodesign__read_board', 'browser_*']);
    const bad = validateProjectConfig({ tools: { preload: Array.from({ length: 101 }, (_, i) => `p${i}`) } });
    expect(bad.errors.length).toBeGreaterThan(0);
  });
});

describe('loadProjectConfig', () => {
  it('文件缺失 → 默认配置，不炸', async () => {
    const root = tmpRoot();
    try {
      const { config, errors } = await loadProjectConfig(root);
      expect(config).toEqual(DEFAULT_PROJECT_CONFIG);
      expect(errors).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('null 根（探针/测试路径）→ 默认', async () => {
    const { config } = await loadProjectConfig(null);
    expect(config).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('坏 JSON → 警告 + 默认', async () => {
    const root = tmpRoot();
    try {
      writeFileSync(path.join(root, PROJECT_CONFIG_NAME), '{ oops', 'utf8');
      const { config, errors } = await loadProjectConfig(root);
      expect(config).toEqual(DEFAULT_PROJECT_CONFIG);
      expect(errors[0]).toMatch(/JSON 解析失败/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('越界字段 → 整份默认（strict 不宽容）', async () => {
    const root = tmpRoot();
    try {
      writeFileSync(path.join(root, PROJECT_CONFIG_NAME), JSON.stringify({ prompt: { nope: 1 } }), 'utf8');
      const { config, errors } = await loadProjectConfig(root);
      expect(config).toEqual(DEFAULT_PROJECT_CONFIG);
      expect(errors.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('好文件 → 解析结果', async () => {
    const root = tmpRoot();
    try {
      writeFileSync(path.join(root, PROJECT_CONFIG_NAME), JSON.stringify(GOOD), 'utf8');
      const { config, errors } = await loadProjectConfig(root);
      expect(errors).toEqual([]);
      expect(config.prompt.append).toBe(GOOD.prompt.append);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('filterMcpServers（外部 MCP，server 粒度）', () => {
  const servers = {
    nocturne_memory: { type: 'sse', url: 'http://127.0.0.1:8233/sse' },
    figma_read: { type: 'sse', url: 'http://127.0.0.1:8234/sse' },
  };

  it('空 disable → 原引用（零分配）', () => {
    expect(filterMcpServers(servers, [])).toBe(servers);
  });

  it('精确禁 mcp__<server名> → 整台摘掉', () => {
    const out = filterMcpServers(servers, ['mcp__nocturne_memory']);
    expect(out).not.toBe(servers);
    expect(Object.keys(out)).toEqual(['figma_read']);
  });

  it('前缀通配 mcp__<前缀>* → 多家一起摘；mcp__* 全摘', () => {
    expect(Object.keys(filterMcpServers(servers, ['mcp__nocturne_*']))).toEqual(['figma_read']);
    expect(filterMcpServers(servers, ['mcp__*'])).toEqual({});
  });

  it('无关条目（内置工具名 / mcp__nodesign__*）不动外部 server', () => {
    const out = filterMcpServers(servers, ['Bash', 'mcp__nodesign__publish_site', 'mcp__nodesign__browser_*']);
    expect(out).toBe(servers);
  });

  it('裸 server 名不认（要写 mcp__ 前缀，模型可见形态）', () => {
    const out = filterMcpServers(servers, ['nocturne_memory']);
    expect(out).toBe(servers);
  });
});

describe('applyMcpServerPreload（外部 MCP 整台常驻）', () => {
  const servers = {
    nocturne_memory: { type: 'sse', url: 'http://127.0.0.1:8233/sse' },
    figma_read: { type: 'sse', url: 'http://127.0.0.1:8234/sse' },
  };

  it('空 preload → 原引用（零分配）', () => {
    expect(applyMcpServerPreload(servers, [])).toBe(servers);
  });

  it('精确 mcp__<server名> → 该 server 加 alwaysLoad，原对象不被污染', () => {
    const first = { ...servers.nocturne_memory };   // 深拷贝一份对照
    const out = applyMcpServerPreload(servers, ['mcp__nocturne_memory']);
    expect(out).not.toBe(servers);
    expect(out.nocturne_memory.alwaysLoad).toBe(true);
    expect(out.figma_read).toBe(servers.figma_read);   // 未命中保持原引用
    expect(servers.nocturne_memory.alwaysLoad).toBeUndefined();  // 不污染输入
    expect(servers.nocturne_memory).toEqual(first);
  });

  it('前缀通配 mcp__<前缀>* → 多家一起挂；无关条目不挂', () => {
    const out = applyMcpServerPreload(servers, ['mcp__nocturne_*', 'Bash']);
    expect(out.nocturne_memory.alwaysLoad).toBe(true);
    expect(out.figma_read.alwaysLoad).toBeUndefined();
  });

  it('裸 server 名不认（要写 mcp__ 前缀）', () => {
    expect(applyMcpServerPreload(servers, ['nocturne_memory'])).toBe(servers);
  });
});

describe('isToolDisabled / filterTools', () => {
  it('toolNameMatches（preload 同语义）：精确/通配/前缀双写法', () => {
    const P = 'mcp__nodesign__';
    expect(toolNameMatches('read_board', ['mcp__nodesign__read_board'], P)).toBe(true);
    expect(toolNameMatches('read_board', ['read_board'], P)).toBe(true);
    expect(toolNameMatches('browser_capture', ['browser_*'], P)).toBe(true);
    expect(toolNameMatches('publish_site', ['mcp__nodesign__browser_*'], P)).toBe(false);
    expect(toolNameMatches('read_board', [], P)).toBe(false);
  });

  it('精确命中、前缀通配命中、空表不命中', () => {
    const disable = ['Bash', 'mcp__nodesign__browser_*'];
    expect(isToolDisabled('Bash', disable)).toBe(true);
    expect(isToolDisabled('mcp__nodesign__browser_capture', disable)).toBe(true);
    expect(isToolDisabled('mcp__nodesign__read_board', disable)).toBe(false);
    expect(isToolDisabled('bash', disable)).toBe(false);         // 大小写敏感
    expect(isToolDisabled('Read', disable)).toBe(false);
    expect(isToolDisabled('Read', [])).toBe(false);
    expect(isToolDisabled('Read', undefined)).toBe(false);
  });

  it('带命名空间前缀（MCP）：裸名与全名两个写法都认', () => {
    const disable = ['mcp__nodesign__publish_site', 'browser_*', 'Bash'];
    const P = 'mcp__nodesign__';
    expect(isToolDisabled('publish_site', disable, P)).toBe(true);           // 全名命中
    expect(isToolDisabled('publish_site', ['publish_site'], P)).toBe(true);  // 裸名命中
    expect(isToolDisabled('browser_navigate', disable, P)).toBe(true);       // 前缀通配 × 全名
    expect(isToolDisabled('browser_navigate', ['browser_*'], P)).toBe(true); // 前缀通配 × 裸名
    expect(isToolDisabled('read_board', disable, P)).toBe(false);
    expect(isToolDisabled('Bash', disable)).toBe(true);                      // 内置走裸名、不带前缀
  });

  it('空 disable → 原数组引用（零分配）；非空 → 过滤', () => {
    const list = ['Read', 'Bash', 'Task'];
    expect(filterTools(list, [])).toBe(list);
    expect(filterTools(list, ['Bash'])).toEqual(['Read', 'Task']);
    expect(filterTools(list, ['Task*'])).toEqual(['Read', 'Bash']);  // 全名也吃通配
  });
});

describe('resolveProjectPreludeContent', () => {
  it('mode=global / 无 prelude → null', async () => {
    expect(await resolveProjectPreludeContent(DEFAULT_PROJECT_CONFIG, '/tmp')).toBeNull();
    expect(await resolveProjectPreludeContent({}, '/tmp')).toBeNull();
  });

  it('mode=project + content → 内联全文', async () => {
    const cfg = { prompt: { prelude: { mode: 'project', content: '自定义 prelude' } } };
    expect(await resolveProjectPreludeContent(cfg, '/tmp')).toBe('自定义 prelude');
  });

  it('mode=project + file → 读工作区根内文件', async () => {
    const root = tmpRoot();
    try {
      writeFileSync(path.join(root, 'prelude-custom.md'), '文件版 prelude', 'utf8');
      const cfg = { prompt: { prelude: { mode: 'project', file: 'prelude-custom.md' } } };
      expect(await resolveProjectPreludeContent(cfg, root)).toBe('文件版 prelude');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('file 带路径分隔 / 绝对路径（越界读尝试）→ null + 回落', async () => {
    const root = tmpRoot();
    try {
      for (const bad of ['../secret.md', '/etc/prelude.md', 'sub/prelude.md', 'prelude.txt']) {
        const cfg = { prompt: { prelude: { mode: 'project', file: bad } } };
        expect(await resolveProjectPreludeContent(cfg, root), bad).toBeNull();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('file 不存在 / 没给 root → null', async () => {
    const cfg = { prompt: { prelude: { mode: 'project', file: 'nope.md' } } };
    expect(await resolveProjectPreludeContent(cfg, tmpRoot())).toBeNull();
    expect(await resolveProjectPreludeContent(cfg, null)).toBeNull();
  });
});