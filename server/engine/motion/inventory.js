/**
 * server/engine/motion/inventory.js — 一页"靠什么在动"的静态清单（2026-08-21）
 *
 * 回答的是"这站用了哪些 CSS 滚动动画 / 特殊样式动画、靠什么库"，不是"动起来好不好看"
 * （那是 motion-lab 的胶片条和元素探针的活）。**对页面无知**：浏览通道看参考站、
 * 产物会话查自己的站，都是同一份。
 *
 * 四路来源，各自独立 try（一路挂了不带走别的）：
 *   1. 样式表原文：CDP `CSS.getStyleSheetText` —— 跨域 CDN 的样式表也拿得到
 *      （浏览器自己的资源，不受 CORS 管；explain_style 走的同一条 CDP CSS 域）。
 *      扫 @keyframes / animation / transition / animation-timeline (scroll()/view())
 *      / scroll-snap / sticky / will-change / prefers-reduced-motion。
 *   2. 运行时：`document.getAnimations()` —— 浏览器自己的账本：此刻活着的 CSS 动画 /
 *      过渡 / WAAPI，连 keyframes、时长、缓动都有。⚠️ 只列**此刻活着的**，所以排在
 *      滚动对照之后跑（把 reveal 都触发出来再查）。GSAP 不走 WAAPI（它直接写 inline
 *      style），靠第 3、4 路。
 *   3. 库指纹：全局对象 + script src + DOM 属性（data-aos / data-scroll …）。GSAP 的
 *      ScrollTrigger 挂在全局时能直接读出每个 trigger 的 start/end/scrub/pin。
 *   4. 滚动对照（真滚轮）：记一遍块元素的 opacity/transform，滚到中、滚到底、滚回顶
 *      各记一遍 —— 回顶后仍变了的 = 滚动触发的入场（class 切换型 reveal）；中途变了
 *      回顶又复原的 = 随滚动位置走的（scrub / 视差）。顺带量出派发的滚轮像素 vs 页面
 *      真滚的像素 —— 不一致就是滚动劫持（Lenis / Locomotive 那一族）。
 *
 * 看不见的部分（工具绕不过去，描述里要说）：canvas/WebGL 里的动画 DOM 层零痕迹，只有
 * 胶片条能看；GSAP 没挂全局时只看得到结果看不到时间轴；class 名压缩过的站报不出语义名。
 */

const MAX_SHEET_BYTES = 900_000;        // 单张样式表上限（minified 大包也够）
const MAX_TOTAL_BYTES = 3_000_000;
const SAMPLE_CAP = 24;                  // 每类最多留几条样本
const CANDIDATE_CAP = 400;              // 滚动对照采的块元素上限
const SCROLL_BUDGET_MS = 6000;

// ── 纯函数：CSS 文本扫描（可单测）──────────────────────────────

/**
 * 把 CSS 文本拆成 {prelude, body, depthPath} 规则列表。自己写的小括号计数器，
 * 不引 CSS 解析库（要的只是"谁声明了什么"，不是完整 AST）。
 */
