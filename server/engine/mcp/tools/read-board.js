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
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { relationsDigest, bindingLine } from '../../../lib/board-relations.js';
import { groupObjects, asciiMinimap } from '../../../lib/board-groups.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';

/** 同一"行"的 y 容差：入座算法一行内顶对齐，40 世界像素内视作同行 */
const ROW_TOLERANCE = 40;

function describeEntry(board, id, entry, glyph = null) {
  const sz = estimateSizeOn(board, id, entry);
  const at = `@(${Math.round(entry.x)},${Math.round(entry.y)}) ${Math.round(sz.w)}x${Math.round(sz.h)}`;
  const g = glyph ? `[${glyph}] ` : '';
  const flags = `${entry.staging ? ' 〔草稿〕' : ''}${entry.tag ? ` #${entry.tag}` : ''}`;
  if (entry.kind === 'text') {
    const t = String(entry.data?.t || '').replace(/\s+/g, ' ').slice(0, entry.data?.format === 'md' ? 60 : 24);
    const md = entry.data?.format === 'md' ? 'md' : '手写';
    return `- ${g}[${md}] 「${t}」 ${at} (id: ${id})${entry.by === 'agent' ? ' ·你写的' : ''}${flags}`;
  }
  if (entry.kind === 'scribble') return `- ${g}[涂鸦] ${at} (id: ${id})${entry.by === 'agent' ? ' ·你画的' : ''}${flags}`;
  return `- ${g}${id} ${at}${entry.by === 'agent' ? ' ·你摆的' : ''}${flags}`;
}

export function makeReadBoardTool({ projectId }) {
  return tool(
    'read_board',
    `Read the workbench canvas: an ASCII minimap, then GROUPS (things linked by lines or
sharing a #tag), then loose items row by row, then relation lines.

Use this BEFORE arranging (arrange_on_board), writing notes (create_on_board) or
sketching (sketch_on_board) — placement without looking is guessing. Coordinates are
world pixels. Only seated items appear (fresh artifacts get a seat within a second).
Items marked 〔草稿〕 are still staging (yours from this turn, half-transparent until
finish_sketch / end of turn). The user's current viewport (if known) is drawn as a box
on the minimap and listed with what is inside it.`,
    {
      layer: z.string().max(300).optional()
        .describe("Folder path to read ('' or omitted = the root desktop plus a folder list)"),
      tag: z.string().max(40).optional()
        .describe('Only list items/lines carrying this #tag (one group, e.g. a sketch you made)'),
    },
    async ({ layer, tag }) => {
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
      const items = (byLayer.get(want) || [])
        .filter(({ entry }) => !tag || entry.tag === tag)
        .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
      const entryOf = new Map(items.map(it => [it.id, it.entry]));

      // 小地图（用户视口画框）
      const vp = getViewpoint(projectId);
      const vpRect = (vp && (vp.layer || '') === want && vp.camera) ? vp.camera : null;
      const rects = items.map(({ id, entry }) => ({ id, x: entry.x, y: entry.y, ...estimateSizeOn(board, id, entry) }));
      const mini = asciiMinimap(rects, { viewport: vpRect });
      const glyphOf = new Map(mini ? mini.legend : []);

      lines.push(want ? `文件夹「${want}」的座次${tag ? `（只看 #${tag}）` : ''}：` : `桌面（根层）的座次${tag ? `（只看 #${tag}）` : ''}：`);
      if (!items.length) {
        lines.push('（这一层还没有摆过的东西）');
      } else {
        if (mini) {
          lines.push(`小地图（一格≈${mini.cell}px，左上=(${mini.bbox.x},${mini.bbox.y})，范围 ${mini.bbox.w}x${mini.bbox.h}${vpRect ? '，┌┐└┘ 框=用户视口' : ''}）：`);
          lines.push(mini.grid);
        }
        // 组：连通分量 + tag；≥2 件的才叫组，单件归「散件」按行列
        const groups = groupObjects(items.map(it => it.id), board.bindings || {}, id => entryOf.get(id)?.tag || null);
        const real = groups.filter(g => g.members.length >= 2);
        const loose = groups.filter(g => g.members.length < 2).flatMap(g => g.members);
        real.forEach((g, i) => {
          const tags = [...g.tags].map(t => `#${t}`).join(' ');
          const staging = g.members.every(id => entryOf.get(id)?.staging);
          lines.push('', `组 ${i + 1}${tags ? ` ${tags}` : ''}（${g.members.length} 件 ${g.edges.length} 线${staging ? '，草稿' : ''}）：`);
          const sorted = g.members.map(id => ({ id, entry: entryOf.get(id) }))
            .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
          for (const { id, entry } of sorted) lines.push(describeEntry(board, id, entry, glyphOf.get(id)));
          for (const bid of g.edges.slice(0, 12)) lines.push(`    ${bindingLine(board.bindings[bid], board)}`);
          if (g.edges.length > 12) lines.push(`    …还有 ${g.edges.length - 12} 条线`);
        });
        if (loose.length) {
          lines.push('', real.length ? '散件：' : '');
          let rowY = null;
          const sorted = loose.map(id => ({ id, entry: entryOf.get(id) }))
            .sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
          for (const { id, entry } of sorted) {
            if (rowY === null || Math.abs(entry.y - rowY) > ROW_TOLERANCE) {
              rowY = entry.y;
              lines.push(`— 行 y≈${Math.round(rowY)} —`);
            }
            lines.push(describeEntry(board, id, entry, glyphOf.get(id)));
          }
        }
      }
      if (!want && !tag) {
        const folders = Object.keys(board.zones || {}).sort();
        if (folders.length) {
          lines.push('', `文件夹卡：${folders.map(f => {
            const zz = board.zones[f];
            return `${f}@(${Math.round(zz.x)},${Math.round(zz.y)})`;
          }).join('、')}`);
        }
      }
      if (board.hero && !tag) lines.push('', `★ 显式主角：${board.hero}（arrange_on_board 的 feature/unfeature 管它）`);

      // 用户视点（有上报才有）
      if (vp && !tag) {
        const inside = vpRect ? rects.filter(r =>
          !(r.x + r.w < vpRect.x || r.x > vpRect.x + vpRect.w || r.y + r.h < vpRect.y || r.y > vpRect.y + vpRect.h))
          .map(r => r.id) : [];
        const bits = [];
        if (vpRect) bits.push(`视口 (${Math.round(vpRect.x)},${Math.round(vpRect.y)}) ${Math.round(vpRect.w)}x${Math.round(vpRect.h)} 缩放 ${vp.zoom ?? '?'}`);
        if (vp.openWindow) bits.push(`开着窗：${vp.openWindow}${vp.openPage ? `（${vp.openPage}）` : ''}`);
        if (vp.selected?.length) bits.push(`选中：${vp.selected.slice(0, 8).join('、')}`);
        if (inside.length) bits.push(`视口里有：${inside.slice(0, 12).join('、')}${inside.length > 12 ? ' 等' : ''}`);
        const age = Math.round((Date.now() - (vp.at || 0)) / 1000);
        lines.push('', `用户此刻（${age}s 前上报）：${bits.join('；') || '只知道在看这一层'}`);
      }

      if (!tag) {
        try {
          const digest = await relationsDigest(projectId, { limit: 16 });
          if (digest) lines.push('', '关系线：', digest);
        } catch { /* 关系读不到不挡座次 */ }
      }

      lines.push('', '（口径：稀疏表只列摆过的；层归属为服务端近似；尺寸为形态估算）');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
