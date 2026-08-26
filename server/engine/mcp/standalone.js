#!/usr/bin/env node
/**
 * server/engine/mcp/standalone.js — Nodesign MCP 引擎的独立 stdio 进程（M0 最小版）
 *
 * M0 目标：把 Nodesign 的 MCP 工具以原生 stdio MCP server 形态提供，喂给
 * pi-mcp-adapter（directTools 直挂）。验证「工厂产物可换传输」：
 *
 * 复用点（createNodesignMcpServer 工厂，server/engine/mcp/index.js）：
 *   - 工厂内部把工具定义（SDK tool() 的**纯描述对象**）喂给
 *     createSdkMcpServer({ name, version, tools })。描述对象形状：
 *     { name, description, inputSchema(zod raw shape), handler, _meta }。
 *   - 本文件取同一批工厂（makeReadBoardTool / makePinToBoardTool /
 *     makeWebSearchTool / makeScreenshotCanvasTool）的产物，挂到
 *     @modelcontextprotocol/sdk 的 McpServer + StdioServerTransport 上。
 *     handler 返回形状（{ content, isError }）两边一致，直接透传。
 *     M1 起删 @anthropic-ai/claude-agent-sdk 依赖（届时工具描述改为纯 JSON
 *     schema，这里不用再碰 zod 实例）。
 *
 * 跨进程 stub（每处都注释「M1 起由 sidecar 桥替换」）：
 *   - tier 闸：真实闸依赖 auth/users-store + auth/tier.js（DB/账号体系，在
 *     server 进程内），M0 默认放行 + stderr warn。
 *   - ctx.emit / ctx.addToolCharge：真实实现把事件推进 EventBus 推给前端，
 *     M0 落 stderr JSON 日志。
 *   - board 数据：真实路径 —— <dataRoot>/<projectId>/shared/board.json。
 *     dataRoot 由 --data-root / env NODESIGN_DATA_ROOT 指定（映射到 server 侧
 *     PROJECTS_DATA_DIR 语义；⚠️ server 侧**没有 SQLite**，board-store 是
 *     JSON 文件 + 进程内锁，任务描述里的「SQLite」不成立）。数据根下缺
 *     board.json 时，从 env NODESIGN_BOARD_FIXTURE 或 cwd/board-fixture.json
 *     （探针 fixture）播种一份。
 *   - 身份：sessionId / uid / token 从 argv/env 读（M0 静态测试值）。
 *   - DB：导入工具工厂会连带 engine/runs/store.js（better-sqlite3 模块级
 *     初始化 + 幂等迁移），M0 强制把 DB_PATH 重定向到临时库，绝不摸
 *     server/db/nodesign.db（生产库）。
 *
 * 用法：
 *   node server/engine/mcp/standalone.js [--session <sid>] [--uid <uid>]
 *       [--project <pid>] [--data-root <dir>]
 *
 * 说明：M0 只走 stdio（.pi/mcp.json 的 command 就是本文件），不做 HTTP。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// stdio MCP 纪律：stdout 只许走 JSON-RPC 帧。server 模块（engine/runs/store.js
// 等）有**无条件 console.log**（"SQLite ready" 之类），会在适配器解析帧流时
// 打爆协议 —— 把所有 console.* 输出重定向到 stderr（本进程是专用服务进程，
// 全局替换无副作用）。
for (const k of ['log', 'info', 'debug', 'warn', 'error', 'trace']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
  };
}
// log / error 这两个我们自己也用，先恢复成 stderr 直写
const log = (m) => process.stderr.write(`[standalone] ${m}\n`);

// ⚠️ 顺序纪律：workspace.js / engine/runs/store.js 在**模块顶层**读 env
// （PROJECTS_DATA_DIR / DB_PATH），而 ESM 静态 import 先于任何代码执行——
// 所以 argv 解析 + env 重定向必须在动态 import 工具工厂之前完成。

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') out.session = argv[++i];
    else if (a === '--uid') out.uid = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--data-root') out.dataRoot = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.error('usage: standalone.js [--session <sid>] [--uid <uid>] [--project <pid>] [--data-root <dir>]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));

// ── M0 身份：静态测试值（M1 起由 sidecar 从真实会话注入）──
const SESSION_ID = args.session ?? process.env.NODESIGN_SESSION_ID ?? 'test-s1';
const UID = args.uid ?? process.env.NODESIGN_UID ?? 'u-test';
const TOKEN = process.env.NODESIGN_TOKEN ?? '';            // M0 静态空 token
const PROJECT_ID = args.project ?? 'proj_m0probe01';       // store.js PROJECT_ID_RE 合法格式
const DATA_ROOT = args.dataRoot || process.env.NODESIGN_DATA_ROOT || process.env.PROJECTS_DATA_DIR || '';
if (DATA_ROOT) process.env.PROJECTS_DATA_DIR = DATA_ROOT;
// 绝不摸生产库（engine/runs/store.js 默认 server/db/nodesign.db）
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(os.tmpdir(), 'nd-m0-standalone', 'probe.db');

log(`identity: session=${SESSION_ID} uid=${UID} project=${PROJECT_ID}`);
log(`dataRoot=${DATA_ROOT || '(unset -> repo projects-data default)'} DB_PATH=${process.env.DB_PATH}`);

// ── 动态 import：env 已就位 ──
const { makeReadBoardTool } = await import('./tools/read-board.js');
const { makePinToBoardTool } = await import('./tools/pin-to-board.js');
const { makeWebSearchTool } = await import('./tools/web-search.js');
const { makeScreenshotCanvasTool } = await import('./tools/screenshot.js');
const { getSharedDir } = await import('../../projects/workspace.js');

const workspaceRoot = getSharedDir(PROJECT_ID); // <dataRoot>/<pid>/shared

// ── board 数据：真实 board.json；缺则从 fixture 播种（M1 起由 sidecar 桥替换）──
function seedBoardFromFixture() {
  const boardFile = path.join(workspaceRoot, 'board.json');
  if (fs.existsSync(boardFile)) return false;
  const fixture = process.env.NODESIGN_BOARD_FIXTURE || path.resolve('board-fixture.json');
  let raw;
  try {
    raw = fs.readFileSync(fixture, 'utf8');
  } catch {
    log(`no board.json at ${boardFile} and no fixture at ${fixture} -> read_board 将返回空画布`);
    return false;
  }
  try {
    JSON.parse(raw); // 合法性预检，坏 fixture 不写盘
  } catch (e) {
    log(`fixture ${fixture} 不是合法 JSON，跳过播种: ${e.message}`);
    return false;
  }
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(boardFile, raw, 'utf8');
  log(`board.json 缺失，已从 fixture 播种: ${fixture} -> ${boardFile}`);
  return true;
}
seedBoardFromFixture();

// ── ctx stub：真实实现把事件推进 EventBus 推给前端（M1 起由 sidecar 桥替换）──
const ctxStub = {
  emit: (ev) => process.stderr.write(`[standalone:ctx.emit] ${JSON.stringify(ev)}\n`),
  addToolCharge: (...rest) => process.stderr.write(`[standalone:ctx.addToolCharge] ${JSON.stringify(rest)}\n`),
};

// ── tier 闸 stub：真实闸在 server 进程（auth/tier.js，按项目 owner），
//    M0 默认放行 + 每次调用 warn（M1 起由 sidecar 桥替换）──
function tierGateStub(toolDef, capability) {
  const handler = toolDef.handler;
  return {
    ...toolDef,
    handler: async (callArgs, extra) => {
      log(`tier gate STUB: ${toolDef.name}（capability=${capability}）默认放行（M1 起由 sidecar 桥替换真实闸）`);
      return handler(callArgs, extra);
    },
  };
}

// ── 4 个工具：与 factory 同款工厂、同款入参（只换 ctx / tier 闸）──
const tools = [
  // C9 screenshot_canvas — playwright headless 截图（真实实现；M0 不验证调用）
  makeScreenshotCanvasTool({ workspaceRoot, projectId: PROJECT_ID, sessionId: SESSION_ID, ctx: ctxStub }),
  // read_board — 读画布座次（真实实现；数据源见 seedBoardFromFixture）
  makeReadBoardTool({ projectId: PROJECT_ID }),
  // web_search — factory 里包了 withTierGate(…, 'webSearch', projectId)，这里用 stub 闸
  tierGateStub(makeWebSearchTool({ workspaceRoot, sharedRoot: workspaceRoot, ctx: ctxStub }), 'webSearch'),
  // pin_to_board — 写 board.json + 广播 board.updated（emit 走 ctxStub）
  makePinToBoardTool({ sharedRoot: workspaceRoot, projectId: PROJECT_ID, ctx: ctxStub }),
];

const server = new McpServer({ name: 'nodesign', version: '0.1.0' });
for (const t of tools) {
  const argNames = Object.keys(t.inputSchema ?? {});
  log(`register tool ${t.name}${argNames.length ? ` args=[${argNames.join(', ')}]` : ' (no args)'}`);
  // inputSchema 是 zod raw shape（工厂描述对象原生形态），MCP SDK 的
  // tool(name, desc, zodShape, cb) 原样接收；handler 返回 { content, isError }
  // 与 MCP CallToolResult 同构，直接透传。
  server.tool(t.name, t.description, t.inputSchema, (callArgs) => t.handler(callArgs, {}));
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready on stdio (${tools.length} tools); session=${SESSION_ID} uid=${UID}`);
