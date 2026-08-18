/**
 * server/engine/browse/capture.js — 从浏览的站上把可复用的东西带回来（2026-08-18）
 *
 * 用户的追加需求：「**此后从浏览器中获得的可复用内容都存到这里**」。关键词是
 * "此后" —— 采集要落盘，不能只进这一轮的上下文然后随会话消失。
 *
 * ## 落哪儿、为什么不新建目录
 *
 * `assets/references/web/`。**不新建"浏览器根"**：`assets/references/` 已经是既有
 * 目录、既有写入方（web-search 下载的参考图落那儿）、既有 skill 锚点。再立一个根就是
 * 「同一件事两个地方」—— 这个仓库最贵的一课。放它下面的 `web/` 子目录，与搜索图
 * 分栏但同根。
 *
 * 出处 sidecar 照抄 `generate-image.js` 已有的约定：`<产物层>/.meta/<name>.json`。
 * **不另发明一套** —— 而且那个约定的读者（assets.js 的清单合并）已经在，扩一处就能
 * 让参考素材也带出处。
 *
 * ## ⭐「可复用内容」比截图宽得多
 *
 * 对做设计这件事，从一个站上带回来最值钱的往往不是位图：**调色板**、**用了哪几个
 * 字体**、某一块的 **CSS 片段**、页面的**结构骨架**。这些能直接落成代码，位图只能
 * 靠眼睛转译。所以 capture 是五种，不是一种。
 *
 * ⚠️ 五种里四种是从 `getComputedStyle` / CDP 直接读出来的（可靠），
 * **`skeleton` 那三个数是启发式**（按布局签名聚类数"节的形状种类"），返回值里明确
 * 标着"粗略，当对照不当真相"—— 它的用处是让 site-craft 的「无聊诊断」从"靠眼睛数"
 * 变成"对参照站有对照数字"，不是当成事实。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/** 采集落点（工作区相对）。web-search 的搜索图在同一个 references 根下、分栏放。 */
export const CAPTURE_DIR = path.posix.join('assets', 'references', 'web');

