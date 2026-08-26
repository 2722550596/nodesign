/**
 * server/engine/mcp/external.js — 外部 MCP server 装配（2026-08-26）
 *
 * Nodesign 自己的工具（mcp__nodesign__*）是 in-process 的 SDK server（index.js）。
 * 这里管「消费外部 MCP server」：站主在 .env 里用 NODESIGN_MCP_SERVERS 声明，
 * SDK 以子进程 client 连上去，模型就能调 mcp__<名字>__<工具>。
 *
 * 为什么是 env 而不是数据库：这是「这台机器连哪些外部服务」的站主级配置，跟
 * 钥匙/开关同族，走 local-env.js 白名单（设置页「引擎」组可改，改完重启生效）。
 *
 * 格式（JSON object；值 = SDK McpServerConfig，或裸 URL 字符串 = SSE）：
 *   NODESIGN_MCP_SERVERS={"nocturne_memory":{"type":"sse","url":"http://127.0.0.1:8233/sse"}}
 *
 * 两个读者（同 server-name.js 纪律，谁改漏了都不报错只会静默失效）：
 *   1. session-loop.js 的 mcpServers 展开 —— 决定模型看到的工具前缀
 *   2. isolation.js 的 permissions.allow 前缀 —— 让工具跳过 auto 分类器
 * 两个读法都从同一份解析结果出。
 *
 * 解析失败（JSON 非法 / 名字不合法）在模块加载时直接 throw：启动炸是五分钟
 * 定位，静默降级是六天暗账（hooks.js 同款哲学）。
 */

/** 名字会进 mcp__<名>__<工具> 前缀和 permissions.allow 规则，只放行稳妥字符集 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 纯解析函数（单测直接打这个）。
 * @param {string|undefined} raw  NODESIGN_MCP_SERVERS 原文
 * @returns {Record<string, object>} 名字 → SDK McpServerConfig（字符串 URL 归一成 sse）
 */
export function parseExternalMcpServers(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`NODESIGN_MCP_SERVERS 不是合法 JSON：${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NODESIGN_MCP_SERVERS 必须是对象：{ 名字: {type,url}|"url" }');
  }
  const out = {};
  for (const [name, spec] of Object.entries(parsed)) {
    if (!NAME_RE.test(name)) {
      throw new Error(`NODESIGN_MCP_SERVERS 的名字不合法（只允许字母数字 _-）：${JSON.stringify(name)}`);
    }
    if (typeof spec === 'string') {
      out[name] = { type: 'sse', url: spec };
    } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      out[name] = spec;
    } else {
      throw new Error(`NODESIGN_MCP_SERVERS.${name} 必须是对象或 URL 字符串`);
    }
  }
  return out;
}

// 模块加载时解析一次并冻结 —— 进程生命周期内 env 不变，两个读者共享同一份。
const memo = Object.freeze(parseExternalMcpServers(process.env.NODESIGN_MCP_SERVERS));

/** 展开进 session-loop.js 的 mcpServers（与 [MCP_SERVER_NAME]: nodesignServer 并列） */
export function externalMcpServers() {
  return memo;
}

/** isolation.js 的 permissions.allow 追加规则：mcp__<名>（整服务放行，同 MCP_ALLOW_RULE） */
export function externalMcpAllowRules() {
  return Object.keys(memo).map((name) => `mcp__${name}`);
}
