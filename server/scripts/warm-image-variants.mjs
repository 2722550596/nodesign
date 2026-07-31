#!/usr/bin/env node
/**
 * server/scripts/warm-image-variants.mjs — 给存量图预热派生图缓存
 *
 * 为什么需要：generate_image 从 2026-07-31 起会在落盘时把派生图排进后台队列，
 * 但这之前生成的图一张都没有。不预热的话，第一个打开老站点的人要在请求路径上
 * 等每张图现编（单核实测：12 图站点冷开 5.4s，热开 72ms）。
 *
 * 单核机器上这个脚本是有成本的：每张图要编 8 个规格（webp 全尺寸 + 缩略 + 三档
 * 宽度，avif 全尺寸 + 三档宽度），一张 3MB 的 PNG 大约 3 秒。跑之前先看清楚
 * 有多少张（脚本会先报数再问）。
 *
 *   node server/scripts/warm-image-variants.mjs --dry-run    只报数不编
 *   node server/scripts/warm-image-variants.mjs              全量预热
 *   node server/scripts/warm-image-variants.mjs --project proj_xxx
 *   node server/scripts/warm-image-variants.mjs --webp-only  跳过 avif（快 3 倍）
 *
 * 直接调 imageVariant 串行编，不走 enqueueWarm 的后台队列：脚本本来就是前台
 * 任务，用队列反而看不到进度也控制不了退出时机。
 *
 * 安全性：只写 server/.cache/variants/，不碰 projects-data 里任何文件。
 * 中途 Ctrl-C 无副作用，下次接着跑（已编好的走缓存命中，秒过）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  imageVariant, shouldTranscode, warmSpecsFor, RESPONSIVE_WIDTHS,
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY,
} from '../lib/image-variant.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const webpOnly = args.includes('--webp-only');
const onlyProject = args[args.indexOf('--project') + 1] || null;

const DATA_DIR = process.env.PROJECTS_DATA_DIR
  || path.join(process.cwd(), 'server', 'projects-data');

/** 派生图缓存不需要预热派生图；.meta 是 json；隐藏目录一律跳过 */
const SKIP_DIRS = new Set(['.thumbnails', '.meta', '.git', 'node_modules']);

async function collect(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collect(p, out);
    } else if (e.isFile() && shouldTranscode(path.extname(e.name))) {
      try {
        const st = await fs.stat(p);
        out.push({ p, st });
      } catch { /* 扫到一半被删：跳过 */ }
    }
  }
}

const roots = [];
if (onlyProject) {
  roots.push(path.join(DATA_DIR, onlyProject));
} else {
  for (const e of await fs.readdir(DATA_DIR, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith('proj_')) roots.push(path.join(DATA_DIR, e.name));
  }
}

const files = [];
for (const r of roots) await collect(r, files);

const specs = webpOnly
  ? [
      { format: 'webp', maxDim: null },
      { format: 'webp', maxDim: THUMBNAIL_MAX_DIM, quality: THUMBNAIL_QUALITY },
      ...RESPONSIVE_WIDTHS.map(w => ({ format: 'webp', maxDim: w })),
    ]
  : warmSpecsFor();

const totalBytes = files.reduce((t, f) => t + f.st.size, 0);
console.log(`扫到 ${files.length} 张可转码的图，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`每张 ${specs.length} 个规格${webpOnly ? '（跳过 avif）' : ''}，预计 ${(files.length * specs.length * 0.35 / 60).toFixed(1)} 分钟（单核粗估）`);

if (dryRun) {
  for (const f of files.slice(0, 10)) console.log(`  ${path.relative(DATA_DIR, f.p)}`);
  if (files.length > 10) console.log(`  ... 还有 ${files.length - 10} 张`);
  process.exit(0);
}

let done = 0, made = 0, skipped = 0;
const t0 = Date.now();
for (const f of files) {
  for (const s of specs) {
    const r = await imageVariant(f.p, f.st, s);
    r ? made++ : skipped++;
  }
  done++;
  if (done % 5 === 0 || done === files.length) {
    const el = (Date.now() - t0) / 1000;
    const eta = el / done * (files.length - done);
    process.stdout.write(`\r  ${done}/${files.length} 张  已用 ${el.toFixed(0)}s  剩约 ${eta.toFixed(0)}s   `);
  }
}
console.log(`\n完成：${made} 个规格已缓存，${skipped} 个跳过（转出来比原图大 / 源图有问题）`);
