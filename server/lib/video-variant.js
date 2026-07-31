/**
 * lib/video-variant.js — 显示用视频派生档
 *
 * 跟 image-variant 同一套规矩：**磁盘上的原片是交付物，一个字节都不改；HTTP
 * 显示路径发压过的派生档。** 导出仍然拷原片。
 *
 * ── 为什么视频比图片更需要这一层 ────────────────────────────────────
 * 一张生图 3MB，一段 10 秒 1080p 的录屏可以是 40MB，而视频是**边下边播**的：
 * 用户拖进度条会触发 Range 请求，播放器还会预取。没有压缩层的话，看一眼站点里
 * 的一段演示视频就能吃掉几十 MB。
 *
 * ── 单核机器上的取舍 ──────────────────────────────────────────────
 * 转码比图片贵一个数量级（一段 1 分钟 1080p 在这台机器上要几分钟），所以：
 *   **请求路径永不转码。** 只查缓存，命中发派生档，没命中原样发原片。
 *   转码一律排后台串行队列，跟图片预热共用同一条"一次只做一件"的纪律。
 *   转码进行中再来请求，照发原片，不等不排队不阻塞。
 *
 * 输出规格：H.264 High + AAC，长边压到 1280，CRF 28，faststart（moov 前置，
 * 否则浏览器要先下完整个文件才能起播）。选 H.264 不选 AV1/VP9 是因为软件编 AV1
 * 在这台机器上是分钟级起步，而 H.264 有成熟的快速预设，画质够用体积也降得动。
 *
 * 缓存：<cacheDir>/videos/<sha1(路径|mtime|size|规格)>.mp4，跟图片同一套 key 口径。
 *
 * fail-soft：ffmpeg 不在 / 转码失败 / 探测失败，一律当作"没有派生档"，发原片。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const CACHE_DIR = path.join(process.cwd(), 'server', '.cache', 'videos');

/** 能转的源格式。都是浏览器能直接放的容器，转出来统一成 mp4 */
const TRANSCODABLE = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv']);

/** 小于这个的不转：几 MB 的短片压不出什么，还白烧几分钟 CPU */
const MIN_SOURCE_BYTES = Number(process.env.NODESIGN_VIDEO_MIN_BYTES) || 3 * 1024 * 1024;

const SPEC = Object.freeze({
  maxDim: Number(process.env.NODESIGN_VIDEO_MAX_DIM) || 1280,
  crf: Number(process.env.NODESIGN_VIDEO_CRF) || 28,
  preset: process.env.NODESIGN_VIDEO_PRESET || 'veryfast',
  audioKbps: 128,
});

const SPEC_TAG = `h264/${SPEC.maxDim}/crf${SPEC.crf}/${SPEC.preset}`;

let ffmpegChecked = null;

/** ffmpeg 在不在。查一次记住，不在就整个模块静默失效 */
export async function hasFfmpeg() {
  if (ffmpegChecked !== null) return ffmpegChecked;
  ffmpegChecked = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  if (!ffmpegChecked) console.warn('[video-variant] ffmpeg 不可用，视频一律发原片');
  return ffmpegChecked;
}

export function isVideo(ext) {
  return TRANSCODABLE.has(String(ext || '').toLowerCase());
}

function cacheKey(absPath, stat) {
  return crypto.createHash('sha1')
    .update(`${absPath}|${stat.mtimeMs}|${stat.size}|${SPEC_TAG}`)
    .digest('hex');
}

function cachePathFor(absPath, stat) {
  return path.join(CACHE_DIR, `${cacheKey(absPath, stat)}.mp4`);
}

/**
 * 有没有现成的派生档。**只查缓存，绝不触发转码。**
 * @returns {Promise<{path: string, size: number}|null>}
 */
export async function cachedVariant(absPath, stat) {
  if (!isVideo(path.extname(absPath))) return null;
  if (stat.size < MIN_SOURCE_BYTES) return null;
  const p = cachePathFor(absPath, stat);
  try {
    const st = await fs.stat(p);
    // 转出来比原片还大就当没有（短片 / 已经压过的片常见）
    if (!st.isFile() || st.size >= stat.size) return null;
    return { path: p, size: st.size };
  } catch { return null; }
}

