/**
 * task-events 收口钉子（2026-08-18）。
 *
 * 病根：SDK 统一任务系统让后台 Bash / Workflow 也发 task_*，不收口的话
 * 每条 bash 命令都顶着「子代理」的名头进前端（便利贴/徽记/侧栏全线噪音）。
 * 这里正反都钉：真子代理要过、非子代理要拦、拦完安全网（报告丢失兜底）
 * 还得活着。
 */
import { describe, it, expect } from 'vitest';
import { handleTaskMessage, isSubagentTask } from './task-events.js';
import { makePostToolUseSubagentReportRecovery } from './hooks/post-subagent-report.js';

const ctxOf = () => {
  const emitted = [];
  return {
    emitted,
    emit: (e) => emitted.push(e),
    absorbSubagentUsage: () => {},
  };
};

const started = (over = {}) => ({
  subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1',
  description: '找出所有引用', ...over,
});

describe('isSubagentTask', () => {
  it('Task 子代理（subagent_type / local_agent）算', () => {
    expect(isSubagentTask({ subagent_type: 'explorer' })).toBe(true);
    expect(isSubagentTask({ task_type: 'local_agent' })).toBe(true);
  });
  it('后台 bash / workflow / 未知任务型不算', () => {
    expect(isSubagentTask({ task_type: 'local_bash' })).toBe(false);
    expect(isSubagentTask({ task_type: 'local_workflow' })).toBe(false);
    expect(isSubagentTask({})).toBe(false);
  });
  it('SDK 标了 skip_transcript 的 ambient 任务即使是子代理也隐藏', () => {
    expect(isSubagentTask({ subagent_type: 'x', skip_transcript: true })).toBe(false);
  });
});

describe('收口：run.task.* 只放真子代理', () => {
  it('子代理 started → emit，且带 subagentType 真名', () => {
    const ctx = ctxOf();
    handleTaskMessage(ctx, started({ subagent_type: 'explorer', task_type: 'local_agent' }));
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0].type).toBe('run.task.started');
    expect(ctx.emitted[0].subagentType).toBe('explorer');
  });

  it('bash 任务 started → 一声不吭（这就是那次全线噪音的病根）', () => {
    const ctx = ctxOf();
    handleTaskMessage(ctx, started({ task_type: 'local_bash' }));
    expect(ctx.emitted).toEqual([]);
  });

  it('progress / updated / notification 跟随 started 的判决', () => {
    const ctx = ctxOf();
    handleTaskMessage(ctx, started({ subagent_type: 'explorer' }));
    handleTaskMessage(ctx, started({ task_id: 't_bash', tool_use_id: 'tu_b', task_type: 'local_bash' }));
    handleTaskMessage(ctx, { subtype: 'task_progress', task_id: 't1', summary: '在翻文件' });
    handleTaskMessage(ctx, { subtype: 'task_progress', task_id: 't_bash', summary: '还在跑' });
    handleTaskMessage(ctx, { subtype: 'task_updated', task_id: 't_bash', patch: { status: 'running' } });
    handleTaskMessage(ctx, { subtype: 'task_notification', task_id: 't1', status: 'completed' });
    handleTaskMessage(ctx, { subtype: 'task_notification', task_id: 't_bash', status: 'completed' });
    const types = ctx.emitted.map(e => `${e.type}:${e.taskId}`);
    expect(types).toEqual([
      'run.task.started:t1',
      'run.task.progress:t1',
      'run.task.notification:t1',
    ]);
  });

  it('用量记账不分任务型（bash/workflow 的账也要吸）', () => {
    let absorbed = null;
    const ctx = { emit() {}, absorbSubagentUsage: (u) => { absorbed = u; } };
    handleTaskMessage(ctx, {
      subtype: 'task_notification', task_id: 't_bash', status: 'completed',
      usage: { total_tokens: 7 },
    });
    expect(absorbed).toEqual({ total_tokens: 7 });
  });

  it('报告丢失兜底在闸前：被拦的任务也记 output_file（安全网不依赖闸的状态）', async () => {
    const ctx = ctxOf();
    handleTaskMessage(ctx, {
      subtype: 'task_notification', task_id: 't_unseen', tool_use_id: 'tu_unseen',
      status: 'completed', summary: '', output_file: '/tmp/unseen.jsonl',
      usage: { tool_uses: 9 },
    });
    expect(ctx.emitted).toEqual([]);   // 事件被拦
    const out = await makePostToolUseSubagentReportRecovery()({ tool_use_id: 'tu_unseen' });
    expect(out.hookSpecificOutput?.additionalContext).toMatch(/unseen\.jsonl/);
  });
});
