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
 *     objects: { [objectId]: { x, y, z, w?, h?, expanded? } }
 *   }
 *
 * 布局只存摆放，物件本体由 artifacts / sessions / memory 数据源派生。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getSharedDir, ensureProjectWorkspace } from './workspace.js';

export const DEFAULT_BOARD_SIZE = { w: 4000, h: 2600 };
export const MAX_BOARD_BYTES = 512 * 1024;
export const MAX_OBJECTS = 2000;
export const MAX_ZONES = 200;

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

function sanitizeObject(o, size) {
  if (!o || typeof o !== 'object') return null;
  return {
    x: clampNum(o.x, 0, size.w, 0),
    y: clampNum(o.y, 0, size.h, 0),
    z: clampNum(o.z, 0, 1e6, 0),
    ...(Number.isFinite(Number(o.w)) ? { w: clampNum(o.w, 40, size.w, 200) } : {}),
    ...(Number.isFinite(Number(o.h)) ? { h: clampNum(o.h, 40, size.h, 200) } : {}),
    ...(o.expanded ? { expanded: true } : {}),
    // 显式归属：'' = 明确无归属（覆盖 sid 派生），非空 = 所属工作区 id
    ...(typeof o.zone === 'string' && o.zone.length <= 300 ? { zone: o.zone } : {}),
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
  return { size, zones, objects };
}

export async function readBoard(pid) {
  try {
    const raw = await fs.readFile(boardPath(pid), 'utf8');
    return sanitizeBoard(JSON.parse(raw));
  } catch {
    return { size: { ...DEFAULT_BOARD_SIZE }, zones: {}, objects: {} };
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
    if (patch?.zones && typeof patch.zones === 'object') {
      for (const [id, z] of Object.entries(patch.zones)) {
        if (typeof id !== 'string' || id.length > 300) continue;
        if (z === null) { delete board.zones[id]; continue; }
        const s = sanitizeZone(z, board.size);
        if (s && (board.zones[id] || Object.keys(board.zones).length < MAX_ZONES)) board.zones[id] = s;
      }
    }
    if (patch?.objects && typeof patch.objects === 'object') {
      for (const [id, o] of Object.entries(patch.objects)) {
        if (typeof id !== 'string' || id.length > 300) continue;
        if (o === null) { delete board.objects[id]; continue; }
        const s = sanitizeObject(o, board.size);
        if (s && (board.objects[id] || Object.keys(board.objects).length < MAX_OBJECTS)) board.objects[id] = s;
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
