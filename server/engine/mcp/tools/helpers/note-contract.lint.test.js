/**
 * note-contract.lint.test.js — 「退化了必须说」这条契约的看门狗（2026-08-18）
 *
 * `openArtifactPage` 的契约写在它自己的注释里：**note 非空表示没能走成 http，
 * 调用方应该把它写进返回文本**。注释拦不住任何人。
 *
 * ⛔ 实测（2026-08-18 审查）：8 个调用方里只有 1 个照做，另外 5 个工具连
 * `.note` 两个字都没出现过 —— 也就是 07-29 修掉的那个「file:// 静默回退」
 * 病被重新种了一遍。最贵的是 `profile_scroll`：它的描述铁口直断"走 http 同源"，
 * 一旦退回 file://，Resource Timing 报「images 0 files 0KB」正好是它主诊断的
 * 反面，而唯一能解释这件事的 note 被丢在地上。
 *
 * 所以把它变成会失败的测试：import 了 openArtifactPage 的文件，必须也用上
 * degradedNote / .note / viaHttp 里的一个。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');

// projects-data 是**用户数据**（而且里面有断掉的软链，stat 会直接抛），
// db/ 是库文件 —— 只扫源码
const SKIP = new Set(['node_modules', 'projects-data', 'db', 'ms-playwright']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }   // 断软链等
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

describe('openArtifactPage 的 note 契约', () => {
  it('凡是打开产物页的调用方，都要处理"没走成 http"这件事', () => {
    const offenders = [];
    for (const file of walk(path.join(ROOT, 'server'))) {
      const src = readFileSync(file, 'utf8');
      // 定义它的那个文件自己不算
      if (file.endsWith(path.join('helpers', 'perception-page.js'))) continue;
      if (!/\bopenArtifactPage\s*\(/.test(src)) continue;
      const handles = /degradedNote|\.note\b|viaHttp/.test(src);
      if (!handles) offenders.push(path.relative(ROOT, file));
    }
    expect(
      offenders,
      '这些文件打开了产物页但没处理退化提示（file:// 回退会让它们静默给出错答案）：\n'
      + `${offenders.join('\n')}\n`
      + '修法：import { degradedNote } 然后把它拼进返回文本（非空才拼）。',
    ).toEqual([]);
  });
});
