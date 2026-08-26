/**
 * server/engine/mcp/tool-shim.js — SDK tool() 的本地替身（M1 wave 4）
 *
 * SDK 的 tool() 只是把四个参数收进一个纯描述对象 {name, description, inputSchema, handler}，
 * 真正的注册发生在 createSdkMcpServer 内部。M1 起工具走 pi-mcp-adapter（standalone.js），
 * 描述对象被 zod→JSON-schema 转换后直挂 MCP —— 不再需要 SDK。这个 shim 产出完全相同的
 * 形状，buildNodesignTools 与 standalone.js 零改动复用。
 */
export function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}
