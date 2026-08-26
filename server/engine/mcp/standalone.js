#!/usr/bin/env node
/**
 * server/engine/mcp/standalone.js — Nodesign MCP 引擎的独立 stdio 进程（M1 全量版）
 *
 * 全量工具：复用 buildNodesignTools（server/engine/mcp/index.js）拿与 SDK 路径
 * 同一批工具描述对象（{ name, description, inputSchema(zod raw shape), handler,
 * _meta }），挂到 @modelcontextprotocol/sdk 的 McpServer + StdioServerTransport，
 * 喂给 pi-mcp-adapter（.pi/mcp.json directTools 直挂，toolPrefix 'none' → 裸名）。
 * pi 无 ToolSearch 延迟加载，deferred=不可调用，所以全量 ~54 件一次注册。
 *
 * 跨进程三桥（替换 M0 三个 stub，经 server/engine/pi/sidecar-client.js 回主进程
 * /__nd-sidecar；lifecycle 注入 NODESIGN_MAIN_URL/TOKEN）：
 *   - ctx.emit          → sidecar /emit       （事件富化进 EventBus；失败只 warn）
 *   - ctx.addToolCharge → sidecar /charge     （按件计费；失败只 warn）
 *   - tier/quota 闸     → sidecar /tool-gate  （fail-closed；imageGen 出图后另走
 *     chargeForImage → ctx.addToolCharge 记账，与 withTierGate 语义对齐）
 *
 * 身份来自 env（C1；adapter spawn MCP 子进程 = pi env 副本，天然会话级）：
 *   NODESIGN_SID / NODESIGN_UID / NODESIGN_PROJECT / NODESIGN_WORKSPACE /
 *   NODESIGN_DATA_ROOT / NODESIGN_MAIN_URL / NODESIGN_TOKEN / DB_PATH /
 *   NODESIGN_DISABLED_TOOLS（逗号分隔；项目级 tools.disable，lifecycle 注入，
 *   被禁工具整件不注册，连 adapter mcp() 代理也够不着）
 *
 * M1 已知缺口（M2/M3 复评）：
 *   - paint_still / publish_site / roll_film / report_issue 内部自带 quota/tier/
 *     并发闸，在 standalone 里读真实 DB，但 active-runs / rate-window 是 standalone
 *     进程自己的（非主进程权威）。主闸（web_search / generate_image）已 sidecar 化。
 *   - ctx.abortController.signal 永不 abort（standalone 无法感知主进程取消）。
 *
 * stdio 纪律：stdout 只许 JSON-RPC 帧 —— 所有 console.* 重定向到 stderr，且必须
 * 在任何会 log 的 import 之前执行（见下方顺序纪律）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// stdio MCP 纪律：stdout 只许走 JSON-RPC 帧。server 模块（engine/runs/store.js
// 等）有**无条件 console.log**（"SQLite ready" 之类），会在适配器解析帧流时
// 打爆协议 —— 把所有 console.* 输出重定向到 stderr（本进程是专用服务进程，
// 全局替换无副作用）。
for (const k of ['log', 'info', 'debug', 'warn', 'error', 'trace']) {
  console[k] = (...a) => {
    process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
  };
}
const log = (m) => process.stderr.write(`[standalone] ${m}\n`);

// ── 身份与路径：全部来自 env（C1）──
// ⚠️ 顺序纪律：workspace.js / engine/runs/store.js 在**模块顶层**读 env
// （PROJECTS_DATA_DIR / DB_PATH），而 ESM 静态 import 先于任何代码执行——
// 所以 env 归一化必须在动态 import 工具工厂之前完成。
const SESSION_ID = process.env.NODESIGN_SID ?? '';
const UID = process.env.NODESIGN_UID ?? '';
const PROJECT_ID = process.env.NODESIGN_PROJECT ?? '';
const WORKSPACE = process.env.NODESIGN_WORKSPACE ?? '';
const DATA_ROOT = process.env.NODESIGN_DATA_ROOT ?? '';
const MAIN_URL = process.env.NODESIGN_MAIN_URL ?? '';
const TOKEN = process.env.NODESIGN_TOKEN ?? '';

if (!SESSION_ID || !PROJECT_ID) log(`warn: NODESIGN_SID/NODESIGN_PROJECT 缺失（sid='${SESSION_ID}' project='${PROJECT_ID}'）——继续启动，身份按空串`);
if (!WORKSPACE) log('warn: NODESIGN_WORKSPACE 缺失——workspaceRoot 按空串，依赖工作区路径的工具调用期才会报错');
if (!MAIN_URL || !TOKEN) log('warn: NODESIGN_MAIN_URL/NODESIGN_TOKEN 缺失——sidecar 桥不可用：gate fail-closed，emit/charge 静默失败');
if (!process.env.DB_PATH) log('warn: DB_PATH 未设置——engine/runs/store.js 将回落默认库路径');
// board-store / workspace.js 的共享目录解析基于 PROJECTS_DATA_DIR
// （<dataRoot>/<pid>/shared/board.json）；DATA_ROOT 由 lifecycle 注入。
if (DATA_ROOT) process.env.PROJECTS_DATA_DIR = DATA_ROOT;

// ── 动态 import：env 已就位（./index.js 会传递性拉 SDK + store.js 开库）──
const [{ buildNodesignTools }, { chargeForImage }, { createSidecarClient }] = await Promise.all([
  import('./index.js'),
  import('./tools/tier-gate.js'),
  import('../pi/sidecar-client.js'),
]);

// workspaceRoot = sharedRoot = NODESIGN_WORKSPACE（<pid>/shared，即 pi 的 cwd）
const workspaceRoot = WORKSPACE;

// ── sidecar 三桥 ──
const sidecar = createSidecarClient({ baseUrl: MAIN_URL, token: TOKEN, sid: SESSION_ID, pid: PROJECT_ID });

// 工具对 ctx 的实际依赖面只有 3 个成员（emit / addToolCharge / abortController；
// runId/sessionId 走 ctx?.x 可选链，缺省 undefined 已被各工具容忍）。
const neverAbort = new AbortController();   // 永不 abort（standalone 无法感知主进程取消，M1 接受）
const ctx = {
  emit: (event) => { sidecar.emit(event); },                    // fire-and-forget
  addToolCharge: (name, usd) => { sidecar.charge(name, usd); }, // fire-and-forget
  abortController: neverAbort,
  get signal() { return neverAbort.signal; },
};

// ── sidecar-backed gate：签名与 withTierGate(toolDef, capability, projectId, ctx)
//    完全一致（web_search 传 3 参、generate_image 传 4 参），注入 buildNodesignTools。
//    主进程 /tool-gate 已做 tierDenial + imageGen 的 checkQuota 预检；出图后的
//    按件计费由 chargeForImage 走 ctx.addToolCharge → sidecar.charge。──
function sidecarGate(toolDef, capability, projectId, ctxArg = null) {
  return {
    ...toolDef,
    handler: async (args, extra) => {
      const verdict = await sidecar.toolGate(capability, toolDef.name);
      if (!verdict.allowed) {
        return { content: [{ type: 'text', text: verdict.denial || `${toolDef.name} denied` }], isError: true };
      }
      const result = await toolDef.handler(args, extra);
      if (capability === 'imageGen') chargeForImage(result, ctxArg);
      return result;
    },
  };
}

// ── 全量工具注册 ──
// disabledTools 从 NODESIGN_DISABLED_TOOLS env 读（项目级 tools.disable，lifecycle
// 注入）——被禁工具整件不注册，连 adapter mcp() 代理也够不着。preloadTools 传空：
// preload 是 SDK ToolSearch 概念，pi 无对应物，全量注册即常驻。
const disabledTools = (process.env.NODESIGN_DISABLED_TOOLS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const tools = buildNodesignTools({
  workspaceRoot,
  sharedRoot: workspaceRoot,
  projectId: PROJECT_ID,
  sessionId: SESSION_ID,
  ctx,
  disabledTools,
  preloadTools: [],
  gate: sidecarGate,
});

const server = new McpServer({ name: 'nodesign', version: '0.1.0' });
for (const t of tools) {
  // inputSchema 是 zod raw shape（工厂描述对象原生形态），MCP SDK 的
  // tool(name, desc, zodShape, cb) 原样接收；handler 返回 { content, isError }
  // 与 MCP CallToolResult 同构，直接透传。
  server.tool(t.name, t.description, t.inputSchema, (callArgs) => t.handler(callArgs, {}));
}

await server.connect(new StdioServerTransport());
log(`ready on stdio: ${tools.length} tools registered; session=${SESSION_ID || '(none)'} uid=${UID || '(none)'} project=${PROJECT_ID || '(none)'}`);
log(`tools: ${tools.map((t) => t.name).join(', ')}`);
if (disabledTools.length) log(`disabled (not registered): ${disabledTools.join(', ')}`);
