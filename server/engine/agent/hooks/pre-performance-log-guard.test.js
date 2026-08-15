// 演出记录隐私闸（Read/Grep 点名读记录 → 拒）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { checkPerformanceLogRead, makePreToolUsePerformanceLogGuard } from './pre-performance-log-guard.js';

let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plg-'));
  await fs.mkdir(path.join(root, '戏'), { recursive: true });
  await fs.writeFile(path.join(root, '戏/编排.yaml'), '历史:\n  文件: 记录.jsonl\n系统层: []\n');
  await fs.writeFile(path.join(root, '戏/对话.jsonl'), '');
  await fs.mkdir(path.join(root, '普通'), { recursive: true });
  await fs.writeFile(path.join(root, '普通/对话.jsonl'), '');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('演出记录隐私闸', () => {
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

  it('相对路径按工作区根解析；Grep 的 path 字段同判', async () => {
    expect(await checkPerformanceLogRead({ file_path: '戏/对话.jsonl' }, root)).toContain('隐私');
    expect(await checkPerformanceLogRead({ path: '戏/对话.jsonl' }, root)).toContain('隐私');
  });

  it('⚠️ 记录名只认 历史.文件：系统层条目的设定文件不算（08-15 在真配置上量出来的）', async () => {
    await fs.mkdir(path.join(root, '城'), { recursive: true });
    await fs.writeFile(path.join(root, '城/编排.yaml'),
      '系统层:\n  - 名字: 身份\n    文件: 叙述者.md\n历史:\n  文件: 对话.jsonl\n');
    await fs.writeFile(path.join(root, '城/叙述者.md'), '# 叙述者\n');
    // 正则版会把 叙述者.md 当成记录名连读都不让读——它就躺在 编排.yaml 边上
    expect(await checkPerformanceLogRead({ file_path: '城/叙述者.md' }, root)).toBeNull();
    expect(await checkPerformanceLogRead({ file_path: '城/对话.jsonl' }, root)).toContain('隐私');
  });

  it('handler 形状：拒时 permissionDecision=deny，放行时 {}', async () => {
    const h = makePreToolUsePerformanceLogGuard({ workspaceRoot: root });
    const deny = await h({ tool_input: { file_path: '戏/对话.jsonl' } });
    expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await h({ tool_input: { file_path: '戏/index.html' } })).toEqual({});
    expect(await h({ tool_input: {} })).toEqual({});
  });
});
