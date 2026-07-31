/**
 * lib/html-srcset.js — 给站点 HTML 的 <img> 注入 srcset
 *
 * 问题：agent 写的站点是 `<img src="assets/x.png">`，手机上也照发 1536px 宽的原图。
 * 站点按真实设备宽取景，服务端不能自作主张缩尺寸（缩了桌面就糊），所以只能把
 * "有哪些尺寸可选"告诉浏览器，让它按视口和 DPR 自己挑。
 *
 * 做法：只加属性，**不改 DOM 结构**。
 *
 *   <img src="assets/x.png">
 *   →
 *   <img src="assets/x.png?v=ab12ef" sizes="100vw"
 *        srcset="assets/x.png?w=480&v=ab12ef 480w, assets/x.png?w=960&v=ab12ef 960w, assets/x.png 1536w">
 *
 * **为什么不用 <picture>**：<picture> 能按 type 分发 avif/webp 且不需要 Vary，
 * 技术上更优。但它要在 <img> 外面套一层元素，而站点 HTML 是 agent 写的，
 * `.grid > img` 这类直接子选择器会失配，img 作为 grid/flex item 时盒子也会变成
 * picture（默认 inline）导致布局位移。为了压几十 KB 去动别人的布局不划算。
 * 所以格式仍走 Accept 协商（响应带 Vary: Accept），这里只管尺寸。
 *
 * sizes 的取值：默认 100vw。这是"高估"的一侧 —— 浏览器会挑偏大的那档，省得少
 * 但绝不会糊。反过来低估会让图变糊，那是肉眼可见的质量事故。真正的收益在移动端：
 * 480 CSS px 的手机按 DPR 2 只需要 960w，不再拉 1536。img 自己写了 width 属性或
 * 内联 px 宽度时按它算，那是 agent 明确表达过的意图，比默认值准。
 *
 * 跳过的情况：已有 srcset（agent 自己写过）、非本地相对路径（http/data/协议相对）、
 * 拿不到原图尺寸、原图本来就比最小那档还窄。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { RESPONSIVE_WIDTHS, shouldTranscode, versionTag } from './image-variant.js';

/** 图片元数据缓存：绝对路径 → { key, width, height, v }。key 带 mtime+size，源变了自然失效 */
const metaCache = new Map();
const META_CACHE_MAX = 2000;

async function imageMeta(absPath) {
  let stat;
  try {
    stat = await fs.stat(absPath);
    if (!stat.isFile()) return null;
  } catch { return null; }

  const key = `${stat.mtimeMs}|${stat.size}`;
  const hit = metaCache.get(absPath);
  if (hit && hit.key === key) return hit;

  let meta;
  try {
    meta = await sharp(await fs.readFile(absPath)).metadata();
  } catch { return null; }
  if (!meta?.width) return null;

  const entry = { key, width: meta.width, height: meta.height || 0, v: versionTag(stat) };
  if (metaCache.size >= META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
  metaCache.set(absPath, entry);
  return entry;
}

/** <img ...> 整标签。属性值里不会出现 '>' 的常规写法，够用且不引入 HTML parser 依赖 */
const IMG_TAG_RE = /<img\b([^>]*)>/gi;

function attrOf(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3] ?? '') : null;
}

/**
 * 这个 img 打算显示多宽（CSS px）。拿不准返 null，调用方退回 100vw。
 * 只认 width 属性和内联 style 里的 px 宽度，百分比 / vw / rem 一律不猜。
 */
function declaredWidth(attrs) {
  const w = attrs.match(/\bwidth\s*=\s*["']?(\d+)/i);
  if (w) return Number(w[1]);
  const style = attrOf(attrs, 'style');
  const m = style && style.match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i);
  return m ? Math.round(Number(m[1])) : null;
}

function appendQuery(url, params) {
  const [base, hash = ''] = url.split('#');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params}${hash ? '#' + hash : ''}`;
}

/**
 * 给一份 HTML 里的 <img> 加 srcset/sizes。
 *
 * @param {string} html
 * @param {string} baseDir 这份 HTML 所在目录的绝对路径（相对 src 按它解析）
 * @param {string} rootGuard 允许触及的根（防路径逃逸；解析结果必须在它之下）
 * @returns {Promise<string>}
 */
export async function injectSrcset(html, baseDir, rootGuard) {
  if (!html || !/<img\b/i.test(html)) return html;

  // 先把要查的 src 收齐，去重后并发查元数据，避免同一张图查 N 遍
  const tags = [...html.matchAll(IMG_TAG_RE)];
  const wanted = new Map();   // src → absPath
  for (const [, attrs] of tags) {
    const src = attrOf(attrs, 'src');
    if (!src || wanted.has(src)) continue;
    if (attrOf(attrs, 'srcset') !== null) continue;               // agent 自己写过
    if (/^(?:[a-z][a-z0-9+\-.]*:|\/\/|#)/i.test(src)) continue;   // 绝对 / data: / 协议相对
    if (!shouldTranscode(path.extname(src.split('?')[0]))) continue;
    const abs = path.resolve(baseDir, decodeURIComponent(src.split('?')[0]));
    if (abs !== rootGuard && !abs.startsWith(rootGuard + path.sep)) continue;
    wanted.set(src, abs);
  }
  if (!wanted.size) return html;

  const metas = new Map();
  await Promise.all([...wanted].map(async ([src, abs]) => {
    const m = await imageMeta(abs);
    if (m) metas.set(src, m);
  }));
  if (!metas.size) return html;

  return html.replace(IMG_TAG_RE, (whole, attrs) => {
    const src = attrOf(attrs, 'src');
    const meta = src && metas.get(src);
    if (!meta) return whole;

    // 比原图还宽的档没有意义（withoutEnlargement 会让它跟原图一样大，白占缓存）
    const widths = RESPONSIVE_WIDTHS.filter(w => w < meta.width);
    if (!widths.length) return whole;

    const candidates = widths.map(w => `${appendQuery(src, `w=${w}&v=${meta.v}`)} ${w}w`);
    candidates.push(`${appendQuery(src, `v=${meta.v}`)} ${meta.width}w`);

    const dw = declaredWidth(attrs);
    const sizes = dw ? `${dw}px` : '100vw';

    let next = attrs;
    if (attrOf(attrs, 'sizes') === null) next += ` sizes="${sizes}"`;
    next += ` srcset="${candidates.join(', ')}"`;
    // loading/decoding 是白送的：站点常常一屏之外还有十几张图，浏览器原生懒加载
    // 能把它们整个推迟掉，比任何编码优化都省。已经写了的不覆盖。
    if (attrOf(attrs, 'loading') === null) next += ' loading="lazy"';
    if (attrOf(attrs, 'decoding') === null) next += ' decoding="async"';
    return `<img${next}>`;
  });
}
