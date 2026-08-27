#!/usr/bin/env node
/**
 * server/engine/pi/extensions/migrate-prelude.mjs — 生成脚本：
 * nodesign-prelude.md → agent-dir/prompt-presets/nodesign.json（commit 进仓库的生成物）。
 *
 * prelude 是实战调过的提示词，变换只做 4 类，其余逐字保留：
 *  a. 两个 nd:policy 标记块（含标记行）整段换成单行 `{{ndPolicy}}`
 *     （政策节改由 pi 宏按 env 展开，见 extensions/prompt-support.ts + ../policy-render.js）；
 *  b. 删 ToolSearch 段（pi 无 ToolSearch，工具 schema 常驻可见）；
 *  c. 业务工具节标题去掉 `mcp__nodesign__<tool>` 前缀措辞（pi 里 MCP 工具是裸名）；
 *  d. 可疑段落插 {{//...}} 注释行（pi 宏引擎会剥掉注释，不进模型上下文，只留给维护者）。
 *
 * **改 prelude 改 md，再跑 `node server/engine/pi/extensions/migrate-prelude.mjs` 重新生成。**
 * prelude-render.test.js 有生成物新鲜度断言：改 md 忘跑脚本会让测试红。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { extractPolicyBlocks, renderPolicyBlock, PRELUDE_MD_PATH } from '../policy-render.js';

const OUT_PATH = fileURLToPath(new URL('../agent-dir/prompt-presets/nodesign.json', import.meta.url));

// pi-default 栈原文（default-stack.ts 逐字搬来，对齐今天 pi 内建生产行为）。
const MAIN_ROLE = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
const CUSTOM_TOOLS_NOTE = 'In addition to the tools above, you may have access to other custom tools depending on the project.';

/** d 类变换的注释行。措辞一行说清原因；key 是锚点行的开头子串。 */
const COMMENT_ANCHORS = [
  // 引言段提 SDK preset / Skill 加载 / 系统注入 —— pi 无对应物
  { anchor: '本文 append 在 SDK preset', comment: '{{//M2-待改: 引言提 SDK preset/Skill 加载/系统注入，pi 无对应物}}' },

  // pi 当前 defaultTools 无 bash，装包/脚本段暂不生效
  { anchor: '- **装包可以但别惯性装', comment: '{{//M2-待改: pi defaultTools 暂无 bash，装包/脚本段暂不生效}}' },
  // TaskCreate/TaskUpdate：pi 无任务工具，镜像上板功能悬空
  { anchor: '- **步骤清单自动上板', comment: '{{//M2-待改: pi 无任务工具，TaskCreate/TaskUpdate 镜像上板悬空}}' },

];

/**
 * 唯一锚点行号（0 起）。找不到或歧义直接 throw —— 行号证据同时打进生成日志。
 */
function findLine(lines, pred, what) {
  const hits = [];
  lines.forEach((ln, i) => { if (pred(ln)) hits.push(i); });
  assert.equal(hits.length, 1, `[migrate-prelude] 锚点「${what}」应恰好命中 1 行，实际 ${hits.length}`);
  return hits[0];
}

/**
 * prelude md 原文 → preset block content（4 类变换，其余逐字）。
 * 纯函数：测试用它重算生成物做新鲜度对账。
 *
 * 先在原文坐标上找齐全部锚点（evidence 行号 = md 真实行号，1 起），再从文件尾部往上
 * 依次落刀，保证先记的行号不被前面的 splice 平移。锚点找不到或歧义直接 throw。
 *
 * @param {string} raw nodesign-prelude.md 原文
 * @returns {{content: string, evidence: object}}
 */