export function splitRules(css) {
  const out = [];
  const stack = [];     // 外层 @media / @supports 的 prelude
  let i = 0; const n = css.length;
  let buf = '';
  const skipComment = () => {
    if (css[i] === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      return true;
    }
    return false;
  };
  while (i < n) {
    if (skipComment()) continue;
    const ch = css[i];
    if (ch === '{') {
      const prelude = buf.trim(); buf = '';
      // @media / @supports / @layer / @container：进一层；其余（含 @keyframes）整块取到配对 }
      if (/^@(media|supports|layer|container|scope)\b/i.test(prelude)) {
        stack.push(prelude); i += 1; continue;
      }
      let depth = 1; let j = i + 1; let body = '';
      while (j < n && depth > 0) {
        if (css[j] === '/' && css[j + 1] === '*') { const e = css.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') { depth -= 1; if (depth === 0) break; }
        body += css[j]; j += 1;
      }
      out.push({ prelude, body, context: stack.slice() });
      i = j + 1;
      continue;
    }
    if (ch === '}') { stack.pop(); buf = ''; i += 1; continue; }
    buf += ch; i += 1;
  }
  return out;
}

/** 规则列表 → 分类计数 + 样本。sheetName 只用来标注来源。 */
export function scanCss(css, sheetName = '') {
  const r = {
    keyframes: [], animations: [], transitions: [], scrollTimeline: [], scrollSnap: [],
    sticky: [], willChange: 0, reducedMotion: false, viewTransitions: 0,
  };
  const push = (arr, item) => { if (arr.length < SAMPLE_CAP) arr.push(item); arr.total = (arr.total || 0) + 1; };
  const decl = (body, prop) => {
    const m = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'i'));
    return m ? m[1].trim().slice(0, 120) : null;
  };
  for (const rule of splitRules(css)) {
    const ctx = rule.context.join(' › ');
    if (/prefers-reduced-motion/i.test(ctx) || /prefers-reduced-motion/i.test(rule.prelude)) r.reducedMotion = true;
    if (/^@keyframes\s+/i.test(rule.prelude)) {
      const name = rule.prelude.replace(/^@keyframes\s+/i, '').trim();
      const steps = (rule.body.match(/(?:^|})\s*(?:from|to|[\d.]+%)(?:\s*,\s*(?:from|to|[\d.]+%))*\s*{/g) || []).length;
      push(r.keyframes, { name, steps, sheet: sheetName });
      continue;
    }
    if (/^@view-transition/i.test(rule.prelude)) { r.viewTransitions += 1; continue; }
    if (rule.prelude.startsWith('@')) continue;
    const b = rule.body;
    const sel = rule.prelude.slice(0, 80);
    const anim = decl(b, 'animation') || decl(b, 'animation-name');
    if (anim) push(r.animations, { selector: sel, animation: anim, context: ctx || null, sheet: sheetName });
    const tr = decl(b, 'transition') || decl(b, 'transition-property');
    if (tr && !/^(none|all 0s)/i.test(tr)) push(r.transitions, { selector: sel, transition: tr, context: ctx || null, sheet: sheetName });
    const tl = decl(b, 'animation-timeline') || decl(b, 'scroll-timeline') || decl(b, 'view-timeline') || decl(b, 'scroll-timeline-name') || decl(b, 'view-timeline-name');
    if (tl) push(r.scrollTimeline, { selector: sel, timeline: tl, sheet: sheetName });
    const snap = decl(b, 'scroll-snap-type');
    if (snap && !/^none/i.test(snap)) push(r.scrollSnap, { selector: sel, value: snap, sheet: sheetName });
    const pos = decl(b, 'position');
    if (pos && /sticky/i.test(pos)) push(r.sticky, { selector: sel, sheet: sheetName });
    if (decl(b, 'will-change')) r.willChange += 1;
  }
  return r;
}

/** 多张表的扫描结果并起来 */
export function mergeScans(scans) {
  const m = { keyframes: [], animations: [], transitions: [], scrollTimeline: [], scrollSnap: [], sticky: [], willChange: 0, reducedMotion: false, viewTransitions: 0 };
  const cat = (k) => { for (const s of scans) { m[k].push(...s[k]); m[k].total = (m[k].total || 0) + (s[k].total || 0); } m[k] = Object.assign(m[k].slice(0, SAMPLE_CAP), { total: m[k].total || 0 }); };
  for (const k of ['keyframes', 'animations', 'transitions', 'scrollTimeline', 'scrollSnap', 'sticky']) cat(k);
  for (const s of scans) { m.willChange += s.willChange; m.reducedMotion = m.reducedMotion || s.reducedMotion; m.viewTransitions += s.viewTransitions; }
  return m;
}

// ── 页面里跑的函数（⚠️ 浏览器上下文，不能引外面的东西）────────────

