/**
 * server/engine/pi/lifecycle.js — pi 会话子进程生命周期（M1）
 *
 * 三件事：
 *  1. resolvePiBinary()   — pi 二进制解析：env PI_BIN（存在则用）→ PATH 'pi'；都无抛错。
 *  2. sessionLaunch()     — 组装 spawn 四元组 { binary, args, cwd, env }（契约 C1/C2），
 *                           spawn 前写项目级 .pi/mcp.json（C9，ensureProjectPiConfig）。
 *  3. createSessionProcess() — spawn + 孤儿回收（模块级 Set + 进程退出钩子 SIGKILL）。
 *
 * 契约锚点（local://m1-plan.md）：
 *  - C1 env：PI_CODING_AGENT_DIR / PI_TELEMETRY=0 / NODESIGN_SID|UID|PROJECT|WORKSPACE|
 *    DATA_ROOT|MAIN_URL|TOKEN / NODESIGN_UPSTREAM_*（过滤 process.env）/ DB_PATH；
 *    剔除 NODE_ENV / npm_config_production / npm_config_omit / OLDPWD / NODESIGN_MCP_SERVERS。
 *  - C2 args：--mode rpc --approve [--provider][--model][--preset] --config-dir .pi
 *    --session-dir <dataRoot>/pi-sessions/<sid> --system-prompt '' --no-extensions
 *    --no-skills --no-prompt-templates --no-themes --no-context-files [--continue]
 *    -e <providers.ts 绝对路径> -e <pi-mcp-adapter/index.ts 绝对路径>（guards.ts M2 才有，不传）。
 *  - C9：spawn 前 ensureProjectPiConfig(workspaceDir, { directTools })。
 *
 * M0 实战经验（server/_probe-pi-rpc.mjs）：
 *  - --config-dir 传相对值 '.pi'（pi 实现是 join(cwd, value)，绝对路径会拼坏）；
 *  - --session-dir normalizePath 直通绝对路径；
 *  - --no-extensions 只禁自动发现，-e 显式挂载的 providers.ts / adapter 照常加载（M0 已验）；
 *  - ⚠️ adapter 必须显式 -e：pi loader 只扫 cwd/.pi/extensions/、agentDir/extensions/ 与
 *    -e 路径，**不**自动加载 agentDir/npm/node_modules/（loader.ts:788-795 实测）。
 *    漏挂 = .pi/mcp.json 无人消费 = Nodesign 工具全丢（M0 探针就是两个 -e 并存的）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sidToken } from './sidecar.js';
import { ensureProjectPiConfig } from './mcp-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Nodesign 侧 pi 资产目录（settings.json / prompt-presets / vendored adapter npm）。 */
const AGENT_DIR = path.join(__dirname, 'agent-dir');
/** 上游 providers 扩展（-e 显式挂载；清单 providers-models.json 由 migrate-models.mjs 生成）。 */
const PROVIDERS_EXT = path.join(__dirname, 'extensions', 'providers.ts');
/** pi-mcp-adapter 扩展（-e 显式挂载；消费 .pi/mcp.json 拉起 standalone MCP 子进程）。 */
const ADAPTER_EXT = path.join(AGENT_DIR, 'npm', 'node_modules', 'pi-mcp-adapter', 'index.ts');
/** AskUserQuestion 扩展（M2 方案 A；-e 显式挂载，registerTool ask_user_question）。 */
const ASK_USER_EXT = path.join(__dirname, 'extensions', 'ask-user.ts');
/** 安全闸扩展（M2：workspace 边界 / 演出隐私 / canvas+site lint；-e 显式挂载）。 */
const GUARDS_EXT = path.join(__dirname, 'extensions', 'guards.ts');
/** 提示词宏扩展（M2：注册 ndPolicy 宏，nodesign.json preset 消费；-e 显式挂载）。 */
const PROMPT_SUPPORT_EXT = path.join(__dirname, 'extensions', 'prompt-support.ts');
/** 懒注入扩展（M2：工具 cookbook 懒注入 + 失败建议 + rate-limit 判别；-e 显式挂载）。 */
const INJECT_EXT = path.join(__dirname, 'extensions', 'inject.ts');

/** C1 剔除项：这些 env 会污染 pi 子进程（NODE_ENV=production 会让依赖走精简路径等）。 */
const ENV_BLACKLIST = [
  'NODE_ENV',
  'npm_config_production',
  'npm_config_omit',
  'OLDPWD',
  'NODESIGN_MCP_SERVERS',
];

/**
 * pi 二进制解析：env PI_BIN（存在则用，支持 pin 特定构建）→ PATH 里的 'pi'。
 * 都找不到抛错带提示（安装指引）。
 */
export function resolvePiBinary() {
  const fromEnv = process.env.PI_BIN;
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv;
    throw new Error(`PI_BIN 指向的文件不存在: ${fromEnv}（取消 PI_BIN 则回退 PATH 里的 pi）`);
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'pi');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 目录不可读等——跳过 */ }
  }
  throw new Error(
    '找不到 pi 可执行文件：设置 PI_BIN 指向 pi 构建产物，或安装 @earendil-works/pi-coding-agent 使 pi 进 PATH',
  );
}