// ── 后台转码队列 ────────────────────────────────────────────────────
// 串行。单核上两个 ffmpeg 同时跑等于两个都慢一倍，还把请求路径饿死。

const queue = [];
const queued = new Set();
let running = false;
const QUEUE_MAX = 200;

async function transcode(absPath, stat, outPath) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp.mp4`;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', absPath,
    // 长边压到 maxDim，保持比例，宽高都取偶数（H.264 要求）
    '-vf', `scale='if(gt(iw,ih),min(${SPEC.maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${SPEC.maxDim},ih))'`,
    '-c:v', 'libx264', '-preset', SPEC.preset, '-crf', String(SPEC.crf),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${SPEC.audioKbps}k`,
    // moov 前置：不加的话浏览器要下完整个文件才能起播
    '-movflags', '+faststart',
    '-y', tmp,
  ];

  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString().slice(0, 2000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exit ${code}`)));
  });

  const out = await fs.stat(tmp);
  if (out.size >= stat.size) {
    // 没压小就别留着占地方，下次请求照发原片
    await fs.rm(tmp, { force: true });
    console.log(`[video-variant] ${path.basename(absPath)} 压不小（${out.size} ≥ ${stat.size}），丢弃`);
    return;
  }
  await fs.rename(tmp, outPath);
  console.log(`[video-variant] ${path.basename(absPath)} ${(stat.size / 1048576).toFixed(1)}MB → ${(out.size / 1048576).toFixed(1)}MB`);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      queued.delete(job.key);
      try {
        await transcode(job.absPath, job.stat, job.outPath);
      } catch (err) {
        console.warn(`[video-variant] 转码失败 ${path.basename(job.absPath)}: ${err.message}`);
        await fs.rm(`${job.outPath}.${process.pid}.tmp.mp4`, { force: true }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

/**
 * 排一个后台转码。立即返回。已经在队列里 / 已经有缓存 / ffmpeg 不可用都直接跳过。
 */
export async function enqueueTranscode(absPath, stat) {
  if (!isVideo(path.extname(absPath))) return;
  if (stat.size < MIN_SOURCE_BYTES) return;
  if (!await hasFfmpeg()) return;
  const key = cacheKey(absPath, stat);
  if (queued.has(key)) return;
  const outPath = path.join(CACHE_DIR, `${key}.mp4`);
  try { await fs.access(outPath); return; } catch { /* 没有，往下排 */ }
  if (queue.length >= QUEUE_MAX) return;
  queued.add(key);
  queue.push({ absPath, stat, outPath, key });
  drain();
}

export function transcodeQueueStats() {
  return { pending: queue.length, running };
}

/**
 * 发一段视频，支持 Range。
 *
 * Range 对视频是必需的，不是优化：没有 206 的话浏览器拖不动进度条，某些播放器
 * 干脆拒绝播放。这条路由以前只会整个文件 res.end，视频一直是这么半残的。
 *
 * 派生档命中就发派生档，没命中发原片并把转码排进后台。同一个 URL 前后发的字节
 * 会不一样（先原片后派生档），所以 ETag 必须跟着实际发的那份走。
 */
export async function sendVideo(req, res, absPath, stat, opts = {}) {
  let servePath = absPath;
  let size = stat.size;
  let tag = `orig-${stat.mtimeMs}-${stat.size}`;

  const variant = await cachedVariant(absPath, stat);
  if (variant) {
    servePath = variant.path;
    size = variant.size;
    tag = path.basename(variant.path, '.mp4');
  } else {
    enqueueTranscode(absPath, stat).catch(() => {});
  }

  const mime = variant ? 'video/mp4' : (opts.fallbackMime || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', `"${tag}"`);
  res.setHeader('Content-Type', mime);

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    const fh = await fs.open(servePath, 'r');
    return fh.createReadStream().pipe(res).on('close', () => fh.close().catch(() => {}));
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    // `bytes=-N` = 最后 N 字节
    const n = end ?? 0;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  const fh = await fs.open(servePath, 'r');
  return fh.createReadStream({ start, end }).pipe(res).on('close', () => fh.close().catch(() => {}));
}