function pageRuntimeAnimations() {
  const selOf = (el) => {
    if (!el || !el.tagName) return String(el);
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
  };
  const list = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  const out = [];
  for (const a of list.slice(0, 60)) {
    try {
      const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
      const kf = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
      const strip = (k) => { const o = {}; for (const p in k) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) o[p] = String(k[p]).slice(0, 40); return o; };
      out.push({
        kind: a.constructor && a.constructor.name,
        name: a.animationName || a.transitionProperty || null,
        target: selOf(a.effect && a.effect.target),
        duration: t.duration, delay: t.delay, easing: t.easing, iterations: t.iterations, direction: t.direction,
        state: a.playState,
        from: kf.length ? strip(kf[0]) : null, to: kf.length > 1 ? strip(kf[kf.length - 1]) : null,
        timeline: a.timeline && a.timeline.constructor ? a.timeline.constructor.name : null,
      });
    } catch { /* 某条读不出来就跳过 */ }
  }
  return { count: list.length, items: out };
}

function pageLibs() {
  const w = window;
  const libs = [];
  const has = (name, cond, ev) => { try { if (cond()) libs.push({ name, evidence: ev }); } catch { /* */ } };
  has('gsap', () => w.gsap, `gsap ${w.gsap && w.gsap.version}`);
  has('ScrollTrigger', () => w.ScrollTrigger, 'window.ScrollTrigger');
  has('Lenis', () => w.Lenis || w.lenis || document.documentElement.classList.contains('lenis'), 'window.Lenis / html.lenis');
  has('LocomotiveScroll', () => w.LocomotiveScroll || document.querySelector('[data-scroll-container],[data-scroll-section]'), 'LocomotiveScroll / data-scroll-*');
  has('AOS', () => w.AOS || document.querySelector('[data-aos]'), 'AOS / data-aos');
  has('Swiper', () => w.Swiper || document.querySelector('.swiper'), 'Swiper / .swiper');
  has('three.js', () => w.THREE || document.querySelector('canvas[data-engine*="three"]'), 'window.THREE');
  has('framer-motion', () => document.querySelector('[data-framer-component-type],[data-framer-name],[data-projection-id]'), 'data-framer-* / data-projection-id');
  has('anime.js', () => w.anime, 'window.anime');
  has('Motion One', () => w.Motion, 'window.Motion');
  has('barba/swup(页面转场)', () => w.barba || w.swup || document.querySelector('[data-barba]'), 'barba / swup');
  has('lottie', () => w.lottie || w.bodymovin || document.querySelector('lottie-player,[data-lottie]'), 'lottie');
  has('Spline/rive/WebGL canvas', () => document.querySelector('canvas[data-engine],canvas.webgl,canvas[data-rive]'), 'canvas');
  const srcs = [...document.scripts].map(s => s.src).filter(Boolean).map(s => { try { return new URL(s).pathname.split('/').pop(); } catch { return s; } });
  const hint = srcs.filter(s => /gsap|scrolltrigger|lenis|locomotive|aos|swiper|three|framer|anime|lottie|splide|flickity|barba|swup|motion/i.test(s)).slice(0, 12);
  const st = [];
  try {
    if (w.ScrollTrigger && typeof w.ScrollTrigger.getAll === 'function') {
      for (const t of w.ScrollTrigger.getAll().slice(0, 24)) {
        const v = t.vars || {};
        const tsel = (el) => el && el.tagName ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''}` : String(el || '');
        st.push({ trigger: tsel(t.trigger), start: String(v.start ?? '').slice(0, 40), end: String(v.end ?? '').slice(0, 40), scrub: v.scrub ?? false, pin: !!v.pin, snap: !!v.snap, markers: !!v.markers });
      }
    }
  } catch { /* */ }
  let gsapTweens = null;
  try { if (w.gsap && w.gsap.globalTimeline) gsapTweens = w.gsap.globalTimeline.getChildren(true, true, true).length; } catch { /* */ }
  return { libs, scriptHints: hint, scrollTriggers: st, gsapTweens,
    canvases: document.querySelectorAll('canvas').length,
    videos: document.querySelectorAll('video[autoplay], video').length,
    reducedMotionPref: w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches };
}

/** 滚动对照·第一步：登记候选块元素，记快照 A */
function pageSnapshotInit(cap) {
  const cand = [];
  const SEL = 'section, article, header, footer, main > *, h1, h2, h3, figure, img, li, [class*="reveal"], [class*="fade"], [class*="anim"], [data-aos], [data-scroll], div';
  for (const el of document.querySelectorAll(SEL)) {
    if (cand.length >= cap) break;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 40) continue;
    cand.push(el);
  }
  const snap = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { o: cs.opacity, t: cs.transform, f: cs.filter, cp: cs.clipPath, y: Math.round(r.top + window.scrollY), tr: cs.transitionProperty !== 'all' || cs.transitionDuration !== '0s' ? `${cs.transitionProperty} ${cs.transitionDuration} ${cs.transitionTimingFunction}`.slice(0, 80) : null, an: cs.animationName !== 'none' ? cs.animationName : null }; };
  window.__ndInv = { els: cand, A: cand.map(snap), snap, sel: (el) => { const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''; return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`; } };
  return { count: cand.length, docH: document.documentElement.scrollHeight, vh: window.innerHeight, y0: window.scrollY };
}
function pageSnapshotTake(label) {
  const st = window.__ndInv; if (!st) return null;
  st[label] = st.els.map(st.snap);
  return window.scrollY;
}
function pageSnapshotReport() {
  const st = window.__ndInv; if (!st) return null;
  // identity matrix 和 none 是同一件事；透明度抖 0.02 不算变（真跑逮到 0.979→1 这种噪音）
  const normT = (t) => (!t || t === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(t) || /^matrix3d\(1,\s*0,\s*0,\s*0,\s*0,\s*1,\s*0,\s*0,\s*0,\s*0,\s*1,\s*0,\s*0,\s*0,\s*0,\s*1\)$/.test(t)) ? 'none' : t;
  const changed = (a, b) => Math.abs(Number(a.o) - Number(b.o)) > 0.05 || normT(a.t) !== normT(b.t) || a.f !== b.f || a.cp !== b.cp;
  const reveals = []; const scrubs = [];
  for (let i = 0; i < st.els.length; i += 1) {
    const A = st.A[i]; const B = st.B && st.B[i]; const C = st.C && st.C[i]; const D = st.D && st.D[i];
    if (!D) continue;
    const el = st.els[i];
    if (changed(A, D)) {
      if (reveals.length < 30) reveals.push({ target: st.sel(el), docY: A.y, from: { opacity: A.o, transform: A.t === 'none' ? 'none' : A.t.slice(0, 60) }, to: { opacity: D.o, transform: D.t === 'none' ? 'none' : D.t.slice(0, 60) }, transition: D.tr, animation: D.an });
      reveals.total = (reveals.total || 0) + 1;
    } else if ((B && changed(A, B)) || (C && changed(A, C))) {
      if (scrubs.length < 30) scrubs.push({ target: st.sel(el), docY: A.y, midTransform: B ? B.t.slice(0, 60) : null, midOpacity: B ? B.o : null });
      scrubs.total = (scrubs.total || 0) + 1;
    }
  }
  const out = { candidates: st.els.length, reveals, revealsTotal: reveals.total || 0, scrubs, scrubsTotal: scrubs.total || 0 };
  delete window.__ndInv;
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────

async function readStylesheets(page) {
  const cdp = await page.context().newCDPSession(page);
  const headers = new Map();
  cdp.on('CSS.styleSheetAdded', (ev) => { if (ev?.header?.styleSheetId) headers.set(ev.header.styleSheetId, ev.header); });
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await page.waitForTimeout(120);
  const sheets = []; let total = 0; let skipped = 0;
  for (const [id, h] of headers) {
    if (total > MAX_TOTAL_BYTES) { skipped += 1; continue; }
    try {
      const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: id });
      if (!text) continue;
      const name = h.isInline ? '<style>' : (h.sourceURL ? decodeURIComponent((h.sourceURL.split('?')[0]).split('/').pop() || h.sourceURL) : '(anonymous)');
      sheets.push({ name, bytes: text.length, text: text.slice(0, MAX_SHEET_BYTES) });
      total += text.length;
    } catch { skipped += 1; }
  }
  await cdp.detach().catch(() => {});
  return { sheets, total, skipped };
}

