/**
 * mcp/tools/relate-on-board.js — relate_on_board MCP tool（2026-08-07）
 *
 * 让 agent 在画布上**画出产物之间的关系**。
 *
 * ## 为什么这个工具重要
 *
 * 北极星是「任务文件夹能排出登录墙那种版面」。手摆之所以好看，是因为每张纸的
 * 位置在回答「它和旁边那张什么关系」—— 而系统此前只知道每个产物的尺寸和
 * mtime。**关系数据不到位，再好的布局算法也只能排出「错落有致的网格」。**
 *
 * 关键洞察是：**关系不需要推断，agent 手里本来就有**。它知道 proto-暖调 和
 * proto-冷调 是同一拍的两个试作、知道哪张图是哪次批注的结果、知道这版改自那版。
 * 这些信息现在全在会话里，一落到画布就只剩文件名。这个工具就是那条落差。
 *
 * 线不存坐标：端点是物件 id 或工作区 id，端点一移动线自己跟着走。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { patchBoard } from '../../../projects/board-store.js';
import { BINDING_TYPES, BINDING_TYPE_IDS } from '../../../lib/binding-types.js';

/** 词汇表渲染成工具描述里的一段表，免得两处各写各的 */
const VOCAB = BINDING_TYPE_IDS
  .map(id => `- ${id} (${BINDING_TYPES[id].label})${BINDING_TYPES[id].directed ? '' : ' — undirected'}`)
  .join('\n');

let seq = 0;
const nextId = () => `b:a${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

export function makeRelateOnBoardTool({ projectId, ctx }) {
  return tool(
    'relate_on_board',
    `Draw a relationship line between two things on the workbench canvas.

The canvas knows *what* each artifact is, but not *how they relate*. You are
the only one who knows that — you made them. Recording it lets the user see
lineage at a glance, and lets layout put related things near each other.

Relationship types:
${VOCAB}

Endpoints are canvas object ids OR zone (task folder) ids:
- artifact file path, e.g. 'tasks/海报/proto-暖调.html' or 'assets/generated/x.webp'
- 'deck:task/<task name>' for a task's main deck card
- 'task/<task name>' for the whole task folder

Use it right after you produce something that relates to earlier work:
- made v2 of a poster → derives-from, from the new one to the old one
- produced two variants to compare → contrast between them
- storyboard panels in order → flow, each to the next
- used a reference image in a deck → ref, from the deck to the image

Do NOT use it for "these are all in the same task" — that is what the task
folder already says. Only record relationships that are not obvious from
where the files live.`,
    {
      type: z.enum(BINDING_TYPE_IDS).describe('Relationship kind (see list above)'),
      from: z.string().min(1).max(300).describe('Source object id / artifact path / zone id'),
      to: z.string().min(1).max(300).describe('Target object id / artifact path / zone id'),
      label: z.string().max(60).optional()
        .describe('Optional short words on the line. Omit to use the default for the type.'),
    },
    async ({ type, from, to, label }) => {
      if (!projectId) {
        return { content: [{ type: 'text', text: 'No project bound; cannot draw relationships.' }], isError: true };
      }
      if (from === to) {
        return {
          content: [{ type: 'text', text: 'from and to are the same thing — a relationship needs two ends.' }],
          isError: true,
        };
      }
      const id = nextId();
      // by:'agent' 不只是记录出处 —— 用户画的线 agent 不该擅自删，反过来也一样
      const binding = { type, from, to, by: 'agent', ...(label ? { label } : {}) };
      const board = await patchBoard(projectId, { bindings: { [id]: binding } });

      // 服务端会丢掉非法的线（未知 type / 自环）。**丢了要说**，否则 agent 以为
      // 画上了，用户看不到，两边都不知道发生了什么。
      if (!board.bindings?.[id]) {
        return {
          content: [{ type: 'text', text: `Relationship rejected by the board (bad type or endpoints): ${type} ${from} -> ${to}` }],
          isError: true,
        };
      }

      // 广播：前端整份重拉。**sessionId 必须显式给 null** —— ctx 会把自己的
      // sessionId 补进事件，那样只有当前会话的连接收得到，别的 tab 看不见。
      try {
        ctx?.emit?.({
          type: 'board.updated',
          sessionId: null,
          summary: `已画一条「${BINDING_TYPES[type].label}」关系`,
        });
      } catch { /* emit fail-safe：广播失败不该让工具报错，线已经落盘了 */ }

      const arrow = BINDING_TYPES[type].directed ? '->' : '<->';
      return {
        content: [{
          type: 'text',
          text: `Drew ${type} (${BINDING_TYPES[type].label}): ${from} ${arrow} ${to}`,
        }],
      };
    },
  );
}
