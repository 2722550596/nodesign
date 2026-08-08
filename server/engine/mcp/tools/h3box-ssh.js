/**
 * mcp/tools/h3box-ssh.js — GPU 盒子 SSH 公用件（roll_film / paint_still 共用）
 *
 * 盒子 = featurize 按时租的 5090（.env NODESIGN_H3BOX_SSH/PORT/PASS，每次租机
 * 都换）。密码走 sshpass -e（SSHPASS 环境变量），没配密码就当 key 认证。
 */

import { spawn } from 'node:child_process';

export function boxConfig() {
  const target = process.env.NODESIGN_H3BOX_SSH || '';
  if (!target) return null;
  return {
    target,
    port: process.env.NODESIGN_H3BOX_PORT || '22',
    pass: process.env.NODESIGN_H3BOX_PASS || '',
  };
}

/** POSIX 单引号转义（远端 zsh/bash 规则相同） */
export const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * 跑一条 ssh/scp。永不 throw，resolve {code, out, err}；code=-1 表示本地 spawn 失败。
 * @param {{target:string,port:string,pass:string}} box
 * @param {'ssh'|'scp'} bin
 */
export function runBox(box, bin, args, { timeoutMs = 240_000, signal } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    let cmd = bin; let argv = args;
    if (box.pass) {
      env.SSHPASS = box.pass;
      cmd = 'sshpass'; argv = ['-e', bin, ...args];
    }
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, out, err });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
  });
}

/** ssh 公共参数（-p 端口）；scp 用 scpArgs（-P 端口） */
export const sshArgs = (box) => ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-p', box.port, box.target];
export const scpArgs = (box) => ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-P', box.port];