export function transformPrelude(raw) {
  // CRLF 归一 + trim（同 system-prompts.js 的 NODESIGN_PRELUDE 读法）
  const lines = raw.replace(/\r\n?/g, '\n').trim().split('\n');

  // ── 找锚点（全部原文坐标）──
  const fullStart = findLine(lines, (l) => l === '<!-- nd:policy:full:start -->', 'nd:policy:full:start');
  const minEnd = findLine(lines, (l) => l === '<!-- nd:policy:min:end -->', 'nd:policy:min:end');
  assert.ok(fullStart < minEnd, '[migrate-prelude] policy 标记块顺序异常');
  const tsStart = findLine(lines, (l) => l.startsWith('按需先 `ToolSearch'), 'ToolSearch 段首行');
  const tsEnd = findLine(lines, (l) => l.trimEnd().endsWith('`profile_scroll`'), 'ToolSearch 清单末行');
  assert.ok(tsStart < tsEnd, '[migrate-prelude] ToolSearch 段顺序异常');
  const headingAt = findLine(lines, (l) => l === '## 业务工具（`mcp__nodesign__<tool>`）', '业务工具标题');
  const h1 = findLine(lines, (l) => l === '# NoDesign 平台协议', 'H1');
  const claudeRow = findLine(lines, (l) => l.startsWith('| `CLAUDE.md`'), 'CLAUDE.md 表行');
  const anchorAts = COMMENT_ANCHORS.map(({ anchor, comment }) => ({
    at: findLine(lines, (l) => l.startsWith(anchor), anchor),
    anchor,
    comment,
  }));

  const evidence = {
    policyBlock: { from: fullStart + 1, to: minEnd + 1 },
    toolSearch: { from: tsStart + 1, to: tsEnd + 1 },
    heading: headingAt + 1,
    comments: [
      { after: h1 + 1, note: 'H1 后生成说明' },
      ...anchorAts.map(({ at, anchor }) => ({ before: at + 1, note: anchor })),
      { rowEnd: claudeRow + 1, note: '| `CLAUDE.md`' },
    ],
  };

  // ── 落刀：所有会移动行号的操作（区间删/替换、插入）按位置从大到小一次性排好再落，
  //    保证先记的原文坐标不被任何先落的一刀平移。原地改（标题、CLAUDE.md 行尾）不挪行，
  //    随时可做。──
  // c. 业务工具节标题去掉 mcp__nodesign__ 前缀措辞（pi 里 MCP 工具是裸名）
  lines[headingAt] = '## 业务工具';
  // d. 路径表 CLAUDE.md 行：注释挂行尾而非独立行 —— 独立注释行被剥掉后会在表中间
  // 留下空行，把一张表劈成两半；挂行尾剥掉后表保持完整。
  lines[claudeRow] += ' {{//M2-待改: pi 无 CLAUDE.md/Skill 机制，本行与下行待改写}}';

  // 会挪行的操作统一登记 {at, del, ins}：删 del 行、在原位插 ins 行。降序落刀。
  const shifts = [
    // b. 删 ToolSearch 段（'按需先 ToolSearch…' 到清单末尾 '…profile_scroll' 行）。
    //    段后紧跟一个空行，一并删掉 —— 段前本就有一个空行，留它做分隔，避免双空行。
    { at: tsStart, del: tsEnd - tsStart + 1 + (lines[tsEnd + 1] === '' ? 1 : 0), ins: [] },
    // d. 可疑段落前插注释行（{{//...}} 会被 pi 宏引擎剥掉，只留给维护者）
    ...anchorAts.map(({ at, comment }) => ({ at, del: 0, ins: [comment] })),
    // a. 两个 nd:policy 标记块（含标记行）→ 单行 {{ndPolicy}}
    { at: fullStart, del: minEnd - fullStart + 1, ins: ['{{ndPolicy}}'] },
    // d. 文件头：H1 后插生成说明
    { at: h1 + 1, del: 0, ins: ['{{//M2: 本 preset 由 migrate-prelude.mjs 从 nodesign-prelude.md 生成，改 prelude 改 md 再跑脚本}}'] },
  ];
  for (const { at, del, ins } of shifts.sort((x, y) => y.at - x.at)) {
    lines.splice(at, del, ...ins);
  }

  const content = lines.join('\n');

  // ── e. 变换后断言 ──
  assert.ok(!content.includes('nd:policy'), '[migrate-prelude] 结果仍含 nd:policy 标记');
  assert.ok(!content.includes('mcp__nodesign__'), '[migrate-prelude] 结果仍含 mcp__nodesign__');
  assert.ok(!content.includes('ToolSearch'), '[migrate-prelude] 结果仍含 ToolSearch');
  assert.ok(content.includes('{{ndPolicy}}'), '[migrate-prelude] 结果缺少 {{ndPolicy}} 宏');
  // full 块特征串不在 preset 文本里（政策块已被 {{ndPolicy}} 替换）——改对
  // policy-render.js 的输出断言：宏展开必须拿得回完整底线。
  const blocks = extractPolicyBlocks(raw);
  assert.ok(renderPolicyBlock(blocks, 'loose', false).includes('未成年人色情内容'),
    '[migrate-prelude] policy-render 输出缺少 full 块特征串「未成年人色情内容」');

  return { content, evidence };
}

