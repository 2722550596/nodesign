/**
 * server/projects/board-store.js — 工作台画布布局的唯一读写方（2026-07-27 分区版）
 *
 * HTTP 路由（api/board.js）和 MCP 工具（pin-to-board）都经这里读写，
 * 带 per-project 写锁串行化读改写，避免前端 PATCH 与 agent 写入互相覆盖。
 *
 * schema（shared/board.json）：
 *   {
 *     size: { w, h },
 *     zones: { [zoneId]: { x, y } },   // zoneId = 文件夹的工作区相对路径（#14 只剩坐标）
 *     objects: { [objectId]: { x, y, z, w?, h?, expanded? } },
 *     bindings: { [bindingId]: { type, from, to, label?, by? } }   // 关系线
 *   }
 *
 * 布局只存摆放，物件本体由 artifacts / sessions / memory 数据源派生。
 * **关系是例外**：bindings 不是任何数据源的派生，board.json 就是它的真相
 * （2026-08-07 加，词汇表见 server/lib/binding-types.js）。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getSharedDir, ensureProjectWorkspace, gitRenamesSince } from './workspace.js';
import { isBindingType } from '../lib/binding-types.js';

export const DEFAULT_BOARD_SIZE = { w: 4000, h: 2600 };
export const MAX_BOARD_BYTES = 512 * 1024;
export const MAX_OBJECTS = 2000;
export const MAX_ZONES = 200;
// 关系线上限。取值理由：一块板上人能看懂的线远少于这个数，1000 是防脱缰
// （agent 循环里连画）的闸门，不是设计目标。超了直接不收，不做淘汰 ——
// 静默丢最旧的会让"我明明画了"变成玄学。
export const MAX_BINDINGS = 1000;

// 分区自动铺位常数 —— 与前端 BoardCanvas 的 ZONE_* 保持一致（数值约定，非共享代码）
// ZONE_DEFAULTS 已删（#14）：它是"文件夹=版面上一整条带"时代的默认矩形，
// zones 瘦身后连兜底都用不上了。前端 board-geometry.js 的注释别再指着它对齐。

function boardPath(pid) {
  return path.join(getSharedDir(pid), 'board.json');
}

// ── per-project 写锁（进程内串行化）──
const locks = new Map();
function withBoardLock(pid, fn) {
  const prev = locks.get(pid) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(pid, run.catch(() => {}));
  return run;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSize(raw) {
  return {
    w: clampNum(raw?.w, 1000, 20000, DEFAULT_BOARD_SIZE.w),
    h: clampNum(raw?.h, 800, 20000, DEFAULT_BOARD_SIZE.h),
  };
}

/**
 * **画布原生**物件的形态白名单。
 *
 * 绝大多数画布物件是磁盘产物的影子：board.json 只存它摆在哪，本体是文件
 * （所以 agent 读得到、能进上下文、删文件即消失）。涂鸦不一样 —— 它没有
 * 有意义的文件形态，board.json 就是它的**本体**。这类物件必须显式登记，
 * 否则任何人往 objects 里塞一个 kind 就能造出一个不受形态表管的东西。
 *
 * 2026-08-08 加进 `text`。在那之前画布上打的字一律落成 `.md` 便签，理由是
 * "agent 读得到"。但用户要的是**白板**：在工程文件旁边随手写一句、画一笔，
 * 那是给自己的记号，不是给 agent 的输入。想让 agent 看见的写便利贴 ——
 * 那条路还在，挪到了右键菜单里。
 */
const CANVAS_NATIVE_KINDS = new Set(['scribble', 'text']);

/**
 * 坐标夹持上限。画布 2026-08-13 起全向无限，坐标不再由 board.size 夹住 ——
 * 这个数只挡非有限值和纯属事故的数字（±100 万世界像素之外没有正常操作能到）。
 */
const COORD_LIMIT = 1e6;

