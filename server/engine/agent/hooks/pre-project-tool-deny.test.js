/**
 * hooks/pre-project-tool-deny.js 的钉子：精确名 / 前缀通配命中 → deny + 理由；
 * 其他工具放行；disable 为空 / 闸自身出错 → 放行（fail-open）。
 */
import { describe, it, expect } from 'vitest';
import { makePreToolUseProjectToolDeny } from './pre-project-tool-deny.js';

const DISABLE = [
  'mcp__nocturne_memory__archive_memory',
  'mcp__nocturne_memory__set_world_time',
  'mcp__nocturne_memory__staging_*',
];

describe('pre-project-tool-deny', () => {
  it('精确命中的外部 MCP 工具 → deny（含 hookEventName / permissionDecision / reason）', async () => {
    const h = makePreToolUseProjectToolDeny({ disable: DISABLE });
    const out = await h({ tool_name: 'mcp__nocturne_memory__archive_memory', tool_input: {} });
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/archive_memory/);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('tools.disable');
  });

  it('前缀通配命中（尾缀 *）→ deny', async () => {
    const h = makePreToolUseProjectToolDeny({ disable: DISABLE });
    expect((await h({ tool_name: 'mcp__nocturne_memory__staging_clean', tool_input: {} })).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('未禁用的工具（同 server 其他工具 / 内置工具）→ 原样放行 {}', async () => {
    const h = makePreToolUseProjectToolDeny({ disable: DISABLE });
    expect(await h({ tool_name: 'mcp__nocturne_memory__remember_memory', tool_input: {} })).toEqual({});
    expect(await h({ tool_name: 'Read', tool_input: {} })).toEqual({});
    expect(await h({ tool_name: 'mcp__nodesign__read_board', tool_input: {} })).toEqual({});
  });

  it('disable 为空 → 全部放行', async () => {
    const h = makePreToolUseProjectToolDeny({ disable: [] });
    expect(await h({ tool_name: 'mcp__nocturne_memory__archive_memory', tool_input: {} })).toEqual({});
  });

  it('闸自身出错（缺 tool_name 等）→ 放行，不炸', async () => {
    const h = makePreToolUseProjectToolDeny({ disable: DISABLE });
    expect(await h({ tool_input: {} })).toEqual({});
    expect(await h(null)).toEqual({});
  });
});