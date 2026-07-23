/**
 * server/ops/fix-sdk-musl.mjs — postinstall：修 SDK musl 误判
 *
 * 现象（DEPLOY.md § 故障排查已档，x64/arm64 都会中）：glibc 系统（Debian/Ubuntu）上
 * SDK platform detection 误判成 musl，spawn `claude-agent-sdk-linux-<arch>-musl/claude`。
 * 该 binary 链接 musl loader（/lib/ld-musl-*），glibc 系统没有 → spawn 失败，
 * SDK 报 "native binary not found"。
 *
 * 修法：musl 包里的 binary 替换成指向同版本 glibc binary 的软链。
 * npm install 会还原 node_modules，所以挂 postinstall 每次自动重打。
 * 非 Linux / musl 系统（Alpine）/ 包不存在时静默跳过。
 */

import { existsSync, lstatSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

if (os.platform() !== 'linux') process.exit(0);
// 真 musl 系统（Alpine）不该动
if (existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1')) process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scope = path.join(root, 'node_modules', '@anthropic-ai');

for (const arch of ['x64', 'arm64']) {
  const glibcBin = path.join(scope, `claude-agent-sdk-linux-${arch}`, 'claude');
  const muslBin = path.join(scope, `claude-agent-sdk-linux-${arch}-musl`, 'claude');
  if (!existsSync(glibcBin) || !existsSync(path.dirname(muslBin))) continue;

  try {
    // 已经是软链就不重打（幂等）
    if (existsSync(muslBin) && lstatSync(muslBin).isSymbolicLink()) continue;
    rmSync(muslBin, { force: true });
    symlinkSync(path.join('..', `claude-agent-sdk-linux-${arch}`, 'claude'), muslBin);
    console.log(`[fix-sdk-musl] linked ${arch}-musl/claude -> ${arch}/claude`);
  } catch (err) {
    console.warn(`[fix-sdk-musl] skip ${arch}: ${err.message}`);
  }
}
