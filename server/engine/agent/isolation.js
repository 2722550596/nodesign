/**
 * agent/isolation.js —— 会话隔离配置的单一来源（2026-08-15）
 *
 * 一件事被拆成两道闸，因为 SDK 的工具分两拨跑：
 *
 *   ① sandbox  → **只管 Bash**。bwrap 起独立 mount/net namespace：写只落工作区、
 *                 凭据读不到、env 里的 key 被 unset、AF_UNIX 与回环被切断、
 *                 外网走代理。开关在 runtime/platform.js（NODESIGN_SANDBOX=on）。
 *   ② settings.permissions.deny → 管 **Read / Grep / Glob / Write / Edit**。
 *                 这些是 SDK 进程内工具，根本不进 bwrap，沙盒对它们零作用。
 *
 * 缺一半等于没关。第三块（跨项目边界）在 hooks/pre-workspace-scope-guard.js ——
 * deny 规则写不出"除了自己这个项目"（deny 压过 allow，项目又是动态新建的）。
 *
 * 08-15 开这套时真跑出来的四件事，改之前先读：
 *   1. `dangerouslyDisableSandbox` 默认允许，agent 撞到偶发失败会自己拿它关沙盒
 *      —— 必须 allowUnsandboxedCommands:false 焊死。
 *   2. deny 规则的路径必须是**双斜杠**绝对形式，单斜杠静默失效。
 *   3. npm 默认缓存在 ~/.npm，沙盒里 HOME 不可写 → `npm i` EROFS，构建道整条断。
 *   4. 目录级 denyRead 拦得住读文件，拦不住 `ls` 看文件名（接受：名字不是秘密）。
 */

import path from 'node:path';
import { platform } from '../../runtime/platform.js';
import { autoModeSettings } from './auto-mode-rules.js';

/**
 * bwrap 垫片的 env（PATH 前插一个目录，里面的 `bwrap` 是我们的包装脚本）
 *
 * 治的是 `apply-seccomp: unshare(CLONE_NEWUSER): Invalid argument` 这个偶发
 * —— 内核级竞态，机器越闲越容易撞，实测每十几次 Bash 调用炸一次，而且会把
 * agent 带进错误推断。原理与安全不变量写在 server/ops/sandbox-shim/bwrap 里。
 * 关掉：`NODESIGN_SANDBOX_SHIM=off`。
 */
export function sandboxShimEnv({ baseEnv = process.env, dataRoot } = {}) {
  if (!platform.sandboxEnabled) return {};
  if (process.env.NODESIGN_SANDBOX_SHIM === 'off') return {};
  const dir = path.join(platform.repoRoot, 'server', 'ops', 'sandbox-shim');
  return {
    PATH: `${dir}${path.delimiter}${baseEnv.PATH || ''}`,
    // 改写次数记一笔：SDK 升级后 pattern 变了会静默退回现状，靠这个计数发现
    ...(dataRoot ? { NODESIGN_SHIM_LOG: path.join(dataRoot, '.sandbox-shim.log') } : {}),
  };
}

/**
 * @param {object} o
 * @param {string} o.cwdRoot       会话工作区（= sharedRoot，扁平化之后同一个目录）
 * @param {string} o.sharedRoot    项目共享根
 * @param {string} o.npmCacheDir   共用 npm 缓存（在数据根下，必须可写可读）
 * @param {string} o.dataRoot      PROJECTS_DATA_ROOT
 * @param {object} o.env           传给 SDK 的 env（凭据抹除按它的键名算）
 * @returns {{ sandbox: object, settings: object }} 直接摊进 query options
 */
export function buildIsolationOptions({ cwdRoot, sharedRoot, npmCacheDir, dataRoot, env }) {
  return {
    sandbox: {
      enabled: platform.sandboxEnabled,
      failIfUnavailable: false,
      // ⭐ 逃生门焊死：SDK 给 Bash 留了 `dangerouslyDisableSandbox` 参数，**默认允许**。
      // 08-15 开沙盒当天就被 agent 自发用上了 —— 它撞到 apply-seccomp 偶发失败，
      // 第三次自己带上这个参数关掉沙盒，然后读到了隔壁项目的文件（它老实汇报了，
      // 所以我们看见了）。一个能被工具参数关掉的沙盒等于没有沙盒。
      allowUnsandboxedCommands: false,
      network: {
        allowLocalBinding: false,
        // 全域允许：这层留着不是为了管出口，是为了 Linux 上顺带切断 unix socket
        // —— pm2 的 rpc.sock 就在家目录里，通了的话 `pm2 start` 能起一个沙盒外的
        // 进程（完整逃逸）。只读挂载拦不住 socket 连接，实测过。
        allowedDomains: ['*'],
      },
      filesystem: {
        allowWrite: [
          cwdRoot,
          ...(sharedRoot ? [
            path.join(sharedRoot, '.claude', 'agent-memory'),
            path.join(sharedRoot, 'assets'),
          ] : []),
          npmCacheDir,
        ],
        denyWrite: ['/etc', '/usr', '/bin', '/sbin', '/private/etc'],
        // 数据根整个盖住、再用 allowRead 给自己的工作区开天窗 —— 这样在沙盒里
        // 连 `ls 数据根` 都只看得见自己那一个条目（08-15 实测）。
        denyRead: [...platform.credentialBlacklist(), dataRoot],
        allowRead: [cwdRoot, npmCacheDir],
      },
      credentials: {
        // filesystem 那层拦得住 `cat .env`，拦不住 `env` —— 服务端 process.env
        // 原样继承给了 Bash 子进程，key 就明晃晃躺着。按名字在沙盒内 unset。
        envVars: platform.secretEnvVarNames(env).map(name => ({ name, mode: 'deny' })),
      },
    },
    settings: {
      permissions: { deny: platform.protectedPathRules({ dataRoot }) },
      // auto 模式的分类器规则（只在开了 auto 时注入，省得白占 settings）。
      // ⚠️ 按节替换不是追加 —— 为什么只覆盖 environment / hard_deny 两节，
      // 见 auto-mode-rules.js 文件头。
      ...(platform.autoModeEnabled ? { autoMode: autoModeSettings() } : {}),
    },
  };
}
