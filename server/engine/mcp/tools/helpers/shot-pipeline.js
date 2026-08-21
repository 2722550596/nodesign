/**
 * helpers/shot-pipeline.js — 截图管线的纯 helper（2026-08-19 从 screenshot.js 拆出，行数棘轮）
 *
 * screenshot_canvas / screenshot_url / browse 共用的一段：出图归一化、渲染保真探针、
 * 页面诊断收集（console / 失败请求）、waitFor / beforeShot 等待语义。
 * 全部只依赖 playwright Page 与 sharp，不碰工作区寻址 —— 拆出来是搬家不是重写。
 */

// ── 出图归一化（2026-07-29）──
// 背景：fullPage 截长站点页时 PNG 会超 API 的图片上限（尺寸 8000px / 字节 5MB），
// 整个工具调用直接报错。而且 API 侧本来就会把长边 >1568 或总像素 >~1.15MP 的图
// 缩到这个规格再喂给模型 —— 本地先缩到同规格，模型看到的画面一个像素不差，
// 但传输体积小一个量级、永远不会触发上限报错。编码统一 webp（API 支持，比 PNG 小得多）。
const API_LONG_EDGE = 1568;
const API_MAX_PIXELS = 1_150_000;
/** 导出给"坐标 1:1"断言用（browse-computer：视口必须落在不缩放的范围内） */
export const API_IMAGE_LIMITS = { longEdge: API_LONG_EDGE, maxPixels: API_MAX_PIXELS };

// ── 渲染层保真（2026-08-07）──
// 2026-08-05 事故：一次 screenshot_canvas 的位图整体呈暗色反转（深棕底米白字），
// 同一 page 里 beforeShot 读的 getComputedStyle 却全程浅色真值，内联 #ff0000
// 还原样出红——computed style 不动、paint 被变换、高饱和色豁免，指纹指向
// Chromium 的强制暗色（Auto Dark）。事后无法稳定复现，但这一类"渲染层替页面
// 做主"的来源可以确定性关掉，launch 参数全局带上：
// 定义在同目录 perception-page.js（三个感知工具当时是裸奔的，收成一份）；
// 这里原样再导出，screenshot-url.js 等调用方一站取齐。
export { FIDELITY_LAUNCH_ARGS } from './perception-page.js';

/**
 * 渲染保真探针：主图截完后，往页面塞一块已知色 (#f5f0e4) 的 16px 方块单截，
 * 看栅格出来的像素还认不认账。位图和 computed style 是两条独立感知通道——
 * 渲染层若在做颜色变换，页面内任何 JS 读数都测不到，只有这种"已知输入对
 * 已知输出"的探针测得到。亮度掉一半才报警（抗锯齿/有损压缩的小偏差不算）。
 * 2026-08-05 那次事故 agent 连烧 8 张截图排查自己的 CSS 才怀疑到管线头上——
 * 这个警告就是把那 8 张图省下来的。
 */
export async function detectPaintTransform(page) {
  try {
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = '__nd_paint_probe__';
      d.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;'
        + 'background:#f5f0e4;z-index:2147483647;pointer-events:none';
      document.documentElement.appendChild(d);
    });
    const buf = await page.locator('#__nd_paint_probe__').screenshot({ type: 'png' });
    await page.evaluate(() => document.getElementById('__nd_paint_probe__')?.remove());
    const { default: sharp } = await import('sharp');
    const stats = await sharp(buf).stats();
    const [r, g, b] = stats.channels.map((c) => c.mean);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;   // #f5f0e4 本色 ≈ 239
    if (lum < 128) {
      return '⚠ paint-layer color transform detected: a #f5f0e4 probe rasterized to '
        + `rgb(${r | 0},${g | 0},${b | 0}). This bitmap does NOT faithfully show the page's own colors, `
        + 'and computed styles will keep reporting the authored values — the mismatch is in the '
        + 'rasterizer, not your CSS. Do not debug colors from this shot; report via report_issue '
        + 'and ask the user to eyeball the page in their own browser.';
    }
    return null;
  } catch {
    return null;   // 探针挂了不挡截图
  }
}

