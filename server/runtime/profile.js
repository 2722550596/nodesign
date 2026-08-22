/**
 * server/runtime/profile.js — 部署形态（profile）的单一来源。**必须是 server/index.js 的第一个 import**。
 *
 * 两种形态（2026-08-22 用户拍板）：
 *   - hosted：线上多用户站（登录墙 / 档位 / 额度 / 外审 / 邀请码 / 管理台）。不设 NODESIGN_PROFILE 就是它，
 *             生产 .env 一个字不用改。
 *   - local ：本地分发版（npx 起在用户自己机器上）。**默认单租户**：登录墙钉死关闭、请求者恒为本机 admin
 *             （auth/users-store.js LOCAL_OWNER）、SaaS 那套界面由前端按 /api/auth/status 的 profile 藏起来。
 *             代码不删，只是藏 —— 同一份代码两种形态，靠这里一个开关分岔。
 *
 * 为什么要抢在所有 import 之前跑：DB_PATH / PROJECTS_DATA_DIR / WORKSPACE_DIR 这些都是各模块**加载时**从
 * process.env 读一次就冻结的（store.js / workspace.js / runtime/workspace.js）。本地版要把它们整体挪到
 * 用户数据目录（默认 ~/.nodesign），唯一不改那些模块的办法就是在它们加载前把 env 的默认值填好。
 * ESM 按 import 顺序深度优先求值，所以 index.js 第一行 import 本文件即可保证顺序。
 *
 * 本地版的 .env 住在数据目录（<dataRoot>/.env），不住仓库根：npx 装出来的包目录不是用户该碰的地方。
 * 已在进程 env 里的值不被文件覆盖（跟 node --env-file 同语义），命令行/bin 传的参数优先。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROFILES = Object.freeze(['hosted', 'local']);
const raw = process.env.NODESIGN_PROFILE || 'hosted';
if (!PROFILES.includes(raw)) {
  // 拼错不许静默落成 hosted：local 拼成 locl 会把一台笔记本的 4001 端口开到 0.0.0.0 且没有登录墙
  throw new Error(`NODESIGN_PROFILE=${raw} 不认识，只能是 ${PROFILES.join(' | ')}`);
}

export const profileName = raw;
export const isLocal = raw === 'local';

/** 本地版数据根；hosted 下不用（各路径仍按老规矩各自取 env / 仓库相对路径） */
export const dataRoot = isLocal
  ? path.resolve(process.env.NODESIGN_DATA_DIR || path.join(os.homedir(), '.nodesign'))
  : null;

function setDefault(name, value) {
  if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
}

if (isLocal) {
  fs.mkdirSync(dataRoot, { recursive: true });
  // 用户配置（钥匙等）：<dataRoot>/.env。不存在就算了，存在但格式坏要炸（别静默跑成没钥匙）
  const envFile = path.join(dataRoot, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  setDefault('DB_PATH', path.join(dataRoot, 'nodesign.db'));
  setDefault('PROJECTS_DATA_DIR', path.join(dataRoot, 'projects'));
  setDefault('WORKSPACE_DIR', path.join(dataRoot, 'runs'));
  setDefault('ARTIFACT_DIR', path.join(dataRoot, 'runs'));
  setDefault('NODESIGN_CACHE_DIR', path.join(dataRoot, 'cache'));
}

/** 服务端缓存根（封面 / 图片变体 / 视频变体 / docx 页图）。hosted = 仓库 server/.cache（与 pm2 cwd=仓库根时的老值相同） */
export const cacheRoot = process.env.NODESIGN_CACHE_DIR
  ? path.resolve(process.env.NODESIGN_CACHE_DIR)
  : path.join(repoRoot, 'server', '.cache');

/** 监听地址。本地版只绑环回（没有登录墙，绝不能上 0.0.0.0）；hosted 不传 = Node 默认全地址，nginx 在前面 */
export const listenHost = process.env.NODESIGN_HOST || (isLocal ? '127.0.0.1' : undefined);

/** 是否由 Node 直接托管前端构建产物（hosted 由 nginx 发 dist，这里关；本地版没有 nginx，开） */
export const serveWeb = process.env.NODESIGN_SERVE_WEB
  ? process.env.NODESIGN_SERVE_WEB === '1'
  : isLocal;
export const webDistDir = path.join(repoRoot, 'web', 'dist');

export const profile = Object.freeze({ name: profileName, isLocal, dataRoot, cacheRoot, listenHost, serveWeb, webDistDir });
