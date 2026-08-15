// 项目边界闸（2026-08-15）：结构化工具跨项目读写 → 拒
import { describe, it, expect } from 'vitest';
import { checkWorkspaceScope, makePreToolUseWorkspaceScopeGuard } from './pre-workspace-scope-guard.js';

const dataRoot = '/data/projects-data';
const workspaceRoot = '/data/projects-data/proj_aaa/shared';
const ctx = { workspaceRoot, dataRoot };

describe('放行的', () => {
  it('自己工作区里的绝对路径 / 相对路径', () => {
    expect(checkWorkspaceScope({ file_path: `${workspaceRoot}/站点/index.html` }, ctx)).toBeNull();
    expect(checkWorkspaceScope({ file_path: '站点/index.html' }, ctx)).toBeNull();
    expect(checkWorkspaceScope({ path: '.' }, ctx)).toBeNull();
  });
  it('数据根之外的东西不归它管（skill 目录、仓库、/tmp 要照读）', () => {
    expect(checkWorkspaceScope({ path: '/home/x/projects/Nodesign/server/engine/plugins' }, ctx)).toBeNull();
    expect(checkWorkspaceScope({ file_path: '/tmp/whatever.png' }, ctx)).toBeNull();
  });
  it('没带路径字段的输入', () => {
    expect(checkWorkspaceScope({ pattern: 'foo' }, ctx)).toBeNull();
    expect(checkWorkspaceScope(undefined, ctx)).toBeNull();
  });
});

describe('拦下的', () => {
  it('⭐ 别的项目的工作区 —— Read/Grep/Glob/Write 都走同一个判据', () => {
    expect(checkWorkspaceScope({ file_path: `${dataRoot}/proj_bbb/shared/秘密.md` }, ctx)).toMatch(/别的项目/);
    expect(checkWorkspaceScope({ path: `${dataRoot}/proj_bbb` }, ctx)).toMatch(/别的项目/);
    expect(checkWorkspaceScope({ notebook_path: `${dataRoot}/proj_bbb/a.ipynb` }, ctx)).toMatch(/别的项目/);
  });
  it('用 ../ 爬出去的相对路径', () => {
    expect(checkWorkspaceScope({ file_path: '../../proj_bbb/shared/x.md' }, ctx)).toMatch(/别的项目/);
  });
  it('数据根本身（想列所有项目）', () => {
    expect(checkWorkspaceScope({ path: dataRoot }, ctx)).toMatch(/别的项目/);
  });
  it('前缀相同但不是同一个目录（proj_aaa-evil 不算自己人）', () => {
    expect(checkWorkspaceScope({ file_path: `${dataRoot}/proj_aaa-evil/shared/x` }, ctx)).toMatch(/别的项目/);
  });
});

describe('写工具更严：出了工作区就不许写', () => {
  const w = (file_path, toolName = 'Write') => checkWorkspaceScope({ file_path }, { ...ctx, toolName });
  it('自己工作区里随便写', () => {
    expect(w('站点/index.html')).toBeNull();
    expect(w(`${workspaceRoot}/a.png`)).toBeNull();
  });
  it('⭐ 家目录 / 别的仓库 —— 读可以，写不行', () => {
    expect(checkWorkspaceScope({ path: '/home/x/projects/SillyTavern' }, ctx)).toBeNull();  // 读放行
    expect(w('/home/x/projects/SillyTavern/server.js')).toMatch(/只能落在/);
    expect(w('/home/x/随手.txt', 'Edit')).toMatch(/只能落在/);
    expect(w('/home/x/a.ipynb', 'NotebookEdit')).toMatch(/只能落在/);
  });
  it('临时目录放行（agent 写个临时脚本再跑是正常操作）', () => {
    expect(w('/tmp/scratch.sh')).toBeNull();
  });
});

describe('钩子形状', () => {
  it('拒的时候给 deny + 理由，放行给空对象', async () => {
    const h = makePreToolUseWorkspaceScopeGuard(ctx);
    const 拒 = await h({ tool_name: 'Read', tool_input: { file_path: `${dataRoot}/proj_bbb/x` } });
    expect(拒.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(拒.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(await h({ tool_input: { file_path: 'a.md' } })).toEqual({});
  });
  it('缺 dataRoot 时不拦（fail-open，别把会话堵死）', () => {
    expect(checkWorkspaceScope({ file_path: `${dataRoot}/proj_bbb/x` }, { workspaceRoot })).toBeNull();
  });
});
