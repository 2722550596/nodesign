/**
 * lib/image-variant.js — 显示用图片派生层（webp / avif / 多宽度）
 *
 * 规矩：**磁盘上的原图是交付物，一个字节都不改；HTTP 显示路径一律发派生图。**
 * 导出那三条路（build-standalone 的 inline base64 / PDF-PPTX 的 file:// 渲染 /
 * 站点 zip 的文件拷贝）全部从磁盘直读，不经过任何 HTTP 资源路由，所以最终交付
 * 拿到的永远是原图。这条边界是既有的，本模块只是靠着它站。
 *
 * ── 这台机器只有 1 核 ──────────────────────────────────────────────
 * 所有设计取舍都从这条来。实测（Neoverse-V2 单核，3.1MB PNG 源）：
 *     webp q82 全尺寸  259ms
 *     webp q78 长边512  53ms
 *     avif q55 全尺寸  ~2-4s      ← 绝不能放在请求路径上
 * 所以分两档处理：
 *   **请求路径**只做 webp。冷缓存 259ms 可以忍，且预热之后基本不会发生。
 *   **后台队列**做 avif 和其它宽度档。串行 + 每件之间让出 CPU，不跟请求抢。
 *     队列没编完的规格一律降级发上一档（avif 没有就发 webp），不让用户等。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────
 * <cacheDir>/<sha1(源路径|mtime|size|规格)>.<ext>。key 带 mtime + size，agent
 * 重画同名文件下次请求自然重编码，不需要清缓存这一步。
 *
 * 并发去重：同一 key 同时到 N 个请求只编码一次。站点页面一次能打十几张图，
 * 冷缓存时不去重就是十几个 sharp 管线在 1 个核上互相拖。
 *
 * fail-soft：sharp 任何异常返 null，调用方原样发原图。一张坏图不该变成 500。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';

const CACHE_DIR = path.join(process.cwd(), 'server', '.cache', 'variants');

/**
 * 每种格式的默认质量 + 文件扩展名 + 编码器。
 * avif 的 effort 压到 3（默认 4）：单核上每一档 effort 都是实打实的秒。
 * q55 的 avif 观感约等于 q82 的 webp，体积再小两三成。
 */
const FORMATS = {
  webp: {
    ext: '.webp',
    mime: 'image/webp',
    quality: Number(process.env.NODESIGN_WEBP_QUALITY) || 82,
    encode: (p, q) => p.webp({ quality: q }),
  },
  avif: {
    ext: '.avif',
    mime: 'image/avif',
    quality: Number(process.env.NODESIGN_AVIF_QUALITY) || 55,
    encode: (p, q) => p.avif({ quality: q, effort: 3 }),
  },
};

/**
 * 只转这三种源格式。有意排除的：
 *   .webp — 已经是目标格式之一，再编一遍是二次有损（avif 档另说，见 pickFormat）
 *   .svg  — 矢量，本来就是几 KB 的文本，转成位图是倒退
 *   .gif  — 动图。sharp 要 animated:true 才不丢帧，而 GIF 在这里基本只有表情图，
 *           不值得为它多一条分支；原样发。
 */
const TRANSCODABLE = new Set(['.png', '.jpg', '.jpeg']);

/** 小于这个的不转：编码开销比省下的字节还贵，且小图多半是图标 */
const MIN_SOURCE_BYTES = 4096;

/**
 * 缩略图规格的唯一出处 —— generate_image 落盘时按它编，资源路由给老图现补时
 * 也按它编。两边写各自的数字会让"预生成"和"现补"出两种尺寸的图，而这种不一致
 * 只会表现为某些图偶尔糊一点，没人查得出来。
 * webp q78 的观感约等于原来的 mozjpeg q80，体积再小三成。
 */
export const THUMBNAIL_MAX_DIM = Number(process.env.NODESIGN_THUMBNAIL_MAX_DIM) || 512;
export const THUMBNAIL_QUALITY = Number(process.env.NODESIGN_THUMBNAIL_QUALITY) || 78;

/**
 * ?w= 只认这几档。开放任意宽度等于让任何人用 ?w=1,2,3... 把磁盘刷爆，
 * 而且每多一档就多一份要预热的编码量（单核上这是真钱）。
 * 480 覆盖手机，960 覆盖平板和一般栏宽，1440 覆盖桌面满宽和 2x 的 720。
 */