/** PNG buffer → { data, mimeType, note }。失败时原样回退 PNG（宁可大也别丢图）。 */
export async function normalizeShot(buf) {
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return { data: buf.toString('base64'), mimeType: 'image/png', note: null };
    const scale = Math.min(1, API_LONG_EDGE / Math.max(w, h), Math.sqrt(API_MAX_PIXELS / (w * h)));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    let img = sharp(buf);
    if (scale < 1) img = img.resize(tw, th);
    const out = await img.webp({ quality: 82 }).toBuffer();
    let note = scale < 1
      ? `image normalized ${w}x${h} -> ${tw}x${th} webp ${(out.length / 1024).toFixed(0)}KB (matches what the vision API would downscale to anyway)`
      : null;
    // 极端长图：整体缩完细节所剩无几，提示换姿势而不是硬看
    if (scale < 0.35 && Math.max(w, h) / Math.min(w, h) > 4) {
      note += ' — long page squeezed hard; details are unreadable at this scale. Prefer sectioned shots (viewport + beforeShot scroll) or pageIndex/device over fullPage.';
    }
    return { data: out.toString('base64'), mimeType: 'image/webp', note };
  } catch (err) {
    return { data: buf.toString('base64'), mimeType: 'image/png', note: `image normalize skipped: ${err?.message || err}` };
  }
}

// ── 页面诊断收集（2026-07-29）──
// 背景：agent 塞了 GSAP/Lenis CDN 却不知道有没有加载成功——截图上看不出来。
// 挂 4 个 playwright listener，截图 caption 里回传 console 错误 + 加载失败资源。
// 上限/截断防止一个疯狂报错的页面把 caption 撑爆。
const DIAG_MAX_ENTRIES = 15;
const DIAG_MAX_TEXT = 300;
const DIAG_MAX_LOGS = 10;   // console:'all' 时 log 级单独一桶，别把真错误挤出去

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {'warn'|'all'} [opts.console] 默认 'warn' 只收 warning/error。
 *   'all' 把 log/info/debug 也带回（单独一桶，capped）。默认档下被滤掉的
 *   log 条数会写进 summary —— agent 上报过：console.log 被静默吞掉，
 *   它以为代码没执行到，白改了两轮（iss_msz24e0q_vfwf）。
 */
export function attachPageDiagnostics(page, opts = {}) {
  const wantAll = opts.console === 'all';
  // ⭐ 聚合按（归一化原因 × 主机）分组，不逐条罗列（agent 上报逮到：一页 30 张
  // 字体请求失败会把 caption 撑成 30 行同一句话，真正独特的那条错误被淹没）。
  // 归一化 = 把消息里的 URL 收成主机名：同一家 CDN 挂 30 个文件是**一个**故障。
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };
  const normText = (t) => t.replace(/https?:\/\/[^\s"')]+/g, (u) => `${hostOf(u)}/…`);

  const consoleEntries = [];      // { type, text, count }，text 是该组第一条原文
  const seenConsole = new Map();  // 归一化文本 → entry
  const noteConsole = (type, rawText) => {
    const text = String(rawText || '').slice(0, DIAG_MAX_TEXT);
    const key = `${type}|${normText(text)}`;
    const prev = seenConsole.get(key);
    if (prev) { prev.count += 1; return; }
    const entry = { type, text, count: 1 };
    seenConsole.set(key, entry);
    if (consoleEntries.length < DIAG_MAX_ENTRIES) consoleEntries.push(entry);
  };

  const failedGroups = new Map();  // `${host}|${detail}` → { method, url, detail, host, count }
  const noteFailed = (method, url, detail) => {
    const key = `${hostOf(url)}|${detail}`;
    const prev = failedGroups.get(key);
    if (prev) { prev.count += 1; return; }
    if (failedGroups.size >= DIAG_MAX_ENTRIES) return;
    failedGroups.set(key, { method, url: url.slice(0, DIAG_MAX_TEXT), detail, host: hostOf(url), count: 1 });
  };

  // log 级单独一桶（'all' 才收），同样按归一化文本分组
  const logEntries = [];
  const seenLogs = new Map();
  let filteredLogs = 0;
  const noteLog = (type, rawText) => {
    const text = String(rawText || '').slice(0, DIAG_MAX_TEXT);
    const key = `${type}|${normText(text)}`;
    const prev = seenLogs.get(key);
    if (prev) { prev.count += 1; return; }
    const entry = { type, text, count: 1 };
    seenLogs.set(key, entry);
    if (logEntries.length < DIAG_MAX_LOGS) logEntries.push(entry);
  };

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') { noteConsole(type, msg.text()); return; }
    if (wantAll) noteLog(type, msg.text());
    else filteredLogs += 1;
  });
  page.on('pageerror', (err) => noteConsole('pageerror', err?.message || err));
  page.on('requestfailed', (req) => noteFailed(req.method(), req.url(), req.failure()?.errorText || 'failed'));
  page.on('response', (res) => {
    if (res.status() < 400) return;
    noteFailed(res.request().method(), res.url(), `HTTP ${res.status()}`);
  });

  return {
    /** 汇成 caption 附加段。干净时给正向确认（"不知道有没有挂"跟"确认没挂"是两回事）。 */
    summary() {
      const failed = [...failedGroups.values()];
      // 被滤掉的 log 条数必须可见 —— "没显示"和"没发生"是两回事
      const filteredNote = filteredLogs > 0
        ? `${filteredLogs} log-level line(s) filtered — pass console:'all' to see them` : null;
      if (!consoleEntries.length && !failed.length && !logEntries.length) {
        return filteredNote
          ? `console clean (${filteredNote}), all requests OK`
          : 'console clean, all requests OK';
      }
      const lines = [];
      if (consoleEntries.length) {
        const total = consoleEntries.reduce((n, e) => n + e.count, 0);
        lines.push(`console (${total}${total > consoleEntries.length ? ` in ${consoleEntries.length} groups` : ''}):`);
        for (const e of consoleEntries) {
          lines.push(`  [${e.type}] ${e.text}${e.count > 1 ? ` (×${e.count} similar)` : ''}`);
        }
      }
      if (logEntries.length) {
        const total = logEntries.reduce((n, e) => n + e.count, 0);
        lines.push(`console logs (${total}${total > logEntries.length ? ` in ${logEntries.length} groups` : ''}):`);
        for (const e of logEntries) {
          lines.push(`  [${e.type}] ${e.text}${e.count > 1 ? ` (×${e.count} similar)` : ''}`);
        }
      }
      if (filteredNote) lines.push(`(${filteredNote})`);
      if (failed.length) {
        const total = failed.reduce((n, f) => n + f.count, 0);
        lines.push(`failed requests (${total}${total > failed.length ? ` in ${failed.length} groups` : ''}):`);
        for (const f of failed) {
          // 每组给一条样本 URL；同主机同原因的其余只报数
          lines.push(`  ${f.method} ${f.url} — ${f.detail}${f.count > 1 ? ` (×${f.count} from ${f.host})` : ''}`);
        }
      }
      return lines.join('\n');
    },
  };
}