async function scrollProbe(page) {
  const init = await page.evaluate(pageSnapshotInit, CANDIDATE_CAP);
  const vw = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.move(Math.floor(vw.width / 2), Math.floor(vw.height / 2));
  const maxY = Math.max(0, init.docH - init.vh);
  const step = Math.max(120, Math.round(init.vh * 0.35));
  const t0 = Date.now();
  let dispatched = 0; let midTaken = false;
  // 真滚轮：跟用户一样的输入路径，Lenis 那族劫持会在这里现形
  while (Date.now() - t0 < SCROLL_BUDGET_MS) {
    await page.mouse.wheel(0, step); dispatched += step;
    await page.waitForTimeout(70);
    const y = await page.evaluate(() => window.scrollY);
    if (!midTaken && y >= maxY / 2) { await page.evaluate(pageSnapshotTake, 'B'); midTaken = true; }
    if (y >= maxY - 2 || dispatched > maxY + init.vh * 2) break;
  }
  await page.waitForTimeout(300);
  const yBottom = await page.evaluate(pageSnapshotTake, 'C');
  const hijack = dispatched > 0 && maxY > 200 && yBottom < Math.min(maxY, dispatched) * 0.6;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(400);
  await page.evaluate(pageSnapshotTake, 'D');
  const rep = await page.evaluate(pageSnapshotReport);
  return { ...rep, docHeight: init.docH, viewportHeight: init.vh, dispatchedPx: dispatched, reachedY: yBottom, hijackSuspected: hijack, tookMs: Date.now() - t0 };
}

