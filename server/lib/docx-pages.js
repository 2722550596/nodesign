/**
 * lib/docx-pages.js — .docx 的页图（画布缩略图 + 产物窗翻页都吃这一份）
 *
 * ## 一次渲染，全篇入缓存
 *
 * LibreOffice 起一次要几百毫秒和一两百 MB，**但它一次就能出整份 PDF** ——
 * 所以缓存的粒度是「一份文档的所有页」，不是「一页」。打开一份 20 页的文档
 * 花的是一次渲染，翻页零成本。按页渲染的话翻一页起一次 soffice，1 vCPU 上
 * 会被翻页操作打死。
 *
 * ## 缓存
 *
 * `<cacheDir>/<sha1(路径|mtime|size|dpi)>/page-N.png` + `meta.json`。
 * key 带 mtime + size —— agent 一 rebuild，key 就变，自然重渲，不需要主动失效。
 * 旧目录留着不清（跟 covers / variants 同口径）。
 *
 * ## 并发
 *
 * 两道：**同一份文档的并发请求合并成一次渲染**（in-flight 去重，这条最值钱 ——
 * 一扇窗打开会同时请求首页缩略图和当前页），以及一个总闸。总闸先给宽松值，
 * 真跑出问题再收 —— 这台机器 1 vCPU / 8G 无 swap，soffice 峰值实测 171MB。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { renderDocx, cleanupRender } from './docx/render.js';

const CACHE_DIR = path.join(process.cwd(), 'server', '.cache', 'docx-pages');

/** 缓存的渲染精度。缩略图从这份缩，不另跑 LibreOffice */
const CACHE_DPI = 120;

/** 总并发闸。先宽松，真撞上再收 */
const MAX_CONCURRENT = 3;

let running = 0;
const waiters = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
  running += 1;
  try { return await fn(); } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

/** 同一份文档正在渲的那次（key → Promise），合并并发请求 */
const inflight = new Map();

function keyOf(absPath, stat) {
  return crypto.createHash('sha1')
    .update(`${absPath}|${stat.mtimeMs}|${stat.size}|${CACHE_DPI}`)
    .digest('hex');
}

/**
 * 确保这份 docx 的所有页图在缓存里。
 * @returns {Promise<{ dir: string, count: number }>}
 */
export async function ensurePages(absPath) {
  const stat = await fs.stat(absPath);
  const key = keyOf(absPath, stat);
  const dir = path.join(CACHE_DIR, key);

  // 已经渲过
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (meta?.count > 0) return { dir, count: meta.count };
  } catch { /* 没缓存，往下渲 */ }

  if (inflight.has(key)) return inflight.get(key);

  const job = withSlot(async () => {
    // 拿到槽位之后再查一遍 —— 排队期间别人可能已经渲完了
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (meta?.count > 0) return { dir, count: meta.count };
    } catch { /* 确实没有 */ }

    const res = await renderDocx(absPath, { pngPages: true, dpi: CACHE_DPI });
    try {
      await fs.mkdir(dir, { recursive: true });
      let n = 0;
      for (const png of res.pngs) {
        n += 1;
        await fs.copyFile(png, path.join(dir, `page-${n}.png`));
      }
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ count: n, dpi: CACHE_DPI, ms: res.ms }));
      return { dir, count: n };
    } finally {
      await cleanupRender(res);
    }
  }).finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/**
 * 取一页的图。
 * @param {string} absPath  .docx 绝对路径
 * @param {number} page     1-based
 * @param {{width?:number}} opts  给了 width 就缩到这个宽度并转 webp（缩略图用）
 * @returns {Promise<{ buf: Buffer, mime: string, count: number }>}
 */
export async function pageImage(absPath, page, opts = {}) {
  const { dir, count } = await ensurePages(absPath);
  if (!count) throw Object.assign(new Error('这份文档渲染出来是空的'), { status: 422 });
  const n = Math.min(Math.max(1, Number(page) || 1), count);
  const src = path.join(dir, `page-${n}.png`);

  if (!opts.width) {
    return { buf: await fs.readFile(src), mime: 'image/png', count };
  }
  // 缩略图从缓存的大图缩 —— 不为了小一号再起一次 LibreOffice
  const { default: sharp } = await import('sharp');
  const buf = await sharp(src).resize({ width: Math.round(opts.width), withoutEnlargement: true })
    .webp({ quality: 82 }).toBuffer();
  return { buf, mime: 'image/webp', count };
}

/** 页数（窗口要用它画翻页控件）。会触发渲染，跟取图共用缓存和闸门 */
export async function pageCount(absPath) {
  return (await ensurePages(absPath)).count;
}
