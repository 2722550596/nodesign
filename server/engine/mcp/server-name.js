/**
 * mcp/server-name.js —— MCP 服务名的唯一真相源（2026-08-25）
 *
 * 这个名字有两个读者，而且**改错了不会报错，只会静默失效**：
 *   1. session-loop.js 的 `mcpServers: { [MCP_SERVER_NAME]: server }` —— 决定
 *      工具在模型眼里叫 `mcp__<名>__<工具>`
 *   2. isolation.js 的 `permissions.allow: ['mcp__<名>']` —— 决定这些工具跳不跳
 *      auto 模式分类器
 * 两处对不上时：工具照常能用，只是每一次调用又开始过分类器，没有任何报错。
 * 所以名字收在这里一份，两边都 import，并由 isolation.test.js 钉住。
 *
 * 单独一个文件而不是挂在 mcp/index.js：isolation.js 只要这一个字符串，
 * 不该为此把整棵工具树（连带 DB 模块）拖进来。
 */

export const MCP_SERVER_NAME = 'nodesign';

/** 给 permissions.allow 用的整服务放行规则 */
export const MCP_ALLOW_RULE = `mcp__${MCP_SERVER_NAME}`;