/**
 * @param {import('playwright').Page} page
 * @param {{scrollProbe?: boolean}} [opts]
 */
export async function collectMotionInventory(page, { scrollProbe: doScroll = true } = {}) {
  const inv = { url: page.url(), errors: [] };
  try {
    const { sheets, total, skipped } = await readStylesheets(page);
    inv.stylesheets = { count: sheets.length, bytes: total, skipped, names: sheets.map(s => s.name).slice(0, 20) };
    inv.css = mergeScans(sheets.map(s => scanCss(s.text, s.name)));
  } catch (err) { inv.errors.push(`stylesheets: ${err.message.split('\n')[0]}`); }
  try { inv.libs = await page.evaluate(pageLibs); } catch (err) { inv.errors.push(`libs: ${err.message.split('\n')[0]}`); }
  if (doScroll) {
    try { inv.scroll = await scrollProbe(page); } catch (err) { inv.errors.push(`scroll probe: ${err.message.split('\n')[0]}`); }
  }
  // 滚动对照把 reveal 都触发过了，这时再读运行时账本最全
  try { inv.runtime = await page.evaluate(pageRuntimeAnimations); } catch (err) { inv.errors.push(`getAnimations: ${err.message.split('\n')[0]}`); }
  return inv;
}

// ── 给 agent 的人话 ──────────────────────────────────────────

