/**
 * server/projects/board-store.js — 工作台画布布局的唯一读写方（2026-07-27 分区版）
 *
 * HTTP 路由（api/board.js）和 MCP 工具（pin-to-board）都经这里读写，
 * 带 per-project 写锁串行化读改写，避免前端 PATCH 与 agent 写入互相覆盖。
 *
 * schema（shared/board.json）：
 *   {
 *     size: { w, h },
 *     zones: { [zoneId]: { x, y, w, h, title? } },   // zoneId 一般 = sessionId
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
import { getSharedDir, ensureProjectWorkspace } from './workspace.js';
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
export const ZONE_DEFAULTS = { w: 1120, h: 640, gap: 60, bandX: 320, bandY: 48, perRow: 3 };

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
 * ⚠️ 文字**不在**这张表里，是有意的：文字要落盘成 `.md`（走便签那条路），
 * agent 才读得到。canvas-native 的东西 agent 是瞎的。
 */
const CANVAS_NATIVE_KINDS = new Set(['scribble']);

/** 涂鸦路径串上限。一条随手画的线约 300~800 字符，8000 够长且撑不爆 board.json */
const MAX_SCRIBBLE_PATH = 8000;

function sanitizeCanvasData(kind, data) {
  if (kind !== 'scribble') return null;
  const d = typeof data?.d === 'string' ? data.d.slice(0, MAX_SCRIBBLE_PATH) : '';
  // 只收 SVG path 里合法的那几个字符，挡住任何往 DOM 里塞东西的尝试
  if (!d || !/^[\dMLQCZ ,.\-eE]+$/.test(d)) return null;
  return {
    d,
    color: ['ink', 'red', 'pencil', 'brass'].includes(data.color) ? data.color : 'ink',
    width: clampNum(data.width, 1, 24, 2),
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
    // 画布原生物件可以住在负坐标（产物旁边的余白就是给它们的），
    // 磁盘产物仍夹在正区间里。
    x: clampNum(o.x, kind ? -size.w : 0, size.w, 0),
    y: clampNum(o.y, kind ? -size.h : 0, size.h, 0),
    z: clampNum(o.z, 0, 1e6, 0),
    ...(Number.isFinite(Number(o.w)) ? { w: clampNum(o.w, 4, size.w, 200) } : {}),
    ...(Number.isFinite(Number(o.h)) ? { h: clampNum(o.h, 4, size.h, 200) } : {}),
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

function sanitizeZone(z, size) {
  if (!z || typeof z !== 'object') return null;
  return {
    x: clampNum(z.x, 0, size.w, 0),
    y: clampNum(z.y, 0, size.h, 0),
    w: clampNum(z.w, 200, size.w, ZONE_DEFAULTS.w),
    h: clampNum(z.h, 160, size.h, ZONE_DEFAULTS.h),
    ...(typeof z.title === 'string' && z.title.trim()
      ? { title: z.title.trim().slice(0, 120) }
      : {}),
    ...(z.collapsed ? { collapsed: true } : {}),   // 收纳成文件夹形态
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
    const s = sanitizeZone(z, size);
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
    if (patch?.zones && typeof patch.zones === 'object') {
      for (const [id, z] of Object.entries(patch.zones)) {
        if (typeof id !== 'string' || id.length > 300) continue;
        if (z === null) { delete board.zones[id]; removed.add(id); continue; }
        const s = sanitizeZone(z, board.size);
        if (s && (board.zones[id] || Object.keys(board.zones).length < MAX_ZONES)) board.zones[id] = s;
      }
    }
    if (patch?.objects && typeof patch.objects === 'object') {
      for (const [id, o] of Object.entries(patch.objects)) {
        if (typeof id !== 'string' || id.length > 300) continue;
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
        if (s && (board.bindings[id] || Object.keys(board.bindings).length < MAX_BINDINGS)) board.bindings[id] = s;
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

function nextZoneRect(board) {
  const { w, h, gap, bandX, bandY, perRow } = ZONE_DEFAULTS;
  const n = Object.keys(board.zones).length;
  return {
    x: Math.min(board.size.w - w, bandX + (n % perRow) * (w + gap)),
    y: Math.min(board.size.h - h, bandY + Math.floor(n / perRow) * (h + gap)),
    w, h,
  };
}

/**
 * 把一个物件放进某 zone 的下一个空槽（zone 不存在则先按自动铺位创建）。
 * 单锁原子操作，供 MCP 工具（agent 协助摆放）使用。
 * 槽位按 244×210 网格估算（服务端不知道物件真实尺寸，取最大卡片脚印）。
 */
export function pinToZone(pid, { objectId, zoneId, zoneTitle }) {
  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    if (!board.zones[zoneId]) {
      board.zones[zoneId] = {
        ...nextZoneRect(board),
        ...(zoneTitle ? { title: String(zoneTitle).slice(0, 120) } : {}),
      };
    }
    const zone = board.zones[zoneId];
    const CELL_W = 244; const CELL_H = 210; const PAD = 16; const HEADER = 40;
    const members = Object.values(board.objects).filter(o =>
      o.x >= zone.x && o.x < zone.x + zone.w && o.y >= zone.y && o.y < zone.y + zone.h);
    const cols = Math.max(1, Math.floor((zone.w - PAD * 2) / CELL_W));
    let slot = null;
    for (let i = 0; i < 200 && !slot; i++) {
      const cx = zone.x + PAD + (i % cols) * CELL_W;
      const cy = zone.y + HEADER + PAD + Math.floor(i / cols) * CELL_H;
      if (!members.some(m => Math.abs(m.x - cx) < CELL_W / 2 && Math.abs(m.y - cy) < CELL_H / 2)) {
        slot = { x: cx, y: cy };
      }
    }
    if (!slot) slot = { x: zone.x + PAD, y: zone.y + HEADER + PAD };
    // 槽位落到 zone 外（满了）就把 zone 向下撑高
    if (slot.y + CELL_H > zone.y + zone.h) {
      zone.h = Math.min(board.size.h - zone.y, slot.y + CELL_H - zone.y);
    }
    const zMax = Math.max(10, ...Object.values(board.objects).map(o => o.z || 0));
    board.objects[objectId] = {
      ...(board.objects[objectId] || {}),
      x: clampNum(slot.x, 0, board.size.w, zone.x),
      y: clampNum(slot.y, 0, board.size.h, zone.y),
      z: zMax + 1,
      zone: zoneId,          // 显式归属（pin 即入册）
    };
    await writeBoard(pid, board);
    return { board, zone: { id: zoneId, ...zone }, placed: board.objects[objectId] };
  });
}
