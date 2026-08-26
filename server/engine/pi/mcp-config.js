/**
 * server/engine/pi/mcp-config.js — 项目级 .pi/mcp.json 覆盖层（C9）
 *
 * pi 的 MCP adapter 配置走「项目覆盖层」：<pi cwd>/.pi/mcp.json（pi-project scope，
 * 最高优先级；形状对照 server/_probe-mcp-tools.mjs:137-150 的 M0 实测）。
 * lifecycle.sessionLaunch 在 spawn 前对 <pid>/shared 调一次 ensureProjectPiConfig。
 *
 * 内容：
 *  - mcpServers.nodesign：command=node，args 只放 standalone.js 绝对路径——
 *    会话身份（sid/uid/project…）走 env（C1），不进 args；
 *  - directTools：standalone 注册的全量工具名（pi 无 ToolSearch 延迟加载，
 *    deferred=不可调用，必须全列，见计划决策 1）；
 *  - lifecycle:'lazy' + requestTimeoutMs:60000：adapter 按需拉起 standalone；
 *  - settings.toolPrefix:'none'：工具注册名无前缀（events 里 toolName 即裸名）。
 *
 * 幂等：已存在且 JSON 深等 → 跳过；否则覆盖写（2 空格缩进 + 尾换行）。
 *
 * ⚠️ adapter mcp-cache.json 缓存坑（doc 附录 D.3）：改 mcp.json 后须删 agent-dir
 * 的 mcp-cache，否则 direct tools 不刷新——那是 F 的 adapter gate 探针的职责。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_NAME } from '../mcp/server-name.js';

/** standalone MCP server 入口（server/engine/mcp/standalone.js）绝对路径。 */
const STANDALONE_JS = fileURLToPath(new URL('../mcp/standalone.js', import.meta.url));

/** 纯 JSON 值深等（mcp.json 只有对象/数组/字符串/数字/布尔/null）。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * 幂等写 <sharedDir>/.pi/mcp.json。
 * @param {string} sharedDir  项目共享工作区（<pid>/shared，即 pi 的 cwd）
 * @param {{ directTools?: string[] }} opts  directTools = standalone 注册的全量工具名
 * @returns {{ written: boolean }}  written:false = 内容一致跳过
 */
export function ensureProjectPiConfig(sharedDir, { directTools = [] } = {}) {
  const piDir = path.join(sharedDir, '.pi');
  const mcpPath = path.join(piDir, 'mcp.json');
  const config = {
    mcpServers: {
      // 键 = MCP_SERVER_NAME（server-name.js 单一真相源）—— isolation 的整服务放行
      // 规则 mcp__<名> 与它同源，谁改名都不会只改一头（SDK 时代这个键在 session-loop，
      // M1 换 pi-rp 后挪到这里，isolation.test.js 的跨文件钉子跟着指过来）。
      [MCP_SERVER_NAME]: {
        command: 'node',
        args: [STANDALONE_JS],
        directTools: [...directTools],
        lifecycle: 'lazy',
        requestTimeoutMs: 60000,
      },
    },
    settings: { toolPrefix: 'none' },
  };

  // 已存在且深等 → 跳过（不碰 mtime，避免无谓的 adapter 缓存失效）
  try {
    const current = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (deepEqual(current, config)) return { written: false };
  } catch { /* 不存在 / 坏 JSON → 覆盖写 */ }

  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { written: true };
}
