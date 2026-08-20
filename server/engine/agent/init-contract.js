/**
 * server/engine/agent/init-contract.js — 开局契约自检（2026-08-20 从 session-loop.js
 * 拆出，行数棘轮；逻辑原样）。session-loop 在每条 system:init 到达时调一次。
 */

import { recordIssue, signatureOf } from '../../lib/issues-store.js';

// ── 开局契约自检（2026-08-14 空壳钩子灭门案第 3 层，真正治本）──
//
// 背景：一个 `{ matcher: 'Bash' }` 空壳钩子条目让 SDK initialize 的大 try 吞掉
// TypeError → 全部程序化钩子 + 全部 in-process MCP server 无声蒸发，mcp_servers
// 里连 failed 都不留，会话照常跑 —— 潜伏六天。能静默这么久的结构性原因是这里
// 从来不消费 system:init：SDK 开局就把「会话里实际有哪些 server / 工具」告诉了
// 我们，但没人看。
//
// 现在对账：nodesign 必须 connected，且 server 实例声明的每个工具（探针实测
// deferred 工具也在 init.tools 里，27/27）都必须出现。不满足 → recordIssue 进
// 自动层 + throw 杀会话（外层 catch 走真错路径：markRunFailed + run.error 前端
// 显式可见）。已知代价：SDK 改 init 形状会误杀会话 —— 但误杀 5 分钟定位，
// 静默降级是 6 天暗账；工具残废的会话产出是负价值还烧钱，杀掉比放行仁慈。
export function assertInitContract(init, { sessionId, projectId, isResume, initialPermissionMode, platform, sdkModel, nodesignServer }) {
  const problems = [];
  const nd = (init.mcp_servers || []).find((s) => s.name === 'nodesign');
  if (!nd) {
    problems.push('mcp_servers 里没有 nodesign（in-process MCP server 蒸发，连 failed 状态都不留）');
  } else if (nd.status !== 'connected') {
    problems.push(`nodesign server status=${nd.status}（预期 connected）`);
  }
  const registered = new Set(init.tools || []);
  const expected = (nodesignServer.toolNames || []).map((n) => `mcp__nodesign__${n}`);
  const missing = expected.filter((n) => !registered.has(n));
  if (missing.length) {
    problems.push(`nodesign 工具缺 ${missing.length}/${expected.length}：${missing.join(', ')}`);
  }
  // 权限模式对账（2026-08-15）：**要的和拿到的可能不一样，而且是静默的**。
  // 实测：会话模型是 haiku 时 `permissionMode:'auto'` 会被无声降级成 'default'，
  // init 里照报 default，没有任何报错 —— 分类器一次都不跑，我们却以为它在把关。
  // 只警告不杀：降级后的会话还能干活，杀掉代价大于收益；但必须在日志里喊出来。
  const wantMode = isResume ? null : (initialPermissionMode === 'plan' ? 'plan' : platform.permissionModeDefault);
  if (wantMode && init.permissionMode && init.permissionMode !== wantMode) {
    console.warn(
      `[session-loop] ⚠️ sid=${sessionId.slice(0, 8)} 权限模式被降级：要 ${wantMode}，`
      + `实际 ${init.permissionMode}（模型 ${sdkModel} 可能不支持该模式）`,
    );
  }
  if (!problems.length) {
    console.info(
      `[session-loop] sid=${sessionId.slice(0, 8)} init 契约自检 ✓ `
      + `(nodesign connected, ${expected.length}/${expected.length} tools, `
      + `mode=${init.permissionMode ?? '未报'})`,
    );
    return;
  }
  const detail = problems.join('；');
  // 自动层留案底（fail-soft：记录本身不能变成新故障源）。signature 只含缺失
  // 集合不含 sessionId —— 同一种蒸发聚成一行计数。
  try {
    recordIssue({
      source: 'auto',
      toolName: 'session_init_contract',
      summary: `开局契约自检失败：${detail.slice(0, 120)}`,
      detail,
      projectId,
      sessionId,
      signature: signatureOf(`session_init_contract|${missing.join(',')}|${nd ? nd.status : 'absent'}`),
    });
  } catch { /* ignore */ }
  throw new Error(`开局契约自检失败（杀会话）：${detail}`);
}
