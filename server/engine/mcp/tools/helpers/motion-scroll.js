/**
 * helpers/motion-scroll.js — 录制期的真滚轮驱动 + 元素探针报告（2026-08-21）
 *
 * 跟 motion-lab.js 配套、对页面无知：浏览通道（参考站）和感知通道（自己的产物）共用。
 *
 * - wheelScroll：在 recordMotion 的 `during` 里跑 —— 按 16ms 一 tick 派发真滚轮事件，
 *   跟 profile_scroll 同一条输入路径（滚动劫持那族只认这个，window.scrollTo 对它们无效）。
 * - elementMotionReport：motion-lab 元素探针的逐帧样本 → "谁在动、怎么动"的人话。
 *   样本是文档坐标，所以滚动本身不算动；算的是入场（位移+透明度）、视差（位移跟
 *   滚动量不成比例）、缩放、固定元素随视口走。
 */

/**
 * 真滚轮滚 px 像素，摊在 durationMs 里。返回一句给 caption 的话（派发了多少、页面真滚了多少）。
 * @param {import('playwright').Page} page
 */
export async function wheelScroll(page, { px, durationMs, at = null }) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const [cx, cy] = at || [Math.floor(vp.width / 2), Math.floor(vp.height / 2)];
  await page.mouse.move(cx, cy);
  const y0 = await page.evaluate(() => window.scrollY).catch(() => 0);
  // 按**时间预算**派发，不按固定 tick 数：每次 mouse.wheel 在这台 1 vCPU 机器上是一次
  // 往返（10~30ms 不等），固定 16ms × N 次会拖过录制窗口（真跑逮到：劫持说明没赶上
  // caption）。改成"过了多少时间就该派到多少像素"，到点必停。
  const t0 = Date.now();
  let dispatched = 0;
  while (true) {
    const elapsed = Date.now() - t0;
    const due = Math.min(px, px * (elapsed / durationMs));
    const delta = due - dispatched;
    if (Math.abs(delta) >= 1) { await page.mouse.wheel(0, delta); dispatched += delta; }
    if (elapsed >= durationMs) break;
    await page.waitForTimeout(16);
  }
  if (Math.abs(px - dispatched) >= 1) { await page.mouse.wheel(0, px - dispatched); dispatched = px; }
  await page.waitForTimeout(80);
  const y1 = await page.evaluate(() => window.scrollY).catch(() => y0);
  const moved = y1 - y0;
  const note = `wheel-scrolled ${Math.round(px)}px over ${durationMs}ms → window moved ${Math.round(moved)}px`;
  if (px > 200 && Math.abs(moved) < Math.abs(px) * 0.5) {
    return `${note} — ⚠ the page moved far less than dispatched: scroll hijacking (Lenis/Locomotive-style smooth scroll) or a scroll container that is not the window`;
  }
  return note;
}

/** 一个元素的样本 → 统计 */
function summarize(e) {
  const s = e.samples;
  if (s.length < 3) return null;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  let minO = Infinity; let maxO = -Infinity; let minS = Infinity; let maxS = -Infinity;
  for (const [, x, y, o, sc] of s) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (o < minO) minO = o; if (o > maxO) maxO = o; if (sc < minS) minS = sc; if (sc > maxS) maxS = sc;
  }
  const dx = maxX - minX; const dy = maxY - minY;
  const travel = Math.hypot(dx, dy);
  const fade = maxO - minO;
  const scale = maxS - minS;
  // 首末变化时刻：第一个/最后一个和起点不同的样本
  const [t00, x0, y0, o0, s0] = s[0];
  const diff = (r) => Math.abs(r[1] - x0) > 1 || Math.abs(r[2] - y0) > 1 || Math.abs(r[3] - o0) > 0.02 || Math.abs(r[4] - s0) > 0.01;
  let start = null; let end = null;
  for (const r of s) { if (diff(r)) { if (start == null) start = r[0]; end = r[0]; } }
  return { sel: e.sel, fixed: !!e.fixed, travel, dx, dy, fade, scale, from: { x: x0, y: y0, o: o0, s: s0 }, to: { x: s[s.length - 1][1], y: s[s.length - 1][2], o: s[s.length - 1][3], s: s[s.length - 1][4] }, startMs: start, endMs: end, t0: t00, n: s.length };
}