/** 涂鸦路径串上限。一条随手画的线约 300~800 字符，8000 够长且撑不爆 board.json */
const MAX_SCRIBBLE_PATH = 8000;
/**
 * 画布文字的字数上限。
 *
 * 它是"写在白板上的一句话"，不是文档 —— 长东西该写成 .md（那是便利贴，
 * agent 读得到）。2000 字够写一段说明，也撑不爆 board.json。
 */
const MAX_TEXT_LEN = 2000;

/** 画布文字可选的字体。**白名单而不是自由字符串** —— 这个值会进 CSS */
export const TEXT_FONTS = ['pen', 'kai', 'sans', 'serif', 'mono'];
const TEXT_SIZES = ['sm', 'md', 'lg', 'xl'];

/**
 * 变换字段（2026-08-13，选中态控制器）。缺省不落字段 —— 没转过没缩过的物件
 * 别背两个恒等值，board.json 的 diff 要能一眼看出"谁被动过"。
 */
function sanitizeTransform(data) {
  const out = {};
  const rot = Number(data?.rotation);
  if (Number.isFinite(rot) && rot !== 0) out.rotation = clampNum(rot, -360, 360, 0);
  const sc = Number(data?.scale);
  if (Number.isFinite(sc) && sc !== 1) out.scale = clampNum(sc, 0.2, 10, 1);
  return out;
}

function sanitizeCanvasData(kind, data) {
  if (kind === 'text') {
    const t = typeof data?.t === 'string' ? data.t.slice(0, MAX_TEXT_LEN) : '';
    if (!t.trim()) return null;
    return {
      t,
      font: TEXT_FONTS.includes(data?.font) ? data.font : 'kai',
      size: TEXT_SIZES.includes(data?.size) ? data.size : 'md',
      color: ['ink', 'red', 'pencil', 'brass'].includes(data?.color) ? data.color : 'ink',
      ...sanitizeTransform(data),
    };
  }
  if (kind !== 'scribble') return null;
  const d = typeof data?.d === 'string' ? data.d.slice(0, MAX_SCRIBBLE_PATH) : '';
  // 只收 SVG path 里合法的那几个字符，挡住任何往 DOM 里塞东西的尝试
  if (!d || !/^[\dMLQCZ ,.\-eE]+$/.test(d)) return null;
  return {
    d,
    color: ['ink', 'red', 'pencil', 'brass'].includes(data.color) ? data.color : 'ink',
    width: clampNum(data.width, 1, 24, 2),
    ...sanitizeTransform(data),
  };
}

function sanitizeObject(o, size) {
  if (!o || typeof o !== 'object') return null;
  const kind = typeof o.kind === 'string' && CANVAS_NATIVE_KINDS.has(o.kind) ? o.kind : null;
  const data = kind ? sanitizeCanvasData(kind, o.data) : null;
  // 登记了 kind 却给不出合法内容 → 整条丢弃。留一个空壳会在画布上变成
  // 一个看不见也删不掉的幽灵物件。
  if (kind && !data) return null;
  return {
    // 画布 2026-08-13 起全向无限：坐标不再被桌面尺寸夹持（原来非 native 只许
    // 正区间、native 也出不了 ±size）。这里只挡非有限值和纯属事故的数字 ——
    // 夹得再紧一点都意味着"用户摆在那儿的东西刷新后跳走"，那是静默数据损坏。
    x: clampNum(o.x, -COORD_LIMIT, COORD_LIMIT, 0),
    y: clampNum(o.y, -COORD_LIMIT, COORD_LIMIT, 0),
    z: clampNum(o.z, 0, 1e6, 0),
    ...(Number.isFinite(Number(o.w)) ? { w: clampNum(o.w, 4, COORD_LIMIT, 200) } : {}),
    ...(Number.isFinite(Number(o.h)) ? { h: clampNum(o.h, 4, COORD_LIMIT, 200) } : {}),
    ...(o.expanded ? { expanded: true } : {}),
    // 显式归属：'' = 明确无归属（覆盖 sid 派生），非空 = 所属工作区 id
    ...(typeof o.zone === 'string' && o.zone.length <= 300 ? { zone: o.zone } : {}),
    ...(kind ? { kind, data } : {}),
  };
}

