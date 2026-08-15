// 演出记录隐私闸（Read 拒 / Grep 改输入 / Bash 拒）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  checkPerformanceLogRead, guardGrepInput, checkBashPerformanceRead,
  makePreToolUsePerformanceLogGuard, makePreToolUseBashPerformanceGuard,
  scanPerformances, resetPerformanceScanCache,
} from './pre-performance-log-guard.js';
import { makePreToolUseGrepContentDefaultHandler } from './pre-defaults.js';

let root;
beforeEach(async () => {
  resetPerformanceScanCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.mkdir(path.join(root, '戏'), { recursive: true });
  await fs.writeFile(path.join(root, '戏/编排.yaml'), '历史:\n  文件: 记录.jsonl\n系统层: []\n');
  await fs.writeFile(path.join(root, '戏/对话.jsonl'), '{"text":"沈砚放下账本"}\n');
  await fs.writeFile(path.join(root, '戏/记录.jsonl'), '{"text":"另一场"}\n');
  await fs.mkdir(path.join(root, '普通'), { recursive: true });
  await fs.writeFile(path.join(root, '普通/对话.jsonl'), '');
});
afterEach(async () => {
  resetPerformanceScanCache();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Read 那一路', () => {
  it('演出文件夹的固定名与自定义记录名 → 拒；其余文件 → 放行', async () => {
    expect(await checkPerformanceLogRead({ file_path: path.join(root, '戏/对话.jsonl') }, root)).toContain('隐私');
    expect(await checkPerformanceLogRead({ file_path: path.join(root, '戏/摘要.json') }, root)).toContain('隐私');
    expect(await checkPerformanceLogRead({ file_path: path.join(root, '戏/记录.jsonl') }, root)).toContain('隐私');
    expect(await checkPerformanceLogRead({ file_path: path.join(root, '戏/编排.yaml') }, root)).toBeNull();
    expect(await checkPerformanceLogRead({ file_path: path.join(root, '戏/index.html') }, root)).toBeNull();
  });

  it('同名文件但同目录没有 编排.yaml → 放行（不是演出文件夹）', async () => {
    expect(await checkPerformanceLogRead({ file_path: path.join(root, '普通/对话.jsonl') }, root)).toBeNull();
  });

  it('handler 形状：拒时 permissionDecision=deny，放行时 {}', async () => {
    const h = makePreToolUsePerformanceLogGuard({ workspaceRoot: root });
    const deny = await h({ tool_input: { file_path: '戏/对话.jsonl' } });
    expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await h({ tool_input: { file_path: '戏/index.html' } })).toEqual({});
    expect(await h({ tool_input: {} })).toEqual({});
  });
});

describe('Grep 那一路（一版的洞：指到目录/不给 path 全放行）', () => {
  it('指到目录、指到项目根、不给 path —— 都注入排除 glob 而不是拒工具', async () => {
    for (const input of [{ path: '戏' }, { path: '.' }, {}]) {
      const r = await guardGrepInput(input, root);
      expect(r.deny).toBeUndefined();
      expect(r.glob).toContain('对话.jsonl');
      expect(r.glob).toContain('记录.jsonl');       // 自定义记录名也在里面
      expect(r.glob.startsWith('!{')).toBe(true);
    }
  });

  it('直接搜记录本体还是拒', async () => {
    expect((await guardGrepInput({ path: '戏/对话.jsonl' }, root)).deny).toContain('隐私');
  });

  it('agent 自己的 glob：会命中记录才拒，命不中就别多管', async () => {
    expect((await guardGrepInput({ path: '.', glob: '*.jsonl' }, root)).deny).toContain('隐私');
    expect((await guardGrepInput({ path: '.', glob: '*.{md,jsonl}' }, root)).deny).toContain('隐私');
    expect(await guardGrepInput({ path: '.', glob: '*.md' }, root)).toEqual({});
    expect(await guardGrepInput({ path: '.', glob: '**/*.html' }, root)).toEqual({});
  });

  it('工作区里没有演出 → 一个字都不改', async () => {
    const clean = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-'));
    resetPerformanceScanCache();
    expect(await guardGrepInput({ path: '.' }, clean)).toEqual({});
    await fs.rm(clean, { recursive: true, force: true });
  });

  it('跟 output_mode 默认值合在一个 handler 里：两件事同时落在 updatedInput 上', async () => {
    const h = makePreToolUseGrepContentDefaultHandler({ workspaceRoot: root });
    const out = await h({ tool_input: { pattern: '沈砚' } });
    expect(out.hookSpecificOutput.updatedInput.output_mode).toBe('content');
    expect(out.hookSpecificOutput.updatedInput.glob).toContain('对话.jsonl');
    // 显式 output_mode 不动，但排除照加
    const out2 = await h({ tool_input: { pattern: '沈砚', output_mode: 'count' } });
    expect(out2.hookSpecificOutput.updatedInput.output_mode).toBe('count');
    expect(out2.hookSpecificOutput.updatedInput.glob).toContain('对话.jsonl');
  });
});