export const RESPONSIVE_WIDTHS = Object.freeze([480, 960, 1440]);

/** key → Promise<{buf, etag, mime}|null>，编码中的请求挂在同一个 promise 上 */
const inFlight = new Map();

/**
 * 缩略图地址：assets/generated/.thumbnails/<name>.thumb.webp
 * 同时认 .thumb.jpg，因为 2026-07-31 之前发出去的 URL 还在浏览器缓存和已保存的
 * HTML 里流通，而磁盘上那批 .thumb.jpg 已经删了。
 */
const THUMB_RE = /^(.*)[/\\]\.thumbnails[/\\](.+)\.thumb\.(?:webp|jpg)$/;

/** 这个扩展名值不值得转 */
export function shouldTranscode(ext) {
  return TRANSCODABLE.has(String(ext || '').toLowerCase());
}

/**
 * 客户端最想要哪种格式。avif > webp > 原样。
 * 所有现役浏览器发 <img> 请求都会带 Accept；curl / 老客户端不带就走原图。
 */
export function pickFormat(req) {
  const accept = String(req.headers?.accept || '');
  if (accept.includes('image/avif')) return 'avif';
  if (accept.includes('image/webp')) return 'webp';
  return null;
}

/**
 * ?w= 解析。不在白名单里的一律当没传（不报错：这是显示优化，不是 API 契约，
 * 参数写错该退回全尺寸而不是让页面裂图）。
 */
export function parseWidth(req) {
  const w = Number(req.query?.w);
  return RESPONSIVE_WIDTHS.includes(w) ? w : null;
}

/**
 * ?f= 显式指定格式，绕开 Accept 协商。
 *
 * 存在的理由是缓存正确性：按 Accept 协商的响应必须带 Vary: Accept，而中间缓存
 * （包括 Cloudflare 免费版，它只认 Vary: Accept-Encoding）会忽略它，把 avif 喂给
 * 不认 avif 的客户端。URL 里写死格式的响应没有这个歧义，可以放心长缓存。
 *
 * 用在我们自己产的 HTML 上（deck 预览重写、产物墙缩略图）；用户站点的 <img>
 * 不用它，走 Accept 协商，因为站点 HTML 是 agent 写的，不该被我们钉死格式。
 */
export function parseFormat(req) {
  const f = String(req.query?.f || '');
  return FORMATS[f] ? f : null;
}

/**
 * 源文件的版本标记：mtime + size 的短哈希。
 *
 * 用途是让 URL 变成"内容寻址"的：图变了标记就变，URL 就变，于是旧 URL 的缓存
 * 永远不可能是脏的，可以放心发 immutable。
 * 不用真正的内容哈希是因为那要把 3MB 读进来算一遍，而这个值在每次 serve HTML
 * 时都要算一次。mtime + size 已经是变体缓存 key 的一部分，口径一致。
 */
export function versionTag(stat) {
  return crypto.createHash('sha1')
    .update(`${stat.mtimeMs}|${stat.size}`)
    .digest('hex').slice(0, 10);
}

/**
 * 该发什么 Cache-Control。
 *
 * 带 ?v= 的 URL 是内容寻址的（源图一变 v 就变），浏览器可以永久缓存不再回源；
 * 不带的只能短缓存，因为同一个 URL 明天可能是另一张图。
 *
 * 一律 private：这些路由全部要登录，响应里可能是别人看不得的项目内容，
 * 不能让任何共享缓存（含 CDN 边缘）存下来。真要上 CF 边缘缓存得另开一条
 * 公开免鉴权的内容寻址路径，那是隐私决策不是性能决策。
 */
export function imageCacheControl(req) {
  return req.query?.v
    ? 'private, max-age=31536000, immutable'
    : 'private, max-age=300';
}

/** 这个绝对路径是不是在问一张缩略图 */
export function isThumbPath(absPath) {
  return THUMB_RE.test(absPath);
}