/**
 * 关系线。**不存坐标** —— 端点是 object id 或 zone id，线跟着端点走。
 *
 * 词汇表在 `server/lib/binding-types.js`（前端画线那份视觉映射要跟它对齐，
 * 有 parity 断言看着）。不认识的 type 一律丢弃：宁可少画一条线，也不要在
 * 画布上留一条没人知道什么意思的连线。
 *
 * 自环（from === to）也丢：它画不出来，且多半是 agent 传错了 id。
 */
function sanitizeBinding(b) {
  if (!b || typeof b !== 'object') return null;
  if (!isBindingType(b.type)) return null;
  const from = typeof b.from === 'string' ? b.from.slice(0, 300) : '';
  const to = typeof b.to === 'string' ? b.to.slice(0, 300) : '';
  if (!from || !to || from === to) return null;
  return {
    type: b.type,
    from,
    to,
    // 线上的字。没写就渲染时回落到词汇表的默认词，不在这里补 —— 存了默认词
    // 之后改词汇表就改不动存量了。
    ...(typeof b.label === 'string' && b.label.trim()
      ? { label: b.label.trim().slice(0, 60) }
      : {}),
    // 谁画的。用户画的线 agent 不该擅自删，反过来也一样。
    ...(b.by === 'agent' || b.by === 'user' ? { by: b.by } : {}),
  };
}

/**
 * zones 一行只剩坐标（2026-08-13 瘦身，#14）。
 *
 * 逐字段的下场：
 * - `w`/`h` —— 文件夹变方卡后前端视图**强制** FOLDER_CARD 尺寸，存的数字
 *   没人读，还会成为"画布上 288 宽、存档里 1340"那种自相矛盾的证据。
 * - `title` —— 名字从路径读（id 就是路径），存一份就是第二个真相源，
 *   改名后立刻过期（实测过）。
 * - `collapsed` —— 收起/展开两态 2026-08-13 随"当前目录"模型退役。
 * - `pinned` —— 纵向堆叠 2026-08-08 退役，字段没有了对立面。
 * 存量数据里这些字段读进来直接丢，下次写盘自然消失。
 */
function sanitizeZone(z) {
  if (!z || typeof z !== 'object') return null;
  return {
    // 同 sanitizeObject：无限画布，文件夹卡也能摆在任何地方（含负坐标）
    x: clampNum(z.x, -COORD_LIMIT, COORD_LIMIT, 0),
    y: clampNum(z.y, -COORD_LIMIT, COORD_LIMIT, 0),
  };
}

function sanitizeBoard(raw) {
  const size = sanitizeSize(raw?.size);
  const objects = {};
  const zones = {};
  const bindings = {};
  let count = 0;
  for (const [id, o] of Object.entries(raw?.objects && typeof raw.objects === 'object' ? raw.objects : {})) {
    if (count >= MAX_OBJECTS) break;
    if (typeof id !== 'string' || id.length > 300) continue;
    const s = sanitizeObject(o, size);
    if (s) { objects[id] = s; count += 1; }
  }
  let zCount = 0;
  for (const [id, z] of Object.entries(raw?.zones && typeof raw.zones === 'object' ? raw.zones : {})) {
    if (zCount >= MAX_ZONES) break;
    if (typeof id !== 'string' || id.length > 300) continue;
    const s = sanitizeZone(z);
    if (s) { zones[id] = s; zCount += 1; }
  }
  let bCount = 0;
  for (const [id, b] of Object.entries(raw?.bindings && typeof raw.bindings === 'object' ? raw.bindings : {})) {
    if (bCount >= MAX_BINDINGS) break;
    if (typeof id !== 'string' || id.length > 300) continue;
    const s = sanitizeBinding(b);
    if (s) { bindings[id] = s; bCount += 1; }
  }
  return { size, zones, objects, bindings };
}

