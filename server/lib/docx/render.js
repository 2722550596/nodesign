/**
 * render.js — docx → PDF → PNG 的 QC 渲染链路。
 *
 * 三条已实证的军规全在这里落地：
 *   1. per-run 独立 LO profile + 可写 HOME（多会话并发抢默认 profile 是必然事件）
 *   2. soffice 吃不下中文文件名 → 进场先拷成 ASCII 名
 *   3. FONTCONFIG_FILE 指向 fonts/nodesign-cjk.conf（中文字体替身映射，
 *      per-run 生效，不污染系统 fontconfig）
 */

import { mkdtempSync, cpSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FONTCONF = join(HERE, 'fonts', 'nodesign-cjk.conf');

/**
 * @param {string} docxPath
 * @param {object} opts { pngPages?: [from,to] | true, dpi?: number, keep?: boolean, timeoutMs?: number }
 * @returns {{ pdf: string, pngs: string[], scratch: string, ms: number }}
 *   产物落在独立 scratch 目录里，调用方用完自己收（keep=false 时由调用方 rm scratch）。
 */
export function renderDocx(docxPath, opts = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'ndocx-'));
  const inFile = join(scratch, 'in.docx');       // 军规2：ASCII 文件名
  cpSync(docxPath, inFile);
  const t0 = Date.now();
  const env = {
    ...process.env,
    HOME: scratch,                                // 军规1：可写 HOME
    FONTCONFIG_FILE: FONTCONF,                    // 军规3：字体替身
  };
  execFileSync('soffice', [
    `-env:UserInstallation=file://${scratch}/loprofile`,  // 军规1：独立 profile
    '--headless', '--convert-to', 'pdf', '--outdir', scratch, inFile,
  ], { env, timeout: opts.timeoutMs ?? 120000, stdio: 'pipe' });
  const pdf = join(scratch, 'in.pdf');
  if (!existsSync(pdf)) throw new Error('soffice produced no pdf');
  const pngs = [];
  if (opts.pngPages) {
    const args = ['-png', '-r', String(opts.dpi ?? 120)];
    if (Array.isArray(opts.pngPages)) {
      args.push('-f', String(opts.pngPages[0]), '-l', String(opts.pngPages[1]));
    }
    execFileSync('pdftoppm', [...args, pdf, join(scratch, 'page')], { timeout: 60000 });
    for (const f of readdirSync(scratch).sort()) {
      if (f.startsWith('page-') && f.endsWith('.png')) pngs.push(join(scratch, f));
    }
  }
  return { pdf, pngs, scratch, ms: Date.now() - t0 };
}

export function cleanupRender(res) {
  try { rmSync(res.scratch, { recursive: true, force: true }); } catch { /* 已经没了就算了 */ }
}
