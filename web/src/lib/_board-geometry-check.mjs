/**
 * _board-geometry-check.mjs — 区内排布的纯函数自测
 *
 * 跑法（项目根）：node web/src/lib/_board-geometry-check.mjs
 *
 * 这两个函数是「拖拽手感」和「空格不均匀」的全部数学。它们没有 React 依赖，
 * 所以能直接断言 —— 换句话说，这两个毛病从此是可回归的，不用靠眼睛看。
 */

import { packRow, insertIndexAt, COL_W, COL_GAP, ROW_GAP } from './board-geometry.js';
// SIZES 已随形态能力表搬去 board-kinds.js（2026-08-07）
import { SIZES } from './board-kinds.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? ` — ${d}` : ''}`); } };

const BOX = { width: 1088, xMin: 16, yTop: 100 };
const m = (id, type) => ({ id, ...SIZES[type] });

// ── 列对齐 ──
{
  const { slots, cols } = packRow(
    [m('a', 'deck'), m('b', 'doc'), m('c', 'file'), m('d', 'image'), m('e', 'note')], BOX);
  ok('1088 宽排得下 4 列', cols === 4, `cols=${cols}`);

  const xs = [...new Set(slots.map(s => s.x))].sort((p, q) => p - q);
  const steps = xs.slice(1).map((v, i) => v - xs[i]);
  ok('列间距完全相等', steps.every(s => s === COL_W + COL_GAP), JSON.stringify(steps));

  // 第五个换到第二行，且回到第一列 —— 列网格跨行对齐
  ok('换行后回到第一列', slots[4].x === slots[0].x, `${slots[4].x} vs ${slots[0].x}`);
}

// ── 行高贴内容，不再吊死白 ──
{
  // 一行全是 88 高的卡 → 下一行紧跟在 88 + ROW_GAP 之后，而不是旧的 210
  const { slots } = packRow(
    [m('a', 'deck'), m('b', 'deck'), m('c', 'deck'), m('d', 'deck'), m('e', 'deck')], BOX);
  ok('矮卡行不再留 210 的死高',
    slots[4].y - slots[0].y === SIZES.deck.h + ROW_GAP,
    `行距 ${slots[4].y - slots[0].y}，卡高 ${SIZES.deck.h}`);

  // 混排：行高取该行最高的那张（图 176），不取全局最大
  const mixed = packRow(
    [m('a', 'file'), m('b', 'image'), m('c', 'file'), m('d', 'file'), m('e', 'file')], BOX);
  ok('混排行高取该行最高的卡',
    mixed.slots[4].y - mixed.slots[0].y === SIZES.image.h + ROW_GAP,
    `行距 ${mixed.slots[4].y - mixed.slots[0].y}`);

  // 全是文件条（40 高）的一行，行距就该是 40 + gap（旧网格是 210，白吊 170）
  const files = packRow(Array.from({ length: 5 }, (_, i) => m(`f${i}`, 'file')), BOX);
  ok('全矮条行距 = 卡高 + 间距',
    files.slots[4].y - files.slots[0].y === SIZES.file.h + ROW_GAP,
    `${files.slots[4].y - files.slots[0].y}`);
}

// ── 居中：余量不再全堆右边 ──
{
  const { slots, cols } = packRow([m('a', 'deck')], BOX);
  const used = cols * COL_W + (cols - 1) * COL_GAP;
  const leftPad = slots[0].x - BOX.xMin;
  const rightPad = BOX.width - used - leftPad;
  ok('左右余量相差不超过 1px', Math.abs(leftPad - rightPad) <= 1, `左 ${leftPad} 右 ${rightPad}`);
}

// ── 展开态跨列，且仍对齐列网格 ──
{
  const { slots } = packRow(
    [m('a', 'deck'), { id: 'big', ...SIZES.deckExpanded }, m('c', 'deck')], BOX);
  const grid = slots[0].x;
  ok('跨列卡仍落在列网格上',
    slots.every(s => (s.x - grid) % (COL_W + COL_GAP) === 0),
    JSON.stringify(slots.map(s => s.x)));
  // 240 + 640 一行放得下（896 < 1088），所以这里不该换行 —— 换行才是 bug
  ok('放得下就不换行', slots[1].y === slots[0].y, JSON.stringify(slots.map(s => [s.x, s.y])));

  // 两张展开态（各占 3 列）一行放不下 → 第二张必须换行，不能溢出
  const two = packRow(
    [{ id: 'b1', ...SIZES.deckExpanded }, { id: 'b2', ...SIZES.deckExpanded }], BOX);
  ok('放不下的跨列卡换行而不是溢出',
    two.slots[1].y > two.slots[0].y, JSON.stringify(two.slots.map(s => [s.x, s.y])));
  ok('换行后的跨列卡也不溢出右边界',
    two.slots.every(s => s.x + s.w <= BOX.xMin + BOX.width + 1));
}

// ── 数学上不可能重叠（这是拆掉避让系统的依据）──
{
  const types = ['deck', 'doc', 'file', 'image', 'note', 'site', 'world'];
  const many = Array.from({ length: 60 }, (_, i) => m(`n${i}`, types[i % types.length]));
  const { slots } = packRow(many, BOX);
  let hits = 0;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]; const b = slots[j];
      if (!(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)) hits++;
    }
  }
  ok('60 个混排物件零重叠', hits === 0, `${hits} 处重叠`);
  ok('没有一张卡溢出右边界',
    slots.every(s => s.x + s.w <= BOX.xMin + BOX.width + 1));
}

// ── 插入点：按读序，不按最近距离 ──
{
  const items = Array.from({ length: 9 }, (_, i) => m(`n${i}`, 'deck'));
  const { slots } = packRow(items, BOX);   // 4 列 → 3 行

  ok('落在第一张左半 → 插到最前', insertIndexAt(slots, slots[0].x + 10, slots[0].y + 10) === 0);
  ok('落在第一张右半 → 插到它后面', insertIndexAt(slots, slots[0].x + 200, slots[0].y + 10) === 1);
  ok('落在第二行行首左半 → 插到第 4 个前',
    insertIndexAt(slots, slots[4].x + 10, slots[4].y + 10) === 4,
    String(insertIndexAt(slots, slots[4].x + 10, slots[4].y + 10)));
  ok('落在末行右端 → 插到最后',
    insertIndexAt(slots, slots[8].x + 200, slots[8].y + 10) === 9,
    String(insertIndexAt(slots, slots[8].x + 200, slots[8].y + 10)));
  ok('落在所有内容下方 → 末尾',
    insertIndexAt(slots, 900, slots[8].y + 500) === 9);

  // 关键：一行右端的正下方，读序上仍属于**这一行的末尾**，不该跳到下一行行首。
  // 用最近距离算的话这里会来回跳两个位置，预览一抖就是这个原因。
  const rowEndX = slots[3].x + slots[3].w - 5;
  const idx = insertIndexAt(slots, rowEndX, slots[3].y + 10);
  ok('行末不跳到下一行行首', idx === 4, `idx=${idx}`);

  ok('空区插到 0', insertIndexAt([], 100, 100) === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