/**
 * beforeShot 执行（2026-07-29）：截图环境不滚动 → ScrollTrigger/IO 入场动画永远
 * 不触发 → agent 为"能被截图"反过来阉割设计。给截图前跑一段交互的能力。
 *  - 'scrollToBottom'：分步滚到底再回顶（所有 scroll-linked 动画都触发过一遍）
 *  - 其他字符串：当 JS 片段在页面上下文执行（支持 await），超时兜底
 *
 * 超时 5s→10s（2026-08-19）：重 3D 站 boot 就要 3.5~5 秒，agent 一个会话里
 * 十几次超时还误判功能坏了（iss_msz236jw_9eui）。"等页面就位"这半件事
 * 已经拆给 waitFor 参数（runWaitFor，独立计时），beforeShot 只该剩设置动作。
 */
const BEFORE_SHOT_TIMEOUT_MS = 10000;

/**
 * waitFor：截图前轮询一个页面表达式直到为真（独立 15s 预算，不挤占 beforeShot）。
 * 慢启动页面的正确姿势：waitFor:"window.__game" 等就位，beforeShot 只做设置。
 * 超时不挡截图 —— note 写明没等到，agent 自己判断画面可不可信。
 */
export const WAIT_FOR_TIMEOUT_MS = 15000;
export async function runWaitFor(page, expr) {
  if (!expr) return null;
  try {
    await page.waitForFunction(expr, undefined, { timeout: WAIT_FOR_TIMEOUT_MS, polling: 100 });
    return null;
  } catch (err) {
    const why = /Timeout/i.test(String(err?.message))
      ? `waitFor not truthy within ${WAIT_FOR_TIMEOUT_MS / 1000}s`
      : `waitFor error: ${err?.message || err}`;
    return `${why} (${String(expr).slice(0, 80)}) — captured anyway, the page may not be in the state you expect`;
  }
}

export async function runBeforeShot(page, beforeShot) {
  if (!beforeShot) return null;
  try {
    if (beforeShot === 'scrollToBottom') {
      await page.evaluate(async () => {
        const doc = document.scrollingElement || document.documentElement;
        const step = Math.max(200, window.innerHeight * 0.8);
        for (let y = 0; y <= doc.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, doc.scrollHeight);
        await new Promise((r) => setTimeout(r, 250));
        window.scrollTo(0, 0);
      });
      // 回顶后给 reveal/settle 动画一点时间
      await page.waitForTimeout(400);
    } else {
      await Promise.race([
        page.evaluate(`(async () => { ${beforeShot} })()`),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`beforeShot timeout (${BEFORE_SHOT_TIMEOUT_MS / 1000}s) — if you were waiting for the page to boot, use waitFor instead`)),
          BEFORE_SHOT_TIMEOUT_MS,
        )),
      ]);
      await page.waitForTimeout(200);
    }
    return null;
  } catch (err) {
    // beforeShot 挂了不挡截图 —— 把错误带回 caption 让 agent 知道
    return `beforeShot error: ${err?.message || err}`;
  }
}
