/**
 * board-avoidance.test.js — 同区避让系统（resolveZoneAvoidance）
 *
 * 语义合同：
 *   1. 路权按 z：z 最大的成员永远不动，别人让
 *   2. 让位是最小位移（近处有空位不会被传送到远处）
 *   3. 连锁避让收敛，结果零重叠
 *   4. 无重叠时零改动（布局稳定性——落盘 effect 不应被空转触发）
 */
import { describe, it, expect } from 'vitest';
import { resolveZoneAvoidance, AVOID_GAP } from './board-geometry.js';

const BOUNDS = { xMin: 64, xMax: 1344, yMin: 100 };
const hit = (a, b) =>
  !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/** 应用 moved 后的最终矩形列表 */
function finalRects(members, moved) {
  return members.map(m => {
    const f = moved.get(m.id);
    return { id: m.id, x: f ? f.x : m.pos.x, y: f ? f.y : m.pos.y, w: m.w, h: m.h };
  });
}

describe('resolveZoneAvoidance', () => {
  it('无重叠时不动任何人', () => {
    const members = [
      { id: 'a', pos: { x: 64, y: 100, z: 1 }, w: 240, h: 88 },
      { id: 'b', pos: { x: 340, y: 100, z: 2 }, w: 240, h: 88 },
    ];
    const { moved } = resolveZoneAvoidance(members, BOUNDS);
    expect(moved.size).toBe(0);
  });

  it('z 大的有路权：被压的老卡让位，新压上去的不动', () => {
    const members = [
      { id: 'old', pos: { x: 100, y: 100, z: 1 }, w: 240, h: 88 },
      { id: 'dragged', pos: { x: 120, y: 110, z: 99 }, w: 240, h: 88 },
    ];
    const { moved } = resolveZoneAvoidance(members, BOUNDS);
    expect(moved.has('dragged')).toBe(false);   // 路权方原地不动
    expect(moved.has('old')).toBe(true);        // 被压方让位
    const rects = finalRects(members, moved);
    expect(hit(rects[0], rects[1])).toBe(false);
  });

  it('让位走最小位移：浅压时侧移一小步，不往下传送', () => {
    // dragged 只压住 old 左缘 20px —— 右移 32px 即可脱离，比下落 100px 近
    const members = [
      { id: 'old', pos: { x: 220, y: 100, z: 1 }, w: 240, h: 88 },
      { id: 'dragged', pos: { x: 0, y: 100, z: 99 }, w: 240, h: 88 },
    ];
    const { moved } = resolveZoneAvoidance(members, { ...BOUNDS, xMin: 0 });
    const fix = moved.get('old');
    expect(fix).toBeTruthy();
    // 右移到 dragged 右缘 + GAP（y 不变），而不是掉到下一行
    expect(fix.y).toBe(100);
    expect(fix.x).toBe(240 + AVOID_GAP);
  });

  it('连锁避让：A 挤 B、B 挤 C，结果零重叠', () => {
    const members = [
      { id: 'c', pos: { x: 100, y: 300, z: 1 }, w: 240, h: 88 },
      { id: 'b', pos: { x: 100, y: 200, z: 2 }, w: 240, h: 200 },  // 展开态大卡
      { id: 'a', pos: { x: 100, y: 180, z: 99 }, w: 240, h: 88 },
    ];
    const { moved } = resolveZoneAvoidance(members, BOUNDS);
    expect(moved.has('a')).toBe(false);
    const rects = finalRects(members, moved);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(hit(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('多方向都被堵死时垂直下落且收敛（不死循环）', () => {
    // 一排大卡把水平方向塞满，低权卡只能往下
    const members = [
      { id: 'w1', pos: { x: 64, y: 100, z: 50 }, w: 640, h: 388 },
      { id: 'w2', pos: { x: 704, y: 100, z: 51 }, w: 640, h: 388 },
      { id: 'loser', pos: { x: 300, y: 120, z: 1 }, w: 240, h: 88 },
    ];
    const { moved, bottom } = resolveZoneAvoidance(members, BOUNDS);
    const fix = moved.get('loser');
    expect(fix).toBeTruthy();
    expect(fix.y).toBeGreaterThanOrEqual(100 + 388);   // 落到大卡下方
    const rects = finalRects(members, moved);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(hit(rects[i], rects[j])).toBe(false);
      }
    }
    expect(bottom).toBeGreaterThanOrEqual(fix.y + 88);
  });

  it('bottom 反映重排后的内容最低点', () => {
    const members = [
      { id: 'a', pos: { x: 100, y: 100, z: 1 }, w: 240, h: 88 },
    ];
    const { bottom } = resolveZoneAvoidance(members, BOUNDS);
    expect(bottom).toBe(188);
  });

  it('结果确定性：同输入两次调用同输出', () => {
    const members = [
      { id: 'a', pos: { x: 100, y: 100, z: 3 }, w: 240, h: 88 },
      { id: 'b', pos: { x: 150, y: 120, z: 2 }, w: 200, h: 176 },
      { id: 'c', pos: { x: 200, y: 140, z: 1 }, w: 224, h: 40 },
    ];
    const r1 = resolveZoneAvoidance(members, BOUNDS);
    const r2 = resolveZoneAvoidance(members, BOUNDS);
    expect([...r1.moved.entries()]).toEqual([...r2.moved.entries()]);
  });
});