export function formatMotionInventory(inv) {
  const L = [];
  const c = inv.css; const l = inv.libs; const s = inv.scroll; const r = inv.runtime;
  if (l) {
    const names = l.libs.map(x => x.name);
    L.push(`动效库：${names.length ? names.join('、') : '没探到已知库（原生 CSS / 自写 JS）'}`
      + (l.gsapTweens != null ? `；GSAP 时间轴上 ${l.gsapTweens} 个 tween` : '')
      + (l.canvases ? `；${l.canvases} 个 <canvas>（里面的动画 DOM 层看不见，要看用胶片条）` : '')
      + (l.scriptHints.length ? `；脚本名线索：${l.scriptHints.join(' ')}` : ''));
    if (l.scrollTriggers.length) {
      L.push(`ScrollTrigger ×${l.scrollTriggers.length}：` + l.scrollTriggers.slice(0, 6).map(t => `${t.trigger}[${t.start}→${t.end}${t.scrub ? ` scrub=${t.scrub}` : ''}${t.pin ? ' pin' : ''}]`).join(' · '));
    }
  }
  if (c) {
    const bits = [];
    if (c.keyframes.total) bits.push(`@keyframes ×${c.keyframes.total}（${c.keyframes.slice(0, 8).map(k => k.name).join(' ')}）`);
    if (c.animations.total) bits.push(`animation 声明 ×${c.animations.total}`);
    if (c.transitions.total) bits.push(`transition 声明 ×${c.transitions.total}`);
    if (c.scrollTimeline.total) bits.push(`⭐ CSS 滚动驱动动画（animation-timeline/scroll()/view()）×${c.scrollTimeline.total}`);
    if (c.scrollSnap.total) bits.push(`scroll-snap ×${c.scrollSnap.total}（${c.scrollSnap.slice(0, 3).map(x => `${x.selector}: ${x.value}`).join('; ')}）`);
    if (c.sticky.total) bits.push(`sticky ×${c.sticky.total}`);
    if (c.willChange) bits.push(`will-change ×${c.willChange}`);
    if (c.viewTransitions) bits.push(`@view-transition ×${c.viewTransitions}`);
    L.push(`CSS（${inv.stylesheets?.count ?? 0} 张表，${((inv.stylesheets?.bytes ?? 0) / 1024).toFixed(0)}KB）：${bits.length ? bits.join('；') : '没有动画/过渡声明'}`
      + (c.reducedMotion ? '；有 prefers-reduced-motion 分支' : '；没做 prefers-reduced-motion'));
    if (c.transitions.length) L.push('  典型过渡：' + c.transitions.slice(0, 4).map(t => `${t.selector} {${t.transition}}`).join(' · '));
    if (c.animations.length) L.push('  典型动画：' + c.animations.slice(0, 4).map(a => `${a.selector} {${a.animation}}`).join(' · '));
    if (c.scrollTimeline.length) L.push('  滚动驱动：' + c.scrollTimeline.slice(0, 4).map(a => `${a.selector} {${a.timeline}}`).join(' · '));
  }
  if (s) {
    L.push(`滚动对照（真滚轮滚了 ${s.dispatchedPx}px，页面到 ${s.reachedY}/${Math.max(0, s.docHeight - s.viewportHeight)}）：`
      + `入场 reveal ${s.revealsTotal} 个 · 随滚动位置走的（scrub/视差）${s.scrubsTotal} 个`
      + (s.hijackSuspected ? ' · ⚠ 疑似滚动劫持（派发的滚轮像素远多于页面真滚的）' : ''));
    if (s.reveals.length) L.push('  reveal 样本：' + s.reveals.slice(0, 5).map(x => `${x.target} ${x.from.opacity}/${x.from.transform}→${x.to.opacity}/${x.to.transform}${x.transition ? ` [${x.transition}]` : ''}${x.animation ? ` [anim ${x.animation}]` : ''}`).join(' · '));
    if (s.scrubs.length) L.push('  scrub/视差样本：' + s.scrubs.slice(0, 5).map(x => `${x.target}（滚到一半时 ${x.midTransform}）`).join(' · '));
  }
  if (r) {
    L.push(`运行时（getAnimations，滚过一遍后）：${r.count} 条活着的` + (r.items.length ? '：' + r.items.slice(0, 6).map(a => `${a.target} ${a.name || a.kind} ${a.duration}ms ${a.easing}${a.iterations === Infinity ? ' ∞' : ''}`).join(' · ') : ''));
  }
  if (inv.errors?.length) L.push(`（这几路没采到：${inv.errors.join('；')}）`);
  return L;
}