/**
 * 组装 pi 会话子进程的 spawn 四元组。
 *
 * @param {object} opts
 * @param {string} opts.sid           Nodesign sessionId（--session-dir 分目录 + NODESIGN_SID）
 * @param {string} opts.projectId
 * @param {string} opts.ownerId       用户 id（NODESIGN_UID）
 * @param {string} opts.workspaceDir  项目共享工作区绝对路径（<pid>/shared，pi 的 cwd）
 * @param {string} opts.dataRoot      PROJECTS_DATA_ROOT 绝对路径（pi-sessions 落这里）
 * @param {boolean} [opts.resume]     true → --continue（续写同一 session 文件）
 * @param {string} [opts.provider]    pi provider id（providers.ts 注册的上游名）
 * @param {string} [opts.model]       模型 id / pattern
 * @param {string} [opts.presetId]    启动即激活的 preset（一般不传，turn 期 set_preset）
 * @param {number} [opts.port]        主进程 HTTP 端口（sidecar URL）
 * @param {string[]} [opts.directTools]  standalone 注册的全量工具名（C9 mcp.json）
 * @param {string[]} [opts.disabledTools] 项目级禁用工具名（nodesign.config.json tools.disable）；
 *                                        经 NODESIGN_DISABLED_TOOLS env 传给 standalone 子进程，
 *                                        让它整件不注册（否则 directTools 之外的工具仍可经 adapter
 *                                        mcp() 代理调用，禁用形同虚设）
 * @returns {{ binary: string, args: string[], cwd: string, env: object }}
 */
export function sessionLaunch({
  sid, projectId, ownerId, workspaceDir, dataRoot,
  resume = false, provider, model, presetId, port, directTools = [], disabledTools = [],
  adultLevel = 'loose', uncensored = false,
}) {
  if (!sid) throw new Error('sessionLaunch: sid 必填');
  if (!workspaceDir) throw new Error('sessionLaunch: workspaceDir 必填');
  if (!dataRoot) throw new Error('sessionLaunch: dataRoot 必填');

  // C9：spawn 前写项目级 .pi/mcp.json（幂等）
  ensureProjectPiConfig(workspaceDir, { directTools });

  // C2 args
  const args = ['--mode', 'rpc', '--approve'];
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  if (presetId) args.push('--preset', presetId);
  args.push(
    '--config-dir', '.pi',                                        // 相对 cwd（绝对会拼坏）
    '--session-dir', path.join(dataRoot, 'pi-sessions', sid),     // 绝对直通
    '--system-prompt', '',
    '-e', PROVIDERS_EXT,                                          // 上游 providers 扩展
    '-e', ADAPTER_EXT,                                            // MCP adapter（消费 .pi/mcp.json）
    '-e', ASK_USER_EXT,                                           // AskUserQuestion（M2 方案 A）
    '-e', GUARDS_EXT,                                             // 安全闸（M2：边界/隐私/lint）
    '-e', PROMPT_SUPPORT_EXT,                                     // ndPolicy 宏（M2 preset 消费）
    '-e', INJECT_EXT,                                             // 懒注入 + 失败建议 + rate-limit（M2）
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  );
  if (resume) args.push('--continue');

  // C1 env：继承 process.env → 剔除黑名单 → 注入 Nodesign 身份/上游/DB
  const env = { ...process.env };
  for (const key of ENV_BLACKLIST) delete env[key];

  const upstream = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NODESIGN_UPSTREAM_')) {
      if (value != null && value !== '') upstream[key] = value;
      else delete env[key]; // 空值 key 也不带给 pi（providers.ts 按"有值"判断注册）
    }
  }

  // DB_PATH：主进程真实 DB 路径（standalone 的 store.js 多进程 WAL 读）。
  // 逻辑对齐 runs/store.js:34-37（env > 默认 server/db/nodesign.db），但不 import 它
  // ——store.js 顶层即开库，import 进来等于在 lifecycle 模块背上 SQLite 副作用。
  const dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.resolve(__dirname, '../../db/nodesign.db');

  Object.assign(env, {
    PI_CODING_AGENT_DIR: AGENT_DIR,
    PI_TELEMETRY: '0',
    NODESIGN_SID: sid,
    NODESIGN_UID: ownerId ?? '',
    NODESIGN_PROJECT: projectId ?? '',
    NODESIGN_WORKSPACE: workspaceDir,
    NODESIGN_DATA_ROOT: dataRoot,
    NODESIGN_MAIN_URL: `http://127.0.0.1:${port}/__nd-sidecar`,
    NODESIGN_TOKEN: sidToken(sid),
    DB_PATH: dbPath,
    NODESIGN_DISABLED_TOOLS: disabledTools.join(','),
    // M2：政策节渲染维度（prompt-support.ts 的 ndPolicy 宏消费）。spawn 时定，
    // 会话内热换模型不随之变（已知限制，见迁移文档开放项）。
    NODESIGN_ADULT_LEVEL: adultLevel,
    NODESIGN_UNCENSORED: uncensored ? '1' : '',
    ...upstream,
  });

  return { binary: resolvePiBinary(), args, cwd: workspaceDir, env };
}

// ── 孤儿回收 ─────────────────────────────────────────────────────────────────
// 主进程任何路径退出（含崩溃前的信号窗口），都不能把 pi 子进程留在系统里。
// 模块级 Set 记录存活 child；'exit'/'SIGINT'/'SIGTERM' 钩子 SIGKILL 全部。
// 钩子幂等；'exit' 里只允许同步操作（SIGKILL 是同步的）；信号钩子不 process.exit，
// 让 server/index.js 的 graceful shutdown 继续跑（它自己会退出）。

const liveChildren = new Set();
let hooksInstalled = false;

function killAllChildren() {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* 已死——忽略 */ }
    }
  }
  liveChildren.clear();
}

function installOrphanHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', killAllChildren);
  const onSignal = () => killAllChildren();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/**
 * spawn pi 会话子进程（launch = sessionLaunch 的返回值）。
 * stdio 全 pipe：stdin 命令 / stdout JSONL / stderr 诊断。
 */
export function createSessionProcess(launch) {
  installOrphanHooks();
  const child = spawn(launch.binary, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

/** 测试钩子：只读快照（当前存活 child 数）。 */
export function _liveChildCount() {
  return liveChildren.size;
}
