/**
 * server/lib/board-groups.js —— 画布的「组」与「小地图」（2026-08-23 黑板）
 *
 * 黑板不设几何容器（用户拍板：frame 给黑板开小灶，终局产物卡也要走同一套）。
 * 「组」是派生的：**被线连在一起的一群东西算一组**（连通分量），再加上显式
 * `tag` 字段把没连线的也归到一起。read_board 按组分段输出、用户按组整选、渲染
 * 按组画包络，三处读同一个判据 —— 入座算法里「关系组独占成行」用的也是连通
 * 分量，没有第二份真相。
 *
 * 小地图：把一层的物件投到一张 ≤ 48×16 的字符网格上。模型读网格的整体感远比
 * 读三十行坐标强；从 board.json 直接算，零成本。
 */

/**
 * 连通分量 + tag 合并。
 * @param {string[]} ids           这一层的物件 id
 * @param {object}  bindings       board.bindings
 * @param {(id:string)=>string|null} tagOf
 * @returns {Array<{ members: string[], tags: Set<string>, edges: string[] }>}  大组在前
 */
export function groupObjects(ids, bindings, tagOf = () => null) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const edgesIn = [];
  for (const [bid, b] of Object.entries(bindings || {})) {
    if (b.by === 'auto' && b.type === 'ref') continue;   // 自动取材边不成组（蜘蛛网）
    if (parent.has(b.from) && parent.has(b.to)) { union(b.from, b.to); edgesIn.push([bid, b]); }
  }
  // 同 tag 归一组
  const byTag = new Map();
  for (const id of ids) {
    const t = tagOf(id);
    if (!t) continue;
    if (!byTag.has(t)) byTag.set(t, id); else union(byTag.get(t), id);
  }
  const groups = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, { members: [], tags: new Set(), edges: [] });
    const g = groups.get(r);
    g.members.push(id);
    const t = tagOf(id); if (t) g.tags.add(t);
  }
  for (const [bid, b] of edgesIn) {
    const g = groups.get(find(b.from));
    if (g) g.edges.push(bid);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * ASCII 小地图。
 * @param {Array<{id:string,x:number,y:number,w:number,h:number}>} rects
 * @param {{ cols?: number, rows?: number, viewport?: {x,y,w,h}|null }} opts
 * @returns {{ grid: string, legend: Array<[string,string]>, bbox: {x,y,w,h} }|null}
 */
export function asciiMinimap(rects, { cols = 48, rows = 16, viewport = null } = {}) {
  if (!rects.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  if (viewport) {
    x0 = Math.min(x0, viewport.x); y0 = Math.min(y0, viewport.y);
    x1 = Math.max(x1, viewport.x + viewport.w); y1 = Math.max(y1, viewport.y + viewport.h);
  }
  const W = Math.max(1, x1 - x0); const H = Math.max(1, y1 - y0);
  // 等比：一个字符格近似正方（字符高宽比约 2:1，所以横向给两倍格数）
  const scale = Math.max(W / cols, H / (rows * 2));
  const gw = Math.max(1, Math.ceil(W / scale));
  const gh = Math.max(1, Math.ceil(H / (scale * 2)));
  const grid = Array.from({ length: gh }, () => Array(gw).fill('·'));
  const legend = [];
  if (viewport) {
    // 视口边框用 +─│ 画在底下，物件盖在上面
    const cx0 = Math.floor((viewport.x - x0) / scale); const cx1 = Math.min(gw - 1, Math.floor((viewport.x + viewport.w - x0) / scale));
    const cy0 = Math.floor((viewport.y - y0) / (scale * 2)); const cy1 = Math.min(gh - 1, Math.floor((viewport.y + viewport.h - y0) / (scale * 2)));
    for (let x = cx0; x <= cx1; x += 1) { if (grid[cy0]) grid[cy0][x] = '─'; if (grid[cy1]) grid[cy1][x] = '─'; }
    for (let y = cy0; y <= cy1; y += 1) { if (grid[y]) { grid[y][cx0] = '│'; grid[y][cx1] = '│'; } }
    if (grid[cy0]) { grid[cy0][cx0] = '┌'; grid[cy0][cx1] = '┐'; }
    if (grid[cy1]) { grid[cy1][cx0] = '└'; grid[cy1][cx1] = '┘'; }
  }
  rects.forEach((r, i) => {
    const g = i < GLYPHS.length ? GLYPHS[i] : '#';
    legend.push([g, r.id]);
    const cx0 = Math.floor((r.x - x0) / scale); const cx1 = Math.min(gw - 1, Math.max(cx0, Math.ceil((r.x + r.w - x0) / scale) - 1));
    const cy0 = Math.floor((r.y - y0) / (scale * 2)); const cy1 = Math.min(gh - 1, Math.max(cy0, Math.ceil((r.y + r.h - y0) / (scale * 2)) - 1));
    for (let y = cy0; y <= cy1; y += 1) for (let x = cx0; x <= cx1; x += 1) if (grid[y]) grid[y][x] = g;
  });
  return {
    grid: grid.map(row => row.join('')).join('\n'),
    legend,
    bbox: { x: Math.round(x0), y: Math.round(y0), w: Math.round(W), h: Math.round(H) },
    cell: Math.round(scale),
  };
}