const slug = (s) => String(s || '')
  .replace(/[^\w一-龥-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'capture';

/** 页面里跑的采集器。⚠️ 整段在浏览器上下文里执行，不能引用外面的东西。 */
/* eslint-disable no-undef */
function collectorSource() {
  return () => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const norm = (c) => {
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return null;
      return c;
    };

    // ── 调色板：按"用途"取，不是把图量化 ──
    // 量化位图会给一堆没名字的相近色；从 computed style 取到的是**作者的选择**，
    // 而且自带用途，拿回来能直接用。
    // ⚠️ 每一行显式声明取哪个属性 —— 第一版对每个元素同时报 color 和 background，
    // 于是出现了 `page-bg/color=black` 这种自相矛盾的行（body 的 color 是正文色）。
    const uses = [
      ['page-bg', 'body', 'backgroundColor'],
      ['body-text', 'body', 'color'],
      ['h1', 'h1', 'color'],
      ['h2', 'h2', 'color'],
      ['link', 'a', 'color'],
      ['button-bg', 'button, .btn, [class*=button]', 'backgroundColor'],
      ['button-text', 'button, .btn, [class*=button]', 'color'],
      ['card-bg', 'article, .card, [class*=card]', 'backgroundColor'],
      ['footer-bg', 'footer', 'backgroundColor'],
      ['footer-text', 'footer', 'color'],
    ];
    const palette = [];
    for (const [role, sel, prop] of uses) {
      const el = document.querySelector(sel);
      const s = cs(el);
      const v = s ? norm(s[prop]) : null;
      if (v) palette.push({ role, value: v });
    }

    // ── 字体：字族 + 实际用到的字重/字号（光有字族没法照做）──
    const fontOf = (sel, label) => {
      const el = document.querySelector(sel);
      const s = cs(el);
      if (!s) return null;
      return {
        role: label,
        family: s.fontFamily,
        size: s.fontSize,
        weight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
      };
    };
    const fonts = [
      fontOf('body', 'body'), fontOf('h1', 'h1'), fontOf('h2', 'h2'),
      fontOf('p', 'paragraph'), fontOf('code, pre', 'mono'),
    ].filter(Boolean);

    // ── 结构骨架（⚠️ 启发式）──
    //
    // ⚠️ 第一版按标签选（`main > *, body > section` …），在第一个真站（MDN）上就
    // **数出 0 节**。一个在真站上读 0 的指标比没有更坏 —— 它会告诉 agent
    // 「这个参照站有 0 种形状」。所以改成按**视觉横带**找：宽度接近视口、够高、
    // 而且内部不再包含更小的带（取最内层）。人看一个页面看到的"一节"就是这个。
    const vw = window.innerWidth;
    const cand = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      // 高度门槛跟视口挂钩而不是写死 120 —— 真站上一条 104px 的 stats strip
      // 就这么整条消失了（它确实是"一节"，人一眼就看见）
      if (r.width < vw * 0.7 || r.height < Math.max(72, window.innerHeight * 0.08)) return false;
      const s = cs(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    // 取最内层的带：一个候选如果还含着别的候选，它是容器不是"一节"
    const candSet = new Set(cand);
    const sections = cand.filter(el => ![...el.querySelectorAll('*')].some(d => candSet.has(d)));

    // 「节的形状种类」按布局签名聚类：同签名的节读起来是"同一种节奏"。
    // 这是 site-craft「用户说无聊」那节要的第二个数。
    // 签名要**粗**。第一版把图/标题/文字块数都算进去（各封顶 3），结果在三个真站上
    // `形状种类 === 节数` —— 每节都独一无二，那第二个数就不携带任何信息。
    // 现在只留三个粗轴：排布方式 / 有没有图 / 文字密度档。同一种节奏才会撞在一起。
    const sig = (el) => {
      const s = cs(el);
      const layout = s.gridTemplateColumns !== 'none' ? 'grid'
        : (s.display.includes('flex') ? (s.flexDirection.startsWith('row') ? 'row' : 'col') : 'block');
      // ⚠️ `querySelector` **只找后代**。最内层的那条带很可能**自己就是**那张
      // 全幅 hero 图/视频 —— 于是它被标成 noimg，图 hero 和纯文字 hero 聚成一类。
      const IMGISH = 'img, picture, video, svg';
      const hasImg = (el.matches(IMGISH) || el.querySelector(IMGISH)) ? 'img' : 'noimg';
      const chars = (el.textContent || '').trim().length;
      const density = chars < 120 ? 'bare' : (chars < 800 ? 'some' : 'lots');
      return `${layout}|${hasImg}|${density}`;
    };
    const shapes = new Map();
    for (const el of sections) {
      const k = sig(el);
      shapes.set(k, (shapes.get(k) || 0) + 1);
    }
    // 交互重心：值得动手的东西。
    // ⚠️ 三个坑，都是审查在真站上撞出来的：
    //   ① `[class*=tab]` 是子串匹配 → `.tabular-figures`、`.tabbed-wrapper` 全中；
    //      `:not([class*=table])` 也补不完。改成按 class **token** 比对。
    //   ② 一个元素同时命中两条选择器（既 `[role=tab]` 又 `.tab-item`）会被数两遍。
    //      改用 Set 存元素再取 size。
    //   ③ 裸 `[aria-expanded]` 把汉堡菜单、下拉导航全算成"手风琴"。它们确实是
    //      disclosure，但不是"这页的交互重心"。单列一档，别混进 accordions。
    const clsTokens = (el) => (typeof el.className === 'string'
      ? el.className.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : []);
    const hasTok = (el, names) => clsTokens(el).some(t => names.has(t));
    const setOf = (sel, pred) => {
      const out = new Set();
      for (const el of document.querySelectorAll(sel)) { if (!pred || pred(el)) out.add(el); }
      return out;
    };
    const TAB_TOK = new Set(['tab', 'tabs']);
    const ACC_TOK = new Set(['accordion', 'accordions', 'collapse', 'collapsible', 'disclosure']);
    const interactive = {
      forms: setOf('form').size,
      tabs: setOf('[role=tab], [role=tablist], [class]', el => el.getAttribute('role') === 'tab'
        || el.getAttribute('role') === 'tablist' || hasTok(el, TAB_TOK)).size,
      accordions: setOf('details, [class]', el => el.tagName === 'DETAILS' || hasTok(el, ACC_TOK)).size,
      disclosures: setOf('[aria-expanded]').size,   // 多半是导航开关，单独列
      draggables: setOf('[draggable=true], input[type=range]').size,
      videos: setOf('video').size,
    };

    return {
      url: location.href,
      title: document.title,
      viewportWidth: window.innerWidth,
      palette,
      fonts,
      skeleton: {
        sectionCount: sections.length,
        shapeKinds: shapes.size,
        shapes: [...shapes.entries()].map(([k, n]) => ({ signature: k, count: n })),
        interactive,
        // disclosures 不计进"交互点"：它多半是汉堡菜单/下拉导航，
        // 每个站都有，加进去只会把这个数字变成噪音
        interactivePoints: ['forms', 'tabs', 'accordions', 'draggables', 'videos']
          .reduce((a, k) => a + interactive[k], 0),
        _note: '启发式：节的形状种类是按布局签名聚类数出来的，当对照数字用，别当真相。'
          + '同一页做 A/B 最可靠；跨页比较受各家标记方式影响，看数量级别抠个位数。',
      },
    };
  };
}
/* eslint-enable no-undef */

/**
 * 采一次。
 * @param {object} p
 * @param {import('playwright').Page} p.page
 * @param {string} p.workspaceRoot
 * @param {string[]} p.kinds  screenshot / palette / fonts / css / skeleton
 * @param {string} [p.name]   文件名主干（不给就按站名+时间）
 * @param {string} [p.lookingFor] agent 当时在找什么 —— 三天后没有这句就是一堆不知道哪来的图
 * @param {string} [p.selector] css 那一种要指一块
 * @param {object} [p.ids] {sessionId, runId}
 * @param {(buf: Buffer) => Promise<{data: string, mimeType: string, note?: string}>} [p.normalize]
 * @returns {Promise<{files: Array<{rel: string, kind: string, bytes: number}>, data: object}>}
 */
export async function capture({
  page, workspaceRoot, kinds, name, lookingFor, selector, ids = {}, normalize,
}) {
  const dir = path.join(workspaceRoot, CAPTURE_DIR);
  const metaDir = path.join(dir, '.meta');
  await fs.mkdir(metaDir, { recursive: true });

  const info = await page.evaluate(`(${collectorSource().toString()})()`);
  const host = (() => { try { return new URL(info.url).hostname.replace(/^www\./, ''); } catch { return 'page'; } })();
  const stem = slug(name || `${host}-${new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace(/[T:]/g, '')}`);

  const files = [];
  const failed = [];
  const write = async (suffix, body, kind) => {
    const rel = path.posix.join(CAPTURE_DIR, `${stem}${suffix}`);
    const abs = path.join(workspaceRoot, rel);
    await fs.writeFile(abs, body);
    files.push({ rel, kind, bytes: Buffer.byteLength(body) });
    return rel;
  };

  // ⚠️ **每一种单独 try**。第一版是一路顺着写下来的，真跑时 `selector: 'main'` 在
  // MDN 上等了 30 秒超时 → 整个函数抛错 → 调色板/字体/结构/CSS 明明都已经采到了
  // （evaluate 跑在最前面），连出处 sidecar 都没写下去，**一次白采**。
  // 部分失败不该丢掉已经成功的部分。
  if (kinds.includes('screenshot')) {
    try {
      let raw;
      if (selector) {
        const loc = page.locator(selector).first();
        // 短超时快速失败：一个选不中的选择器不该让整次采集卡 30 秒
        await loc.waitFor({ state: 'visible', timeout: 6000 });
        raw = await loc.screenshot({ type: 'png', timeout: 8000 });
      } else {
        raw = await page.screenshot({ type: 'png', fullPage: false });
      }
      // 走跟感知层同一条归一化（webp、缩到 API 反正会缩的规格）—— 参考图不需要
      // 无损，而 76MB 的 references 目录已经是这个项目的既有账
      const shot = normalize ? await normalize(raw) : null;
      const buf = shot ? Buffer.from(shot.data, 'base64') : raw;
      await write(shot ? '.webp' : '.png', buf, 'screenshot');
    } catch (err) {
      failed.push(`screenshot: ${err.message.split('\n')[0]}`
        + (selector ? `（选择器 ${selector} 可能选不中或不可见 —— 先用 browser_read 看页面上有什么）` : ''));
    }
  }

  const bundle = {};
  if (kinds.includes('palette')) bundle.palette = info.palette;
  if (kinds.includes('fonts')) bundle.fonts = info.fonts;
  if (kinds.includes('skeleton')) bundle.skeleton = info.skeleton;
  if (kinds.includes('css') && selector) {
    // 复用 explain_style 那条 CDP 通路：拿这个元素**命中的全部规则**，
    // 而不是 computed 值 —— 前者能照抄，后者只是结果
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) {
        // 原来这里没有 else：选择器选不中就静默少一份产物，agent 看不到
        failed.push(`css: 选择器 ${selector} 在页面上选不中（先 browser_read 看页面上有什么）`);
      } else {
        const m = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
        bundle.css = (m.matchedCSSRules || []).map(r => ({
          selector: r.rule?.selectorList?.text,
          media: (r.rule?.media || []).map(x => x.text).filter(Boolean),
          declarations: (r.rule?.style?.cssProperties || [])
            .filter(d => !d.disabled && d.value != null && d.range)   // 有 range = 作者真写了这条
            .map(d => `${d.name}: ${d.value}${d.important ? ' !important' : ''}`),
        })).filter(r => r.declarations.length);
      }
    } catch (err) {
      // ⚠️ 原来只写进磁盘 JSON 的 cssError，返回给 agent 的文本里**一个字都没有**
      // （打印分支只在 `r.data.css` 存在时才跑）→ css 这一档完全静默失败
      bundle.cssError = err.message;
      failed.push(`css: ${err.message.split('\n')[0]}`);
    }
  }
  if (Object.keys(bundle).length) {
    try {
      await write('.json', `${JSON.stringify({ source: info.url, title: info.title, ...bundle }, null, 2)}\n`, 'data');
    } catch (err) { failed.push(`data json: ${err.message}`); }
  }

  // 出处 sidecar —— 没有它，三天后这就是一堆不知道哪来的文件
  await fs.writeFile(path.join(metaDir, `${stem}.json`), `${JSON.stringify({
    sourceUrl: info.url,
    pageTitle: info.title,
    capturedAt: new Date().toISOString(),
    viewportWidth: info.viewportWidth,
    lookingFor: lookingFor || null,
    kinds,                          // agent 要的
    captured: files.map(f => f.kind),   // 真采到的（跟上面可能不一样，别让 sidecar 说谎）
    failed,
    selector: selector || null,
    sessionId: ids.sessionId ?? null,
    runId: ids.runId ?? null,
  }, null, 2)}\n`, 'utf8');

  return { files, failed, data: { ...bundle, url: info.url, title: info.title } };
}
