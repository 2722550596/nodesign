/**
 * workspace.test.js — rewindWorkspace / getHeadSha 回归（M3c C4/C9）
 *
 * 用临时 git 仓验证 rewind 文件侧语义：
 *  - 精确回到目标树：期间新增的文件被删、被改的文件恢复目标内容
 *  - 保留历史：rewind 是新 commit（HEAD 祖先里仍有目标 commit），不是 reset --hard
 *  - 无变化（目标 = HEAD）→ { sha: null, filesChanged: [] }
 *  - 无效 sha → INVALID_SHA
 *  - getHeadSha：git 仓 → sha；非 git 目录 → null
 *
 * env 纪律：workspace.js 模块顶层读 PROJECTS_DATA_DIR（store.js 读 DB_PATH），
 * 必须在动态 import 之前设好（同 move-entry.test.js / board-tasklist.test.js 模式）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ws-rewind-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { rewindWorkspace, getHeadSha, getWorkspaceRoot } = await import('./workspace.js');

const PID = 'proj_rewind_test01';
const SID = '11111111-2222-3333-4444-555555555555';

/** 测试仓里的 git（带身份，避免依赖全局 git config） */
function git(cwd, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=test@nodesign', '-c', 'user.name=test',
    ...args,
  ], { cwd, encoding: 'utf8' }).trim();
}

let wsRoot;
let shaBeforeTurn2;   // turn2 开始前的树（rewind 目标）

beforeAll(async () => {
  wsRoot = getWorkspaceRoot(PID);
  await fs.mkdir(wsRoot, { recursive: true });
  git(wsRoot, 'init', '-q');
  // turn1 的产物：文件 A
  await fs.writeFile(path.join(wsRoot, 'a.txt'), 'A v1\n');
  git(wsRoot, 'add', '-A');
  git(wsRoot, 'commit', '-q', '-m', 'turn 1');
  shaBeforeTurn2 = git(wsRoot, 'rev-parse', 'HEAD');
  // turn2 的产物：改 A + 新增 B
  await fs.writeFile(path.join(wsRoot, 'a.txt'), 'A v2\n');
  await fs.writeFile(path.join(wsRoot, 'b.txt'), 'B v1\n');
  git(wsRoot, 'add', '-A');
  git(wsRoot, 'commit', '-q', '-m', 'turn 2');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('rewindWorkspace（M3c 文件侧）', () => {
  it('精确回到目标树：新增文件被删、被改文件恢复、历史保留', async () => {
    const result = await rewindWorkspace(PID, SID, shaBeforeTurn2);

    // 新 commit（不是 reset --hard：目标 commit 仍在 HEAD 祖先里，审计链完整）
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.sha).not.toBe(shaBeforeTurn2);
    const ancestors = git(wsRoot, 'log', '--format=%H');
    expect(ancestors).toContain(shaBeforeTurn2);

    // 树状态精确回到 turn2 之前：B 被删（checkout 不删新增文件，靠 git rm）、A 恢复 v1
    await expect(fs.access(path.join(wsRoot, 'b.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(wsRoot, 'a.txt'), 'utf8')).toBe('A v1\n');
    expect(git(wsRoot, 'status', '--porcelain')).toBe('');   // 工作区干净

    // filesChanged = targetSha→HEAD 的完整清单（前端按 length 显示「已回滚 N 个文件」）
    expect([...result.filesChanged].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('无变化（目标树 = 当前树）→ { sha: null, filesChanged: [] }', async () => {
    const head = git(wsRoot, 'rev-parse', 'HEAD');
    const result = await rewindWorkspace(PID, SID, head);
    expect(result).toEqual({ sha: null, filesChanged: [] });
  });

  it('无效 sha → INVALID_SHA（不碰 git）', async () => {
    await expect(rewindWorkspace(PID, SID, 'not-a-sha!')).rejects.toMatchObject({ code: 'INVALID_SHA' });
    await expect(rewindWorkspace(PID, SID, 'zzz')).rejects.toMatchObject({ code: 'INVALID_SHA' });
  });

  it('目标 sha 不在仓里 → REWIND_FAILED（git diff 失败）', async () => {
    await expect(rewindWorkspace(PID, SID, 'deadbeefdeadbeef')).rejects.toMatchObject({ code: 'REWIND_FAILED' });
  });
});

describe('getHeadSha（M3c turn 锚点）', () => {
  it('git 仓 → 40 位 sha', async () => {
    const sha = await getHeadSha(wsRoot);
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(sha).toBe(git(wsRoot, 'rev-parse', 'HEAD'));
  });

  it('非 git 目录 → null（rewind 文件侧不可用，调用方跳过索引）', async () => {
    const noGit = path.join(tmp, 'no-git');
    await fs.mkdir(noGit, { recursive: true });
    expect(await getHeadSha(noGit)).toBeNull();
  });
});