export async function readBoard(pid) {
  try {
    const raw = await fs.readFile(boardPath(pid), 'utf8');
    return sanitizeBoard(JSON.parse(raw));
  } catch {
    return { size: { ...DEFAULT_BOARD_SIZE }, zones: {}, objects: {}, bindings: {} };
  }
}

async function writeBoard(pid, board) {
  const json = JSON.stringify(board);
  if (Buffer.byteLength(json) > MAX_BOARD_BYTES) {
    const err = new Error('board layout too large');
    err.status = 400;
    throw err;
  }
  await ensureProjectWorkspace(pid);
  await fs.writeFile(boardPath(pid), json, 'utf8');
}

/** 全量替换（前端 reset / 兼容旧 PUT）。 */
export function replaceBoard(pid, raw) {
  return withBoardLock(pid, async () => {
    const board = sanitizeBoard(raw);
    await writeBoard(pid, board);
    return board;
  });
}

/**
 * diff 式合并写：{ size?, objects?: {id: obj|null}, zones?: {id: zone|null} }
 * null 值 = 删除该条目。返回合并后的完整 board。
 */
export function patchBoard(pid, patch) {
  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    if (patch?.size) board.size = sanitizeSize(patch.size);
    // 本次被显式删掉的端点 id。**不能拿 board.objects 的成员资格当存在性判据**：
    // 它是稀疏的（只存被拖过 / pin 过的物件，没动过的产物压根没有条目），
    // 那样会把连向"还没被摆过的产物"的线全误删。只清确实删了的。
    const removed = new Set();
    // 拿着旧 id 迟到的写入要落到新名字上（前端 800ms 防抖 / agent 本轮的旧路径）。
    // 不转发的话它会把刚改完名的旧条目**重新插回来**，画布上多出一张回到默认
    // 位置的重影，而且不报错。见 renameBoardPaths 上面那段。
    const fwd = (id) => forwardId(pid, id);
    if (patch?.zones && typeof patch.zones === 'object') {
      for (const [rawId, z] of Object.entries(patch.zones)) {
        if (typeof rawId !== 'string' || rawId.length > 300) continue;
        const id = fwd(rawId);
        if (z === null) { delete board.zones[id]; removed.add(id); continue; }
        const s = sanitizeZone(z);
        if (s && (board.zones[id] || Object.keys(board.zones).length < MAX_ZONES)) board.zones[id] = s;
      }
    }
    if (patch?.objects && typeof patch.objects === 'object') {
      for (const [rawId, o] of Object.entries(patch.objects)) {
        if (typeof rawId !== 'string' || rawId.length > 300) continue;
        const id = fwd(rawId);
        if (o === null) { delete board.objects[id]; removed.add(id); continue; }
        const s = sanitizeObject(o, board.size);
        if (s && (board.objects[id] || Object.keys(board.objects).length < MAX_OBJECTS)) board.objects[id] = s;
      }
    }
    if (patch?.bindings && typeof patch.bindings === 'object') {
      for (const [id, b] of Object.entries(patch.bindings)) {
        if (typeof id !== 'string' || id.length > 300) continue;
        if (b === null) { delete board.bindings[id]; continue; }
        const s = sanitizeBinding(b);
        if (!s) continue;
        // 端点也要转发：agent 本轮拿旧路径连的线，落下来必须连到新名字上
        const fixed = { ...s, from: fwd(s.from), to: fwd(s.to) };
        if (board.bindings[id] || Object.keys(board.bindings).length < MAX_BINDINGS) board.bindings[id] = fixed;
      }
    }
    // 端点被删掉的线一起清掉，否则画布上留一条连向虚空的线。放在最后：
    // 这一趟才看得到本次删除的全貌（同一个 patch 里可能既删物件又加线）。
    if (removed.size) {
      for (const [id, b] of Object.entries(board.bindings)) {
        if (removed.has(b.from) || removed.has(b.to)) delete board.bindings[id];
      }
    }
    await writeBoard(pid, board);
    return board;
  });
}

