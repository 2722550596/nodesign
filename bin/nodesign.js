#!/usr/bin/env node
/**
 * bin/nodesign.js — 本地分发版入口（`npx nodesign` / `nodesign`）。
 *
 * 做的事只有三件：把 profile 钉成 local、把命令行参数翻译成 env、起服务端后打开浏览器。
 * 所有真正的决策都在 server/runtime/profile.js（数据目录 / 只绑环回 / 托管前端）——这里不复制一份。
 *
 *   nodesign                      # 数据在 ~/.nodesign，http://127.0.0.1:4001
 *   nodesign --port 5000          # 换端口
 *   nodesign --data-dir ./mydata  # 换数据目录（.env / 数据库 / 项目都在里面）
 *   nodesign --no-open            # 不自动开浏览器
 *
 * 钥匙放 <数据目录>/.env：ANTHROPIC_API_KEY=...（或者本机 `claude login` 过，什么都不用填）。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';

const args = process.argv.slice(2);
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
  --data-dir DIR  数据目录：.env / 数据库 / 项目 / 缓存（默认 ~/.nodesign；env NODESIGN_DATA_DIR）
  --host H        监听地址（默认 127.0.0.1；没有登录墙，别改成 0.0.0.0）
  --no-open       启动后不自动打开浏览器
钥匙：<数据目录>/.env 里写 ANTHROPIC_API_KEY=...；或本机已 \`claude login\` 则不用填。`);
  process.exit(0);
}

process.env.NODESIGN_PROFILE = process.env.NODESIGN_PROFILE || 'local';
if (flags.port) process.env.PORT = String(flags.port);
if (flags['data-dir']) process.env.NODESIGN_DATA_DIR = flags['data-dir'];
if (flags.host) process.env.NODESIGN_HOST = flags.host;

await import('../server/index.js');

// 等 /api/health 通了再开浏览器（服务端是异步起的；开早了是一页「无法连接」）
if (!flags.noOpen && process.env.NODESIGN_OPEN !== '0') {
  const port = Number(process.env.PORT || 4001);
  const host = process.env.NODESIGN_HOST || '127.0.0.1';
  const url = `http://${host}:${port}/`;
  const deadline = Date.now() + 15_000;
  const tick = () => {
    const req = http.get(`${url}api/health`, (res) => {
      res.resume();
      if (res.statusCode === 200) return openBrowser(url);
      retry();
    });
    req.on('error', retry);
    req.setTimeout(1000, () => { req.destroy(); });
  };
  const retry = () => { if (Date.now() < deadline) setTimeout(tick, 300).unref(); };
  tick();
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => { console.log(`[nodesign] 打不开浏览器，请手动访问 ${url}`); });
    child.unref();
  } catch {
    console.log(`[nodesign] 打不开浏览器，请手动访问 ${url}`);
  }
}