describe('Bash 那一路', () => {
  it('命令点到记录名 → 拒（cat / tail / 变量拼接都一样）', async () => {
    expect(await checkBashPerformanceRead('cat 戏/对话.jsonl', root)).toContain('隐私');
    expect(await checkBashPerformanceRead('tail -n 5 戏/记录.jsonl | head', root)).toContain('隐私');
    expect(await checkBashPerformanceRead('wc -l "戏/对话.jsonl"', root)).toContain('隐私');
  });

  it('点了演出文件夹又通配到 json/jsonl → 拒', async () => {
    expect(await checkBashPerformanceRead('cat 戏/*.jsonl', root)).toContain('隐私');
  });

  it('⭐ 记录还不存在或是空的 → 放行（建场种开场白是正路）', async () => {
    const 新场 = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-'));
    await fs.mkdir(path.join(新场, '新戏'), { recursive: true });
    await fs.writeFile(path.join(新场, '新戏/编排.yaml'), '系统层: []\n');
    resetPerformanceScanCache();
    expect(await checkBashPerformanceRead('cat > 新戏/对话.jsonl <<EOF', 新场)).toBeNull();
    await fs.writeFile(path.join(新场, '新戏/对话.jsonl'), '{"text":"开场白"}\n');
    resetPerformanceScanCache();                 // 有了内容就该拦
    expect(await checkBashPerformanceRead('cat 新戏/对话.jsonl', 新场)).toContain('隐私');
    await fs.rm(新场, { recursive: true, force: true });
  });

  it('跟演出无关的命令一律放行', async () => {
    expect(await checkBashPerformanceRead('npm run build', root)).toBeNull();
    expect(await checkBashPerformanceRead('ls 戏', root)).toBeNull();
    expect(await checkBashPerformanceRead('', root)).toBeNull();
  });

  it('handler 形状', async () => {
    const h = makePreToolUseBashPerformanceGuard({ workspaceRoot: root });
    expect((await h({ tool_input: { command: 'cat 戏/对话.jsonl' } })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await h({ tool_input: { command: 'ls' } })).toEqual({});
  });
});

describe('⚠️ 系统层条目的 文件: 不是记录名（08-15 在真配置上量出来的连带问题）', () => {
  it('只认 历史.文件，系统层的设定文件照样能读能搜', async () => {
    const 真 = await fs.mkdtemp(path.join(os.tmpdir(), 'real-'));
    await fs.mkdir(path.join(真, '城/设定'), { recursive: true });
    await fs.writeFile(path.join(真, '城/编排.yaml'),
      '系统层:\n  - 名字: 身份\n    文件: 设定/叙述者.md\n历史:\n  文件: 对话.jsonl\n');
    await fs.writeFile(path.join(真, '城/设定/叙述者.md'), '# 叙述者\n');
    await fs.writeFile(path.join(真, '城/对话.jsonl'), '{"text":"台词"}\n');
    resetPerformanceScanCache();
    const { names } = await scanPerformances(真);
    expect([...names].sort()).toEqual(['对话.jsonl', '摘要.json']);   // 叙述者.md 不在里面
    expect(await checkPerformanceLogRead({ file_path: '城/设定/叙述者.md' }, 真)).toBeNull();
    expect(await checkBashPerformanceRead('cat 城/设定/叙述者.md', 真)).toBeNull();
    expect((await guardGrepInput({ path: '.' }, 真)).glob).not.toContain('叙述者');
    await fs.rm(真, { recursive: true, force: true });
  });
});

describe('扫描', () => {
  it('认出演出文件夹和它的记录名，深目录不漏', async () => {
    await fs.mkdir(path.join(root, 'a/b/戏二'), { recursive: true });
    await fs.writeFile(path.join(root, 'a/b/戏二/编排.yaml'), '系统层: []\n');
    resetPerformanceScanCache();
    const { dirs, names } = await scanPerformances(root);
    expect(dirs).toContain('戏');
    expect(dirs).toContain('a/b/戏二');
    expect([...names].sort()).toEqual(['对话.jsonl', '摘要.json', '记录.jsonl'].sort());
  });
});