// ── 改名（2026-08-08）────────────────────────────────────────────────────
//
// id 是**工作区相对路径**，所以文件一动，画布上的身份就跟着变。移动从罕见事件
// 变成日常动作（拖进文件夹 = 真 mv）之后，这件事必须有一等公民的地位。
//
// ## 为什么不能用 patchBoard 删旧插新
//
// patchBoard 末尾那段"端点被删的线一起清掉"会把指向旧 id 的 `annotates` 线
// 一并删掉 —— 也就是**每拖一次卡，挂在它上面的评论就没了**。删除和改名是
// 两件事：删除意味着"这东西不在了，连着它的线也没意义了"，改名意味着
// "还是它，换了个名字"。用同一个动词表达，必然丢掉后者的语义。

/**
 * 改名的转发表：**旧 id → 新 id**，带 TTL。
 *
 * 改名不是一次写入，是三个并发写方都得学会的一件事：
 *   ① 服务端（这里）——立刻知道
 *   ② 前端画布 —— scheduleSave 是 800ms 防抖，从 layoutRef 按**旧 id** 组 patch，
 *      改完名之后那一发迟到的 flush 会把 objects[旧id] 重新插回来
 *   ③ agent —— 这一轮的上下文里还是旧路径，会继续往旧 id 上 pin、上批注
 *
 * 不转发的话，表现是"拖进文件夹时灵时不灵"（迟到的写入把旧条目复活，画布上
 * 就多出一张回到默认位置的重影）。这类症状最难查，因为它**不报错**。
 *
 * 内存表 + TTL 够用：它只需要盖住"改完名之后还有人拿着旧 id"那个窗口。
 * 进程重启、以及 agent 在画布背后自己 mv 的情况，由 git 改名对账兜底
 * （见 workspace.js 的 reconcileBoardRenames）。
 */
const RENAME_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, Map<string, { to: string, at: number }>>} pid → (旧 id → 新 id) */
const renameJournal = new Map();

function journalOf(pid) {
  let m = renameJournal.get(pid);
  if (!m) { m = new Map(); renameJournal.set(pid, m); }
  return m;
}

function noteRenames(pid, pairs, now) {
  const j = journalOf(pid);
  for (const [from, to] of pairs) j.set(from, { to, at: now });
  for (const [k, v] of j) if (now - v.at > RENAME_TTL_MS) j.delete(k);
}

/**
 * 把一个可能过期的 id 换成它现在的名字。
 * 顺着链走（`a→b` 之后又 `b→c`，拿着 a 的迟到写入要落到 c 上）。
 */
export function forwardId(pid, id, now = Date.now()) {
  const j = renameJournal.get(pid);
  if (!j || typeof id !== 'string') return id;
  let cur = id;
  for (let hop = 0; hop < 8; hop++) {
    const e = j.get(cur);
    if (!e || now - e.at > RENAME_TTL_MS) return cur;
    cur = e.to;
  }
  return cur;
}

/**
 * 把一个**文件路径**换成它现在的位置 —— forwardId 的前缀感知版（#4）。
 *
 * forwardId 只做精确匹配，够画布用（物件 id 整个换）。但 artifact-file
 * 拿的是文件路径：文件夹 `稿件` 改成 `定稿` 之后，开着的窗还在请求
 * `稿件/主稿.html` —— 表里只有 `稿件 → 定稿` 这一条，精确匹配永远打不中。
 * 这里按**最长前缀**找（全路径 → 上级 → 再上级），命中就把前缀换掉接着走链。
 */