/**
 * 元素探针样本 → 报告。`scrolledPx`（录制期 window 真滚了多少）用来把"随视口走的固定
 * 元素"和"视差"从"真入场"里分开：文档坐标下固定元素的位移 ≈ 滚动量，视差 ≈ 滚动量的
 * 一个比例，入场动画的位移跟滚动量无关。
 */
export function elementMotionReport(elems, { scrolledPx = 0 } = {}) {
  const rows = (elems || []).map(summarize).filter(Boolean);
  const moving = rows.filter(r => r.travel > 3 || r.fade > 0.05 || r.scale > 0.02);
  const classify = (r) => {
    const tags = [];
    // fixed/sticky 层（含其子元素）：文档坐标天然随视口走，报成"固定层"而不是视差/位移
    if (r.fixed && r.travel > 3) tags.push(`fixed/sticky 层（随视口走，dy ${r.dy}${scrolledPx ? `，滚动量 ${Math.round(scrolledPx)}` : ''}）`);
    // 视差：位移是滚动量的一个明显比例（≥15%）且只在竖向、不带淡入 —— 入场那种 40~120px
    // 的平移在上千像素的滚动里占比很小，归"位移"不归视差
    else if (scrolledPx && Math.abs(r.dy) >= Math.abs(scrolledPx) * 0.15 && Math.abs(r.dy) < Math.abs(scrolledPx) * 0.95 && Math.abs(r.dx) < 8 && r.fade < 0.05) tags.push(`视差（位移≈滚动量的 ${(Math.abs(r.dy) / Math.abs(scrolledPx) * 100).toFixed(0)}%）`);
    else if (r.travel > 3) tags.push(`位移 ${Math.round(r.travel)}px（dx ${r.dx}, dy ${r.dy}）`);
    if (r.fade > 0.05) tags.push(`透明度 ${r.from.o}→${r.to.o}`);
    if (r.scale > 0.02) tags.push(`缩放 ${r.from.s}→${r.to.s}`);
    return tags;
  };
  const score = (r) => r.travel + r.fade * 200 + r.scale * 200;
  // 固定层排最后：它们"动"是因为视口动了，真正有信息量的是前面那些
  const items = moving.map(r => ({ ...r, tags: classify(r) }))
    .sort((a, b) => (a.fixed === b.fixed ? score(b) - score(a) : (a.fixed ? 1 : -1)));
  return { total: rows.length, moving: items.length, items };
}

/** 报告 → 给 agent 的行。固定层的子元素合并成一行（真跑时一个页头 15 个链接刷了 15 行）。 */
export function elementMotionLines(rep, { max = 10 } = {}) {
  if (!rep || !rep.total) return ['element probe: no elements sampled'];
  if (!rep.moving) return [`element probe: ${rep.total} elements watched, none moved/faded/scaled during the recording`];
  const free = rep.items.filter(r => !r.fixed);
  const fixed = rep.items.filter(r => r.fixed);
  const lines = [`element probe: ${rep.moving} of ${rep.total} watched elements moved during the recording:`];
  for (const r of free.slice(0, max)) {
    const when = r.startMs != null ? `${Math.max(0, Math.round(r.startMs))}→${Math.round(r.endMs)}ms` : '';
    lines.push(`  ${r.sel}  ${r.tags.join(' · ')}${when ? `  [${when}]` : ''}`);
  }
  if (free.length > max) lines.push(`  (+${free.length - max} more)`);
  if (fixed.length) {
    const names = [...new Set(fixed.map(r => r.sel))].slice(0, 4).join(', ');
    lines.push(`  fixed/sticky 层 ×${fixed.length}（${names}${fixed.length > 4 ? ' …' : ''}）随视口走 —— 页头/浮层那类，不是页面内容在动`);
  }
  return lines;
}
