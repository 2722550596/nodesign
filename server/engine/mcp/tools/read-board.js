/**
 * mcp/tools/read-board.js —— read_board（2026-08-14，agent 摆位批·读侧）
 *
 * 让 agent **看得见版面**。在这之前它对画布的了解只有关系线摘要 —— 每件东西
 * 坐哪、挨着谁、谁是主角，全是盲区，"摆放"无从谈起。这个工具把 board.json
 * 翻译成一张按层分组、按行排读的座次表。
 *
 * 口径说明（都写进输出，agent 不用猜）：
 *   - 只列**摆过的**：board.json 是稀疏表，刚产出还没排座的产物没有条目
 *     （前端首排后几百毫秒内落盘，通常都在）
 *   - 层归属是服务端近似（zone 字段优先，其次沿路径找已知文件夹）
 *   - 尺寸是形态估算（文字/涂鸦用存档实测值）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard } from '../../../projects/board-store.js';
import { estimateSize } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { relationsDigest } from '../../../lib/board-relations.js';

/** 同一"行"的 y 容差：入座算法一行内顶对齐，40 世界像素内视作同行 */
const ROW_TOLERANCE = 40;

function describeEntry(id, entry) {
  const sz = estimateSize(id, entry);
  const at = `@(${Math.round(entry.x)},${Math.round(entry.y)}) ${Math.round(sz.w)}x${Math.round(sz.h)}`;
  if (entry.kind === 'text') {
    const t = String(entry.data?.t || '').replace(/\s+/g, ' ').slice(0, 24);
    return `- [手写] 「${t}」 ${at} (id: ${id})${entry.by === 'agent' ? ' ·你写的' : ''}`;
  }
  if (entry.kind === 'scribble') return `- [涂鸦] ${at} (id: ${id})`;
  return `- ${id} ${at}${entry.by === 'agent' ? ' ·你摆的' : ''}`;
}

export function makeReadBoardTool({ projectId }) {
  return tool(
    'read_board',
    `Read the workbench canvas seating chart: what sits where, row by row, per folder layer.

Use this BEFORE arranging anything (arrange_on_board) or writing notes near things
(create_on_board) — placement without looking is guessing. Coordinates are world
pixels; items listed top-to-bottom, left-to-right per row. Only items that have
been seated appear (freshly produced artifacts get their seat within a second).`,
    {
      layer: z.string().max(300).optional()
        .describe("Folder path to read ('' or omitted = the root desktop plus a folder list)"),
    },
    async ({ layer }) => {
      if (!projectId) {
        return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      }
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const want = typeof layer === 'string' ? layer : '';

      // 分层
      const byLayer = new Map();
      for (const [id, entry] of Object.entries(board.objects || {})) {
        if (!Number.isFinite(entry?.x) || !Number.isFinite(entry?.y)) continue;
        const l = layerOf(id, entry, known);
        if (!byLayer.has(l)) byLayer.set(l, []);
        byLayer.get(l).push({ id, entry });
      }

      const lines = [];
      const renderLayer = (l) => {
        const items = (byLayer.get(l) || []).sort((a, b) =>
          (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
        if (!items.length) { lines.push('（这一层还没有摆过的东西）'); return; }
        let rowY = null;
        for (const { id, entry } of items) {
          if (rowY === null || Math.abs(entry.y - rowY) > ROW_TOLERANCE) {
            rowY = entry.y;
            lines.push(`— 行 y≈${Math.round(rowY)} —`);
          }
          lines.push(describeEntry(id, entry));
        }
      };

      lines.push(want ? `文件夹「${want}」的座次：` : '桌面（根层）的座次：');
      renderLayer(want);
      if (!want) {
        const folders = Object.keys(board.zones || {}).sort();
        if (folders.length) {
          lines.push('', `文件夹卡：${folders.map(f => {
            const zz = board.zones[f];
            return `${f}@(${Math.round(zz.x)},${Math.round(zz.y)})`;
          }).join('、')}`);
        }
      }
      if (board.hero) lines.push('', `★ 显式主角：${board.hero}（arrange_on_board 的 feature/unfeature 管它）`);

      try {
        const digest = await relationsDigest(projectId, { limit: 16 });
        if (digest) lines.push('', '关系线：', digest);
      } catch { /* 关系读不到不挡座次 */ }

      lines.push('', '（口径：稀疏表只列摆过的；层归属为服务端近似；尺寸为形态估算）');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