export function forwardPath(pid, rel, now = Date.now()) {
  const j = renameJournal.get(pid);
  if (!j || typeof rel !== 'string' || !rel) return rel;
  let cur = rel;
  for (let hop = 0; hop < 8; hop++) {
    let next = null;
    const segs = cur.split('/');
    for (let i = segs.length; i > 0; i--) {
      const prefix = segs.slice(0, i).join('/');
      const e = j.get(prefix);
      if (e && now - e.at <= RENAME_TTL_MS) { next = e.to + cur.slice(prefix.length); break; }
    }
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** 只在测试里用：清掉转发表，免得用例之间串味 */
export function _resetRenameJournal() { renameJournal.clear(); }
/** 只在测试里用：往转发表里记一笔（noteRenames 不导出，真路径走 renameBoardPaths） */
export function _noteRenamesForTest(pid, pairs, now = Date.now()) { noteRenames(pid, pairs, now); }

/**
 * 一次 id 改名：物件、文件夹、以及所有关系线端点一起改。
 *
 * 文件夹改名是**前缀改名** —— `稿件` → `定稿` 要连带它下面的一切：
 * 子文件夹 `稿件/初稿`、物件 `deck:稿件/主稿.html`、裸路径 `稿件/说明.md`。
 * 而且同一个目录**同时**可能是文件夹（zones['稿件']）和产物（objects['site:稿件']），
 * 两个命名空间都得一致地改 —— 今天 rewriteBoardIds 的 mapEnd 就在这个形状上
 * 栽过一次（文件夹端点掉进物件那条分支，被原样放行成了断头线）。
 *
 * @param {string} pid
 * @param {Array<[string, string]>} pairs  [旧路径, 新路径]，**路径不带 kind 前缀**
 * @returns {Promise<{ board: object, renamed: number }>}
 */
export function renameBoardPaths(pid, pairs) {
  const clean = (pairs || [])
    .map(([a, b]) => [String(a || '').replace(/\/+$/, ''), String(b || '').replace(/\/+$/, '')])
    .filter(([a, b]) => a && b && a !== b);
  if (!clean.length) return Promise.resolve({ board: null, renamed: 0 });

  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    const now = Date.now();
    const applied = [];

    /** 一个 id（可能带 `deck:` 之类前缀）在这批改名下的新名字；没动就返回原值 */
    const mapId = (id) => {
      if (typeof id !== 'string' || !id) return id;
      const c = id.indexOf(':');
      // kind 前缀只认字母（`deck:` `site:` `world:`）—— 路径里的冒号不算前缀
      const prefix = c > 0 && /^[a-z]+$/.test(id.slice(0, c)) ? id.slice(0, c + 1) : '';
      const p = id.slice(prefix.length);
      for (const [from, to] of clean) {
        if (p === from) return prefix + to;
        if (p.startsWith(from + '/')) return prefix + to + p.slice(from.length);
      }
      return id;
    };

    const remap = (bag) => {
      const src = bag || {};
      const next = {};
      // **先把没改名的放进去占位**，再放改了名的。撞名时该让路的是"搬过来的
      // 那个"，不是原地那个 —— 按插入顺序一趟写的话，改名源恰好排在前面就会
      // 把活着的条目静默顶掉，而顺序是 JSON 键序，纯属看运气。
      for (const [id, v] of Object.entries(src)) if (mapId(id) === id) next[id] = v;
      for (const [id, v] of Object.entries(src)) {
        const n = mapId(id);
        if (n === id) continue;
        if (next[n]) {
          // 目标位置有活的 —— 搬不过去就**留在原地**，不能一声不响地丢掉。
          // （只写 continue 的话这条从 next 里彻底消失，用户的卡凭空没了。）
          if (!next[id]) next[id] = v;
          continue;
        }
        next[n] = v;
        applied.push([id, n]);
      }
      return next;
    };

    board.objects = remap(board.objects);
    board.zones = remap(board.zones);

    // 显式归属字段也要跟着改名。`objects[*].zone` 是活的：pin_to_board 写它、
    // 拖进文件夹写它。只改键不改这个值的话，文件夹一改名，所有显式归属的成员
    // 就指向一个不存在的文件夹（画布上表现为"卡片从文件夹里掉出来了"）。
    let touchedField = false;
    for (const o of Object.values(board.objects)) {
      if (typeof o.zone !== 'string' || !o.zone) continue;
      const n = mapId(o.zone);
      if (n !== o.zone) { o.zone = n; touchedField = true; }
    }

    // 关系线端点。**这里改了也要算数** —— board.objects 是稀疏的，一条线完全
    // 可以指向一个没有坐标条目的产物，那种情况下 applied 是空的，可对账位点
    // 照样往前推：不落盘 = 这次改名永久丢失，下次再也算不出来。
    let touchedBinding = false;
    for (const b of Object.values(board.bindings || {})) {
      const from = mapId(b.from);
      const to = mapId(b.to);
      if (from !== b.from || to !== b.to) { b.from = from; b.to = to; touchedBinding = true; }
    }

    if (applied.length || touchedField || touchedBinding) {
      await writeBoard(pid, board);
    }
    // 转发表**永远**记裸路径对，不只记 applied：applied 是画布条目的改名
    //（deck 带 `deck:` 前缀、没上画布的文件根本不在里面），而 artifact-file
    // 的改名转发（#4）查的是文件路径 —— 只记 applied 的话，改一个 deck 或者
    // 一个没有画布条目的文件，开着的窗照样 404。
    noteRenames(pid, [...clean, ...applied], now);
    return { board, renamed: applied.length };
  });
}

