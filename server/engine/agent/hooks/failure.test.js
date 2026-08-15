// PostToolUseFailure 的恢复建议（2026-08-15 加沙盒偶发那条时补的测试）
import { describe, it, expect, vi } from 'vitest';
import { makePostToolUseFailureHandler } from './failure.js';

const ctx = { emit: vi.fn() };
const run = (tool_name, error) =>
  makePostToolUseFailureHandler({ ctx, projectId: 'p', sessionId: 's' })({ tool_name, error });

describe('沙盒启动偶发要点破', () => {
  it('⭐ apply-seccomp / unshare EINVAL → 明说"重跑一次"，别让 agent 推断成权限拦截', async () => {
    const out = await run('Bash', 'apply-seccomp: unshare(CLONE_NEWUSER): Invalid argument');
    const text = out.hookSpecificOutput.additionalContext;
    expect(text).toMatch(/原样再跑一次/);
    expect(text).toMatch(/不是权限拦截/);
  });
  it('普通 Bash 失败还是走老那套建议', async () => {
    const out = await run('Bash', 'cat: x: No such file or directory');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/命令本身错/);
  });
  it('用户中断不给建议', async () => {
    const h = makePostToolUseFailureHandler({ ctx, projectId: 'p', sessionId: 's' });
    expect(await h({ tool_name: 'Bash', error: 'x', is_interrupt: true })).toEqual({});
  });
});