/**
 * 缩略图文件不存在时，回头找它的原图。
 *
 * 三种命中场景：① 老图（generate_image 加 thumbnail 流程之前生成的）
 * ② thumbnail 当时生成失败 ③ 2026-07-31 之前的 .thumb.jpg（新地址问 .thumb.webp）。
 * 三种都是同一个处理：拿原图现编一张 512 长边的 webp 缓存下来，等于把当年该生成
 * 的那张现补出来。所以不需要 backfill 脚本。
 *
 * @returns {Promise<string|null>} 原图绝对路径，找不到时 null
 */
export async function findOriginalForThumbnail(absThumbPath) {
  const m = absThumbPath.match(THUMB_RE);
  if (!m) return null;
  const [, parentDir, baseName] = m;
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const candidate = path.join(parentDir, baseName + ext);
    try {
      const s = await fs.stat(candidate);
      if (s.isFile()) return candidate;
    } catch { /* try next ext */ }
  }
  return null;
}

function specOf(format, quality, maxDim) {
  return `${format}/q${quality}/d${maxDim || 0}`;
}

function cacheKey(absPath, stat, spec) {
  return crypto
    .createHash('sha1')
    .update(`${absPath}|${stat.mtimeMs}|${stat.size}|${spec}`)
    .digest('hex');
}

