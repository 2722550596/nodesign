#!/usr/bin/env node
/**
 * bin/nodesign.js — 本地分发版入口（`npx nodesign` / `nodesign`）。
 *
 * 它是一个很薄的 supervisor：把 profile 钉成 local、把命令行参数翻译成 env、拉起 server/index.js 子进程、
 * health 通了开一次浏览器；子进程以 RESTART_EXIT_CODE（75，见 server/api/local.js）退出就重新拉起——
 * 配置页「保存并重启」走的就是这条路。所有真正的决策都在 server/runtime/profile.js，这里不复制一份。
 *
 *   nodesign                      # 数据在 ~/.nodesign，http://127.0.0.1:4001
 *   nodesign --port 5000          # 换端口
 *   nodesign --data-dir ./mydata  # 换数据目录（.env / config.json / 数据库 / 项目都在里面）
 *   nodesign --no-open            # 不自动开浏览器
 *   nodesign login                # M1 起已停用：提示无需 claude login 后退出
 *
 * 钥匙放 <数据目录>/.env：ANTHROPIC_API_KEY=...（或者本机 `claude login` 过，什么都不用填）；
 * 自己的模型插槽放 <数据目录>/config.json（形状见 server/runtime/local-config.js）。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART_EXIT_CODE = 75;
const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/index.js');

const args = process.argv.slice(2);

// 子命令：`nodesign login` / `logout` / `auth` —— M1 起不再内置 Claude CLI（SDK 已拆），
// 订阅通道也已停用；老习惯敲进来给个明白话再退出。
if (['login', 'logout', 'auth'].includes(args[0])) {
  console.error('[nodesign] M1 起不再内置 Claude CLI，订阅通道也已停用；无需 claude login。');
  process.exit(1);
}

const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { flags.help = true; continue; }
  if (a === '--no-open') { flags.noOpen = true; continue; }
  if (a === '--open') { flags.noOpen = false; continue; }
  const m = /^--(port|data-dir|host)(?:=(.*))?$/.exec(a);
  if (m) {
    const v = m[2] !== undefined ? m[2] : args[++i];
    if (v === undefined) { console.error(`--${m[1]} 需要一个值`); process.exit(2); }
    flags[m[1]] = v;
    continue;
  }
  console.error(`不认识的参数：${a}（--help 看用法）`);
  process.exit(2);
}

if (flags.help) {
  console.log(`用法：nodesign [--port N] [--data-dir DIR] [--host H] [--no-open]
  --port N        监听端口（默认 4001；env PORT）
  --data-dir DIR  数据目录：.env / config.json / 数据库 / 项目 / 缓存（默认 ~/.nodesign；env NODESIGN_DATA_DIR）
  --host H        监听地址（默认 127.0.0.1；没有登录墙，别改成 0.0.0.0）
  --no-open       启动后不自动打开浏览器
  login / logout / auth status   Claude 订阅登录态（不用另装 claude CLI）
钥匙：<数据目录>/.env 里写 ANTHROPIC_API_KEY=...；或本机已 \`claude login\` 则不用填。`);
  process.exit(0);
}

const env = { ...process.env };
env.NODESIGN_PROFILE = env.NODESIGN_PROFILE || 'local';
if (flags.port) env.PORT = String(flags.port);
if (flags['data-dir']) env.NODESIGN_DATA_DIR = flags['data-dir'];
if (flags.host) env.NODESIGN_HOST = flags.host;

const host = env.NODESIGN_HOST || '127.0.0.1';
// 端口：用户指定了（--port / PORT）就用它，被占就报错退出；没指定则从 4001 往上找第一个空的
// （4001 在别人机器上常有主——Cursor、QQ 都见过——让用户自己换端口不如自己让一步）
const port = await pickPort(env.PORT ? Number(env.PORT) : null);
env.PORT = String(port);
const url = `http://${host}:${port}/`;

async function pickPort(wanted) {
  const free = (p) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(p, host, () => srv.close(() => resolve(true)));
  });
  if (wanted) {
    if (await free(wanted)) return wanted;
    console.error(`[nodesign] 端口 ${wanted} 已被占用（查占用：${process.platform === 'win32' ? `netstat -ano | findstr :${wanted}` : `lsof -i :${wanted}`}）`);
    process.exit(1);
  }
  for (let p = 4001; p < 4001 + 50; p++) {
    if (await free(p)) {
      if (p !== 4001) console.log(`[nodesign] 4001 被占用，改用端口 ${p}`);
      return p;
    }
  }
  console.error('[nodesign] 4001～4050 全被占用，用 --port 指定一个');
  process.exit(1);
}
let opened = false;
let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [serverEntry], { env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (code === RESTART_EXIT_CODE) {
      console.log('[nodesign] 服务端请求重启，重新拉起…');
      start();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
  if (!opened && !flags.noOpen && env.NODESIGN_OPEN !== '0') waitHealthThenOpen();
}

// 等 /api/health 通了再开浏览器（开早了是一页「无法连接」）。只开一次：重启后页面自己会刷新
function waitHealthThenOpen() {
  const deadline = Date.now() + 20_000;
  const tick = () => {
    if (opened || !child) return;
    const req = http.get(`${url}api/health`, (res) => {
      res.resume();
      if (res.statusCode === 200) { opened = true; openBrowser(url); return; }
      retry();
    });
    req.on('error', retry);
    req.setTimeout(1000, () => { req.destroy(); });
  };
  const retry = () => { if (Date.now() < deadline) setTimeout(tick, 300).unref(); };
  tick();
}

function openBrowser(target) {
  const cmd = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
      : ['xdg-open', [target]];
  try {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    p.on('error', () => { console.log(`[nodesign] 打不开浏览器，请手动访问 ${target}`); });
    p.unref();
  } catch {
    console.log(`[nodesign] 打不开浏览器，请手动访问 ${target}`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig); else process.exit(0);
  });
}

start();
