/**
 * lib/region-shot.js —— 把用户在预览上圈的那一块截下来。
 *
 * 为什么在服务端截而不是前端：产物是 iframe 里的**真实网页**，前端要把它变成
 * 位图只能靠 html2canvas 那类重写渲染器的库 —— 那玩意儿在有 3D、滤镜、
 * 自定义字体、伪元素的页面上出来的东西跟屏幕上不是一回事，而这张图恰恰是要
 * 给 agent 当"眼见为实"的证据用的。chromium 真跑一遍才是它自己的样子，
 * 而且这台机器上封面和 screenshot_canvas 早就是这么干的（lib/cover.js）。
 *
 * 取景：以圈为中心带一圈余量。只截圈内的话 agent 拿到一块没有上下文的碎片，
 * 分不清"这是页面哪儿"；余量给到它周围一点参照。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/** 圈外多留这么多像素当上下文 */
const PADDING = 32;

/** 出图长边上限，跟 screenshot 工具同口径（API 侧本来就会缩到这个规格） */
const OUT_LONG_EDGE = 1200;

/** 截图串行：一台 1 核机器上同时开两个 chromium 会双双卡住 */
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * @param {object} p
 * @param {string} p.absPath   产物页面的绝对路径
 * @param {{x,y,w,h}} p.region 页面坐标（CSS px，含滚动量）
 * @param {{width,height}} p.viewport 用户当时的取景宽高
 * @returns {Promise<{ buffer: Buffer, clip: {x,y,width,height} }>}
 */
export async function renderRegionShot({ absPath, region, viewport }) {
  return serialize(async () => {
    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.goto('file://' + absPath, { waitUntil: 'networkidle', timeout: 20_000 });
      // 字体加载完再截（CJK 子集是 lazy 的，不显式 load 会截到 fallback 字形）
      await page.evaluate(async () => {
        document.body.offsetHeight;
        await Promise.all(Array.from(document.fonts).map(f => f.load().catch(() => {})));
        await document.fonts.ready;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }).catch(() => { /* 页面自己抛错也照截 */ });
      // deck 的 standalone-fit 会在真实 viewport 下再缩一次，抹掉（同 cover.js）
      await page.addStyleTag({ content: `
        body { margin: 0 !important; padding: 0 !important; }
        body.__nd-fit-active > .__nd-deck-wrap > .__nd-page-frame {
          width: ${viewport.width}px !important; height: ${viewport.height}px !important;
          display: block !important; overflow: visible !important;
        }
        body.__nd-fit-active section[data-page] { transform: none !important; }
      ` }).catch(() => {});
      await page.waitForTimeout(500);

      const want = {
        x: Math.max(0, region.x - PADDING),
        y: Math.max(0, region.y - PADDING),
        w: region.w + PADDING * 2,
        h: region.h + PADDING * 2,
      };

      // 滚到目标位置再按视口坐标裁。**滚动会被文档末尾夹住**，所以要把真实
      // 落点读回来算裁剪框，不然页尾附近截出来的是错位的一块。
      const scroll = await page.evaluate(([x, y]) => {
        window.scrollTo(x, y);
        const e = document.scrollingElement || document.documentElement;
        return [e.scrollLeft, e.scrollTop];
      }, [want.x, want.y]);

      const clip = {
        x: Math.max(0, want.x - scroll[0]),
        y: Math.max(0, want.y - scroll[1]),
        width: Math.min(want.w, viewport.width),
        height: Math.min(want.h, viewport.height),
      };
      clip.width = Math.max(1, Math.min(clip.width, viewport.width - clip.x));
      clip.height = Math.max(1, Math.min(clip.height, viewport.height - clip.y));

      const png = await page.screenshot({ type: 'png', clip });
      await ctx.close();

      const { default: sharp } = await import('sharp');
      const buffer = await sharp(png)
        .resize({ width: OUT_LONG_EDGE, height: OUT_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      return { buffer, clip };
    } finally {
      await browser?.close().catch(() => {});
    }
  });
}

/** 圈选截图在会话工作区里的落点（agent 按这个相对路径找得到） */
export const SHOT_DIR = 'region-shots';

export async function saveRegionShot(sessionRoot, id, buffer) {
  const dir = path.join(sessionRoot, SHOT_DIR);
  await fs.mkdir(dir, { recursive: true });
  const rel = `${SHOT_DIR}/${id}.webp`;
  await fs.writeFile(path.join(sessionRoot, rel), buffer);
  return rel;
}
