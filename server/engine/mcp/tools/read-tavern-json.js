/**
 * mcp/tools/read-tavern-json.js — read_tavern_json MCP tool（2026-08-15）
 *
 * 搬酒馆的东西进来时的读取口。**不要用 Read 去读这类文件**：真样本
 * （Izumi 0814.json）464KB、210 条提示词，启用的只有 56 条 —— Read 一次就是
 * 十几万 token 进上下文，换来的绝大部分是停用的备选条目。
 *
 * 两步走：先 `摘要` 看结构（每条只给名字/角色/字数/一句引子），挑好了再
 * `取` 正文。转成 编排.yaml 和设定文件是 agent 自己的活，这个工具只读不写。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '../tool-shim.js';
import { z } from 'zod';
import { detectKind, digest, fetchEntries } from '../../../lib/tavern-json.js';

const MAX_FETCH_CHARS = 24_000;

function 渲染摘要(d, 文件名) {
  const L = [];
  if (d.形态 === 'preset') {
    L.push(`酒馆 Chat Completion 预设：${文件名}`);
    L.push(`启用 ${d.启用.length} 条（其中有正文的 ${d.启用.filter(e => e.字数 > 0).length} 条，合计 ${d.合计字数} 字）· 停用 ${d.停用.length} 条`);
    const p = d.参数;
    L.push(`参数：temperature ${p.temperature} · top_p ${p.top_p} · 最大输出 ${p.最大输出} · reasoning_effort ${p.reasoning_effort ?? '未设'}`);
    L.push('');
    L.push('启用条目（顺序 = 进模型顺序）:');
    for (const [i, e] of d.启用.entries()) {
      const 标 = e.占位 ? '〔占位·酒馆运行时填，搬过来丢掉〕'
        : e.分隔 ? '〔分节标题·无正文〕' : `${e.字数}字`;
      L.push(`${String(i + 1).padStart(2)}. ${e.名字}  [${e.角色}] ${标}${e.深度 != null ? ` 深度${e.深度}` : ''}`);
      if (e.引子) L.push(`      ${e.引子}…`);
    }
    if (d.停用.length) {
      L.push('');
      L.push(`停用的 ${d.停用.length} 条（同一功能的备选，酒馆里只开一个；名字列表）：`);
      L.push(d.停用.map(e => e.名字).join(' / '));
    }
    L.push('');
    L.push('占位条目（marker，酒馆运行时填角色卡/历史，搬过来一律丢）：' + (d.占位条目.join(' / ') || '无'));
    L.push('分节标题（0 字，只是把开关分组，也不用搬）：' + (d.分隔条目.join(' / ') || '无'));
  } else if (d.形态 === 'card') {
    L.push(`酒馆角色卡：${d.名字}（${文件名}）`);
    for (const f of d.字段) L.push(`- ${f.字段}  ${f.字数}字　${f.引子}…`);
    if (d.开场白备选) L.push(`- alternate_greetings  ${d.开场白备选} 条备选开场白`);
    if (d.世界书.length) {
      L.push('');
      L.push(`内嵌世界书 ${d.世界书.length} 条：`);
      for (const e of d.世界书) {
        L.push(`- ${e.名字}  ${e.常驻 ? '常驻' : `触发[${e.触发.join(' ')}]`} ${e.字数}字${e.停用 ? ' (停用)' : ''}`);
      }
    }
  } else {
    L.push(`酒馆世界书：${文件名}，${d.条目.length} 条`);
    for (const e of d.条目) {
      L.push(`- ${e.名字}  ${e.常驻 ? '常驻' : `触发[${e.触发.join(' ')}]`} ${e.字数}字${e.停用 ? ' (停用)' : ''}`);
      if (e.引子) L.push(`    ${e.引子}…`);
    }
  }
  L.push('');
  L.push('要正文就再调一次本工具：mode="fetch"，entries=["名字或名字的一部分", …]。');
  return L.join('\n');
}

export function makeReadTavernJsonTool({ workspaceRoot, sharedRoot }) {
  return tool(
    'read_tavern_json',
    `Read a SillyTavern (酒馆) export JSON — a chat-completion **preset**, a
**character card** (V2/V3), or a **lorebook** — without pouring the whole file
into your context.

Use this instead of Read for any 酒馆 JSON. A real preset in the wild is 460KB
with 210 prompt entries of which only 56 are enabled; Read would burn six digits
of tokens on disabled alternates.

Two steps:
1. mode "digest" (default) — structure only: every entry's name, role, size and a
   60-char peek, plus which are enabled/disabled, plus sampler params.
2. mode "fetch" with entries[] — full text of just the ones you picked (name,
   partial name, or id). Capped at ${MAX_FETCH_CHARS} chars per call.

This tool only reads. Turning a preset into 编排.yaml + 设定 files is your job —
you decide the grouping, and you drop what does not belong (markers are filled by
酒馆 at runtime and have no place here; platform-specific jailbreak sections are
pointless on this platform).`,
    {
      path: z.string().describe(
        'Path to the .json. Relative paths resolve against the session workspace, '
        + 'then the shared project dir (e.g. "assets/Izumi 0814.json").',
      ),
      // ⚠️ 参数名和枚举值一律 ASCII —— 工具 schema 是模型要照着填的东西，
      // 中文键名在这条路上不可靠（全仓其他工具也都是 ASCII，别开这个头）
      mode: z.enum(['digest', 'fetch']).optional()
        .describe('digest = structure only (default); fetch = full text of the picked entries'),
      entries: z.array(z.string()).optional()
        .describe('For mode="fetch": entry names (partial match ok) or ids'),
    },
    async ({ path: rel, mode = 'digest', entries = [] }) => {
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      try {
        const raw = String(rel || '').trim();
        if (!raw) return fail('read_tavern_json needs a path.');
        const candidates = path.isAbsolute(raw)
          ? [raw]
          : [workspaceRoot && path.resolve(workspaceRoot, raw),
             sharedRoot && path.resolve(sharedRoot, raw)].filter(Boolean);
        let abs = null;
        for (const c of candidates) {
          try { await fs.access(c); abs = c; break; } catch { /* 下一个 */ }
        }
        if (!abs) return fail(`File not found: ${raw}\nLooked in:\n${candidates.map(c => `  ${c}`).join('\n')}`);

        let doc;
        try { doc = JSON.parse(await fs.readFile(abs, 'utf8')); } catch (e) {
          return fail(`这个文件不是合法 JSON：${e.message}`);
        }
        const kind = detectKind(doc);
        if (!kind) {
          return fail('认不出这是酒馆的哪种导出（预设要有 prompts + prompt_order；角色卡要有 first_mes；世界书要有 entries）。普通 JSON 用 Read 就行。');
        }

        if (mode === 'fetch') {
          const 出 = fetchEntries(doc, entries);
          if (!出.length) return fail(`没找到这些条目：${entries.join(' / ')}。先用 mode="digest" 看名字。`);
          let 总 = 0;
          const 块 = [];
          for (const e of 出) {
            if (总 >= MAX_FETCH_CHARS) { 块.push(`〔余下 ${出.length - 块.length} 条超出单次上限，分批取〕`); break; }
            const 文 = e.正文.slice(0, MAX_FETCH_CHARS - 总);
            总 += 文.length;
            块.push(`### ${e.名字}${e.角色 ? `  [${e.角色}]` : ''}\n${文}`);
          }
          return { content: [{ type: 'text', text: 块.join('\n\n') }] };
        }

        return { content: [{ type: 'text', text: 渲染摘要(digest(doc), path.basename(abs)) }] };
      } catch (err) {
        return fail(`read_tavern_json failed: ${err?.message || String(err)}`);
      }
    },
  );
}