/** preset 文档本体（transformPrelude 产物 → nodesign.json 的 items 栈）。 */
export function buildPreset(content) {
  return {
    schemaVersion: 1,
    type: 'pi-forge.prompt-preset',
    id: 'nodesign',
    name: 'Nodesign',
    description: 'Nodesign 平台协议 preset（pi-default 核心栈 + nodesign-prelude），由 migrate-prelude.mjs 生成',
    autoActivate: true,
    defaults: { unresolvedMacroPolicy: 'warn' },
    items: [
      { kind: 'block', id: 'main-role', name: 'Pi Default Role', enabled: true, role: 'system', content: MAIN_ROLE },
      { kind: 'slot', id: 'tools', name: 'Available Tools', enabled: true, role: 'system', slot: 'tools', options: { format: 'plain', onlyWithSnippets: true } },
      { kind: 'block', id: 'custom-tools-note', name: 'Custom Tools Note', enabled: true, role: 'system', content: CUSTOM_TOOLS_NOTE },
      { kind: 'slot', id: 'tool-guidelines', name: 'Guidelines', enabled: true, role: 'system', slot: 'tool-guidelines', options: { format: 'plain', heading: 'Guidelines:', includePiDefaultGuidelines: true } },
      { kind: 'slot', id: 'pi-docs', name: 'Pi Documentation Guidance', enabled: true, role: 'system', slot: 'pi-docs' },
      { kind: 'slot', id: 'date-cwd', name: 'Date and Working Directory', enabled: true, role: 'system', slot: 'date-cwd' },
      { kind: 'block', id: 'nodesign-prelude', name: 'Nodesign Prelude', enabled: true, role: 'system', content },
      // chat-history 槽是会话历史唯一插入点，必须存在且放最后（compiler.ts:89-103）
      { kind: 'slot', id: 'chat-history', name: 'Chat History', enabled: true, slot: 'chat-history' },
    ],
  };
}

/** 序列化（测试用它和盘上文件对账，格式必须与写盘一致）。 */
export function serializePreset(preset) {
  return JSON.stringify(preset, null, 2) + '\n';
}

// ── 主流程（仅直接执行时跑；被测试 import 时不触发）──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const raw = readFileSync(PRELUDE_MD_PATH, 'utf8');

  // prelude 里的 {{}} 序列盘点：变换前扫描，除 {{ADULT_POLICY}}（在 policy 块内、
  // 随块一起被 {{ndPolicy}} 替换）外不应有新的宏序列 —— 有就是 prelude 被人加了
  // 会被 pi 宏引擎误吃的东西，必须人工过目。
  const braceSeqs = [...new Set([...raw.matchAll(/\{\{[\s\S]*?\}\}/g)].map((m) => m[0]))];
  const known = new Set(['{{ADULT_POLICY}}']);
  const unknown = braceSeqs.filter((s) => !known.has(s));
  assert.deepEqual(unknown, [], `[migrate-prelude] prelude 出现未知 {{}} 序列：${unknown.join(', ')}`);

  const { content, evidence } = transformPrelude(raw);
  writeFileSync(OUT_PATH, serializePreset(buildPreset(content)));

  console.log(`nodesign.json 已写 → ${OUT_PATH}`);
  console.log(`prelude 原文 {{}} 序列：${braceSeqs.join(', ')}（均在预期内）`);
  console.log('变换行号证据（原文 1 起）：');
  console.log(`  a. policy 标记块 L${evidence.policyBlock.from}-${evidence.policyBlock.to} → {{ndPolicy}}`);
  console.log(`  b. ToolSearch 段 L${evidence.toolSearch.from}-${evidence.toolSearch.to} 删除`);
  console.log(`  c. 业务工具标题 L${evidence.heading} 去 mcp__ 前缀`);
  for (const c of evidence.comments) {
    const where = c.after ? `L${c.after} 后` : c.before ? `L${c.before} 前` : `L${c.rowEnd} 行尾`;
    console.log(`  d. 注释 ${where}（${c.note}）`);
  }
}
