/**
 * server/runtime/platform.js — 跨平台决策的单一来源
 *
 * 设计原则：所有跟 OS / 工具 / 外部状态相关的决策**只在这里做**。
 * 业务文件（session-loop.js / session-loop.js / sessions.js / workspace.js）
 * 通过 `import { platform } from '../runtime/platform.js'` 读决策结果，
 * 不再自己 `process.env.HOME || os.homedir()` 拼凑。
 *
 * 为什么需要这个文件：
 *   2026-05 Linux 服务器部署踩到 3 类跨平台坑：
 *     1. CLAUDE_CONFIG_DIR per-session vs 全局（SDK 设计假设全局）
 *     2. bwrap sandbox 不解析 symlink（Mac sandbox-exec 没事）
 *     3. WebFetch preflight 假设 OAuth token 存在（gateway key 模式没 OAuth）
 *   每个坑都涉及多文件改动且容易漏。集中后增/改决策只改这一个文件。
 *
 * 启动建议：在 server/index.js 早期调 `platform.dump()` 打日志，
 *   运维一眼能看到当前平台/路径/sandbox/preflight 配置。
 */

import os from 'node:os';
import path from 'node:path';

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/**
 * CLAUDE 配置目录（SDK JSONL / settings 的全局根）
 *
 * SDK binary 把 session JSONL 落到 `<configDir>/projects/<encoded-cwd>/<sid>.jsonl`，
 * encoded-cwd = sessionRoot.replace(/[^a-zA-Z0-9]/g, '-')。这个路径是 SDK 内部
 * 硬编码（不能 per-session 自定义）—— 所有 NoDesign session 必须共用一个 configDir，
 * 通过不同 cwd 的编码自然分隔。
 *
 * NODESIGN_CONFIG_DIR 可显式覆盖（容器化 / 多实例共享持久化卷场景）。
 */
const claudeConfigDir = process.env.NODESIGN_CONFIG_DIR
  || path.join(process.env.HOME || os.homedir(), '.claude');

/**
 * Sandbox 是否开启
 *
 * 现状（2026-05）：暂关。
 *   - Linux bwrap 不解析 session root 中的 symlink → agent Glob/Read 看不到
 *     assets/ agent-memory/（它们是 symlink → shared/）。等 SDK 修复或自己实现
 *     readlink → additionalDirectories work around。
 *   - Mac sandbox-exec 没 symlink 问题，但默认也关 —— 保持 dev/prod 行为一致，
 *     避免本地能跑、上线炸的"我本地能跑啊"陷阱。
 *
 * 开发要验证 sandbox 时显式打开：`NODESIGN_SANDBOX=on npm start`
 */
const sandboxEnabled = process.env.NODESIGN_SANDBOX === 'on';

/**
 * WebFetch preflight 是否跳过
 *
 * SDK binary 内置 `nV7()` preflight：调 Anthropic 服务器侧域名分类 API（需 OAuth
 * claude.ai 登录态）。NoDesign 走 API key gateway（NODESIGN_GATEWAY_KEY）模式
 * 不存在 OAuth → preflight 永远 check_failed → DomainCheckFailedError
 * "Unable to verify if domain X is safe to fetch ... blocking claude.ai"。
 *
 * skipWebFetchPreflight 是 SDK 官方为 enterprise / 自托管场景留的开关。
 * 我们走 gateway 模式 → 永远关。
 */
const skipWebFetchPreflight = true;

/**
 * 凭据/敏感目录黑名单（用于 SDK sandbox.deny 配置）
 *
 * 函数形式（不是常量）—— 因为 sandbox.deny 在 spawn SDK 子进程时才计算，
 * 此时如果 HOME env 被改了（比如 ecosystem 显式传 HOME=/home/nodesign），
 * 应该读改后的 homedir。
 */
function credentialBlacklist() {
  const home = os.homedir();
  return [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gh'),  // GitHub CLI token
    '/etc/shadow',
    '/etc/passwd',
    '/etc/sudoers',
  ];
}

/**
 * 启动时 dump 平台决策到日志
 *
 * 让运维一眼看到：当前进程跑在什么 OS / HOME 是什么 / claudeConfigDir 指哪 /
 * sandbox 开没开 / preflight 关没关。Linux 服务器排查问题的第一信号。
 */
function dump() {
  const info = {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    home: os.homedir(),
    claudeConfigDir,
    sandboxEnabled,
    skipWebFetchPreflight,
  };
  console.log('[platform]', JSON.stringify(info, null, 2));
  return info;
}

export const platform = {
  isLinux,
  isMac,
  isWin,
  claudeConfigDir,
  sandboxEnabled,
  skipWebFetchPreflight,
  credentialBlacklist,
  dump,
};