/**
 * 对账：把 agent 在画布背后做的改名，补写进 board.json。
 *
 * 转发表（上面那个）盖的是"刚改完名、还有人拿着旧 id"的那几分钟窗口，活在内存里。
 * 这一条盖的是另一半：**画布根本没参与的移动** —— agent 一句 `mv`、一次
 * 重构目录，进程重启，都在它的覆盖范围里。
 *
 * 跑在扫产物清单的路上（打开项目必调），所以用户看到的第一帧就是对齐过的。
 * 没有新 commit 时是一次 rev-parse 的事。
 *
 * 同步位点存在 `.nd/board-sync.json`：`.nd/` 是 gitignore 的，这个位点记的是
 * "我的画布追到哪了"，属于本地状态，不该进项目历史被别的会话读到。
 */
const SYNC_FILE = 'board-sync.json';

function syncPath(pid) {
  return path.join(getSharedDir(pid), '.nd', SYNC_FILE);
}

export async function reconcileBoardRenames(pid) {
  let seen = null;
  try { seen = JSON.parse(await fs.readFile(syncPath(pid), 'utf8'))?.commit || null; } catch { /* 首次 */ }

  const { head, renames } = await gitRenamesSince(pid, seen);
  if (!head) return { renamed: 0 };

  let renamed = 0;
  if (renames.length) {
    ({ renamed } = await renameBoardPaths(pid, renames));
    if (renamed) console.log(`[board] ${pid} 跟上 ${renames.length} 个改名，改了 ${renamed} 条画布条目`);
  }
  // 位点无条件推进（哪怕这次没有改名）——否则每次都要重算同一段 diff。
  // 首次跑时 seen 是 null，gitRenamesSince 直接返回空，等于"从现在开始跟"，
  // 不去回放整段历史：历史里的改名早就体现在当前 board.json 里了。
  if (seen !== head) {
    try {
      await fs.mkdir(path.dirname(syncPath(pid)), { recursive: true });
      await fs.writeFile(syncPath(pid), JSON.stringify({ commit: head }), 'utf8');
    } catch { /* 写不了位点：下次重算，不影响正确性 */ }
  }
  return { renamed };
}

// `nextZoneRect`（给新建的工作区自动铺位）2026-08-13 删除：服务端不再新建
// 文件夹条目 —— 文件夹的权威是磁盘扫描，前端按 newStackedZoneRect 给它安排
// 位置。服务端这份自动铺位是当年 pinToZone 会凭空造区留下的。