async function encode(absPath, format, quality, maxDim) {
  const raw = await fs.readFile(absPath);
  const meta = await sharp(raw).metadata();
  let pipeline = sharp(raw);
  if (maxDim) {
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    if (longEdge > maxDim) {
      pipeline = pipeline.resize({
        width: (meta.width || 0) >= (meta.height || 0) ? maxDim : null,
        height: (meta.height || 0) > (meta.width || 0) ? maxDim : null,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
  }
  // 不 flatten：webp / avif 都支持 alpha，透明该留着。JPEG 缩略图那条老路必须
  // 铺白底，抠图产物在预览里就带一圈白。
  return FORMATS[format].encode(pipeline, quality).toBuffer();
}

/**
 * 取（或生成）某张图的派生图。
 *
 * @param {string} absPath 源图绝对路径（调用方已做过 traversal 校验）
 * @param {import('node:fs').Stats} stat 源图 stat（调用方已经 stat 过，别重复 IO）
 * @param {{ format?: string, quality?: number, maxDim?: number|null, cacheOnly?: boolean }} [opts]
 *   cacheOnly — 只查缓存，不编码。avif 走这个：单核上现编要几秒，宁可这次发 webp
 *               再让后台补，也不让一张图把请求挂住。
 * @returns {Promise<{ buf: Buffer, etag: string, mime: string }|null>} null = 没有，用上一档
 */
export async function imageVariant(absPath, stat, opts = {}) {
  const format = opts.format || 'webp';
  const conf = FORMATS[format];
  if (!conf) return null;
  const quality = opts.quality ?? conf.quality;
  const maxDim = opts.maxDim ?? null;

  if (!shouldTranscode(path.extname(absPath))) return null;
  if (stat.size < MIN_SOURCE_BYTES) return null;

  const spec = specOf(format, quality, maxDim);
  const key = cacheKey(absPath, stat, spec);
  const cacheFile = path.join(CACHE_DIR, `${key}${conf.ext}`);

  if (opts.cacheOnly) {
    try {
      return { buf: await fs.readFile(cacheFile), etag: key, mime: conf.mime };
    } catch { return null; }
  }

  const hit = inFlight.get(key);
  if (hit) return hit;

  const job = (async () => {
    try {
      return { buf: await fs.readFile(cacheFile), etag: key, mime: conf.mime };
    } catch { /* 冷缓存，往下编 */ }

    try {
      const buf = await encode(absPath, format, quality, maxDim);
      // 编出来比原图还大就别用了（已经压得很好的 JPEG 偶尔会这样）
      if (buf.length >= stat.size) return null;
      await fs.mkdir(CACHE_DIR, { recursive: true });
      // 先写临时名再 rename：并发进程/重启撞在一起时不会读到半截文件
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, cacheFile).catch(() => {});
      return { buf, etag: key, mime: conf.mime };
    } catch (err) {
      console.warn(`[image-variant] ${format} failed for ${path.basename(absPath)}: ${err.message}`);
      return null;
    }
  })().finally(() => { inFlight.delete(key); });

  inFlight.set(key, job);
  return job;
}

// ── 后台预热队列 ────────────────────────────────────────────────────
//
// 单核机器上这个队列必须是串行的，而且每件之间要真的让出 CPU，否则预热会把
// 正在看页面的人卡住。JS 是单线程但 sharp 跑在 libuv 线程池里，1 个核上一次
// 编码就是把核占满，所以"让出"靠的是件与件之间的间隔，不是 await 本身。

/** 队列项：{ absPath, stat, format, quality, maxDim, key } */
const warmQueue = [];
const warmSeen = new Set();
let warmRunning = false;

/** 队列上限：防止一次扫全库把内存撑爆（每项只存路径和数字，很小，但要有底） */
const WARM_QUEUE_MAX = 5000;

/** 每件之间歇多久。单核上这是给请求路径留的口子 */
const WARM_GAP_MS = Number(process.env.NODESIGN_WARM_GAP_MS) || 120;

async function drainWarmQueue() {
  if (warmRunning) return;
  warmRunning = true;
  try {
    while (warmQueue.length) {
      const job = warmQueue.shift();
      warmSeen.delete(job.key);
      try {
        await imageVariant(job.absPath, job.stat, {
          format: job.format, quality: job.quality, maxDim: job.maxDim,
        });
      } catch { /* imageVariant 自己 fail-soft 了，这里只是兜底 */ }
      if (warmQueue.length) await new Promise(r => setTimeout(r, WARM_GAP_MS));
    }
  } finally {
    warmRunning = false;
  }
}

/**
 * 把一张图的若干规格排进后台预热队列。立即返回，不等编码。
 *
 * 谁调用：① generate_image 落盘之后（此时用户正在等模型出下一段话，CPU 闲着）
 *        ② 请求路径发现 avif 没缓存时（这次发 webp，下次就有 avif 了）
 *
 * @param {string} absPath
 * @param {import('node:fs').Stats} stat
 * @param {Array<{format?: string, quality?: number, maxDim?: number|null}>} specs
 */
export function enqueueWarm(absPath, stat, specs) {
  if (!shouldTranscode(path.extname(absPath))) return;
  if (stat.size < MIN_SOURCE_BYTES) return;
  for (const s of specs) {
    const format = s.format || 'webp';
    if (!FORMATS[format]) continue;
    const quality = s.quality ?? FORMATS[format].quality;
    const maxDim = s.maxDim ?? null;
    const key = cacheKey(absPath, stat, specOf(format, quality, maxDim));
    if (warmSeen.has(key)) continue;
    if (warmQueue.length >= WARM_QUEUE_MAX) return;
    warmSeen.add(key);
    warmQueue.push({ absPath, stat, format, quality, maxDim, key });
  }
  drainWarmQueue();
}

/**
 * 一张图的标准预热套餐。
 *
 * 全尺寸 webp 是首屏真正会用到的那张（站点按真实设备宽取景，不缩尺寸）；
 * 512 缩略图给 deck 预览和产物墙；三档响应式宽度给 srcset；avif 各档垫底。
 * 顺序有意：先把请求路径会立刻要的 webp 编完，再慢慢补 avif。
 */
export function warmSpecsFor() {
  const specs = [
    { format: 'webp', maxDim: null },
    { format: 'webp', maxDim: THUMBNAIL_MAX_DIM, quality: THUMBNAIL_QUALITY },
  ];
  for (const w of RESPONSIVE_WIDTHS) specs.push({ format: 'webp', maxDim: w });
  specs.push({ format: 'avif', maxDim: null });
  for (const w of RESPONSIVE_WIDTHS) specs.push({ format: 'avif', maxDim: w });
  return specs;
}

/** 队列现状（预热脚本和 /admin 观测用） */
export function warmQueueStats() {
  return { pending: warmQueue.length, running: warmRunning };
}

/**
 * 资源路由共用的应答收尾：按 Accept 和 ?w= 选最合适的一档发出去。
 *
 * 降级链：avif（只查缓存）→ webp（可现编）→ 原图。
 * avif 没命中时顺手把它排进后台队列，下一个访问者就有了。
 *
 * Vary: Accept 是必须的：同一 URL 对带 image/avif、只带 image/webp、和什么都不带
 * 的客户端返回不同字节，浏览器和任何中间缓存不加 Vary 会串味。
 *
 * @param {object} req
 * @param {object} res
 * @param {string} absPath
 * @param {import('node:fs').Stats} stat
 * @param {{ fallbackMime: string, maxDim?: number|null, quality?: number }} opts
 *   maxDim — 调用方定死的长边（缩略图路径传 512）。为 null 时看 ?w=。
 */
export async function sendImage(req, res, absPath, stat, opts) {
  const maxDim = opts.maxDim ?? parseWidth(req);
  const transcodable = shouldTranscode(path.extname(absPath));
  const forced = transcodable ? parseFormat(req) : null;

  // 只有按 Accept 协商时才需要 Vary。URL 里写死了格式的响应对所有客户端同一份，
  // 加 Vary 只会让缓存白白多分一档。
  //
  // 必须用 res.vary() 追加而不是 setHeader 覆盖：cors 中间件已经设了 Vary: Origin
  // （origin:true 会把请求的 Origin 回显进 Access-Control-Allow-Origin），覆盖掉
  // 它就等于告诉缓存"这个响应跟 Origin 无关"，跨源缓存会拿到别人 Origin 的那份。
  if (!forced) res.vary('Accept');

  const want = forced || (transcodable ? pickFormat(req) : null);

  let variant = null;
  if (want === 'avif') {
    // 单核上 avif 现编要几秒（实测 651ms 起，大图更久），只认缓存。
    // 没有就这次发 webp，同时排后台，下一个访问者就有了。
    variant = await imageVariant(absPath, stat, { format: 'avif', maxDim, cacheOnly: true });
    if (!variant) {
      enqueueWarm(absPath, stat, [{ format: 'avif', maxDim }]);
      // ?f=avif 是调用方点名要的，降级发 webp 会让 Content-Type 跟 URL 说的不一致。
      // 这没问题：客户端信 Content-Type，而且这条路只有我们自己的 HTML 会走。
    }
  }
  if (!variant && want) {
    variant = await imageVariant(absPath, stat, { format: 'webp', maxDim, quality: opts.quality });
  }

  if (variant) {
    if (req.headers['if-none-match'] === `"${variant.etag}"`) return res.status(304).end();
    res.setHeader('ETag', `"${variant.etag}"`);
    res.setHeader('Content-Type', variant.mime);
    res.setHeader('Content-Length', variant.buf.length);
    return res.end(variant.buf);
  }

  res.setHeader('Content-Type', opts.fallbackMime);
  res.setHeader('Content-Length', stat.size);
  return res.end(await fs.readFile(absPath));
}

/**
 * 产物目录里落一份**兄弟 webp**（2026-08-18）。
 *
 * 跟这个模块本来的活刻意分开：派生层落的是 server 缓存、按 HTTP 显示路径发，
 * **磁盘原图一个字节不改**；这个函数落的是产物目录里一个真实文件，因为站点
 * 源码里要 `<img src="...webp">` 引得到它，发布/导出也要带出去。
 *
 * 为什么必须有：落盘一直是 PNG，而 PNG 是无损格式，对摄影级生成图是最差选择。
 * 一个站引了 15 张生成图 = 33.7MB，转 webp q82 之后 1.1MB（3%），视觉看不出
 * 差别，滚动掉帧从 63% 降到 9%。这个损失同时打在首屏、帧率和导出包体积上。
 *
 * 质量跟派生层同一个 q82（同一个常量，不另立第二个数字）。
 * @returns {Promise<{rel: string, bytes: number}|null>} null = 编不出来（不致命）
 */
export async function writeWebpSibling(absPng, buf, relDir) {
  if (!/\.png$/i.test(absPng)) return null;
  const absWebp = absPng.replace(/\.png$/i, '.webp');
  try {
    const out = await sharp(buf).webp({ quality: FORMATS.webp.quality }).toBuffer();
    await fs.writeFile(absWebp, out);
    return { rel: `${relDir}/${path.basename(absWebp)}`, bytes: out.length };
  } catch (err) {
    console.warn('[image-variant] 兄弟 webp 没编出来（不影响主流程）:', err.message);
    return null;
  }
}