/**
 * 把一个物件摆到画布上的一个空位并置顶（`pin_to_board` 用）。
 * 单锁原子操作。槽位按 244×210 网格估算（服务端不知道物件真实尺寸，取最大卡片脚印）。
 *
 * ## 2026-08-13 改了三件事
 *
 * 1. **两个 id 都过转发表。** 以前直接 `board.objects[objectId] = …`，agent 在
 *    改名窗口（TTL 5 分钟）里 pin 一下，就往 board.json 里插一条指向旧路径的
 *    条目 —— 画布上多一张回到默认位置的重影，而且不报错。这正是
 *    `renameBoardPaths` 上面那段注释拼死在防的东西，这条写入口是唯一的漏网。
 * 2. **不再写 `zone` 显式归属字段。** id = 路径之后，"它属于哪个文件夹"由路径
 *    回答，再写一个字段只会让画布和磁盘各执一词。
 * 3. **不再凭空新建文件夹条目。** 文件夹的权威是磁盘扫描；board.json 里那条
 *    只是坐标。造一条磁盘上不存在的出来，就是一块剪不掉的僵尸框。
 *    文件夹没坐标（还没被摆过）时就摆到桌面上，前端下一轮会给它安排位置。
 */
export function pinToZone(pid, { objectId, zoneId = '' }) {
  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    const now = Date.now();
    const oid = forwardId(pid, objectId, now);
    const zid = zoneId ? forwardId(pid, zoneId, now) : '';

    /**
     * 找一个空位。
     *
     * ⚠️ 2026-08-13 重写。原来这里按「区矩形 1120×640 + 40px 标题栏 + 244×210
     * 网格」算槽位 —— 那是「文件夹是版面上摊开的一块地」时代的几何，画布上
     * 早就没有这些东西了（区内坐标系随刀 3 整段退役）。算出来的位置跟前端的
     * 排布不在一个坐标语言里。
     *
     * 现在跟前端对齐成同一件事：**一层就是一片桌面，卡按格子铺**。服务端不知道
     * 每张卡多大（那是前端形态表的事），所以取一个够大的格子（最宽的卡 640 ×
     * 一行的常见高度 220）做保守估算 —— 宁可空一点，也不要压在别人身上。
     *
     * 只跟**同一层**的东西比位置：别的文件夹里的卡不在这块桌面上。
     */
    const CELL_W = 320; const CELL_H = 220; const PAD = 10;
    const dirOf = (id) => {
      if (typeof id !== 'string' || id.startsWith('doc:')) return '';
      const c = id.indexOf(':');
      const path = (c > 0 && /^[a-z]+$/.test(id.slice(0, c))) ? id.slice(c + 1) : id;
      const i = path.lastIndexOf('/');
      return i > 0 ? path.slice(0, i) : '';
    };
    const sameLayer = Object.entries(board.objects)
      .filter(([id]) => id !== oid && dirOf(id) === zid)
      .map(([, o]) => o);

    const cols = 4;
    let slot = null;
    for (let i = 0; i < 200 && !slot; i += 1) {
      const x = PAD + (i % cols) * CELL_W;
      const y = PAD + Math.floor(i / cols) * CELL_H;
      const taken = sameLayer.some(o => Math.abs((o.x || 0) - x) < CELL_W / 2
        && Math.abs((o.y || 0) - y) < CELL_H / 2);
      if (!taken) slot = { x, y };
    }
    if (!slot) slot = { x: PAD, y: PAD };

    const zMax = Math.max(10, ...Object.values(board.objects).map(o => o.z || 0));
    board.objects[oid] = {
      ...(board.objects[oid] || {}),
      x: clampNum(slot.x, 0, board.size.w, PAD),
      y: clampNum(slot.y, 0, board.size.h, PAD),
      z: zMax + 1,
    };
    await writeBoard(pid, board);
    return { board, zone: zid ? { id: zid } : null, placed: board.objects[oid] };
  });
}
