/**
 * server/engine/pi/pi-jsonl.js — pi session JSONL 读取（M1 G1，doc §5.5 / 计划 C5）
 *
 * pi 引擎的转录住在 `<dataRoot>/pi-sessions/<sid>/`（lifecycle 的 --session-dir，
 * 每 Nodesign-sid 一个目录）。⚠️ 文件名**不含** Nodesign sid：pi 自己生成 sessionId
 * （randomUUID），命名 `<fileTimestamp>_<piSessionId>.jsonl`（pi-rp session-manager.ts:983）。
 * resume/--continue 续写同一文件，正常只有一个；多文件按 mtime 取最新。
 *
 * 文件首行是 SessionHeader `{type:"session", id, cwd, ...}`；其后每行一个 entry
 * （pi-rp core/session-manager.ts:46-160）。本模块只关心 `type:"message"` entry，
 * 把 pi AgentMessage（pi-ai types.ts:338-461）映射成 **SDK SessionMessage 形状**，
 * 让 ws hydrate 与 api/sessions.js 的消费方（前端 sessionMessagesToDisplay 零改动）
 * 无感换源。坏行跳过不炸。
 */

import path from 'path';
import { promises as fs } from 'fs';

/** 每 Nodesign-sid 的 pi 转录目录（lifecycle --session-dir 的同一公式） */
export function piSessionDir(dataRoot, sid) {
  return path.join(dataRoot, 'pi-sessions', sid);
}

/**
 * 目录里最新的 session jsonl（按 mtime）。目录不存在 / 没有 .jsonl → null。
 * 不假设文件名含 sid —— pi 按目录发现会话。
 */
export async function findLatestSessionFile(sessionDir) {
  let names;
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(sessionDir, name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    } catch { /* stat race：跳过 */ }
  }
  return best ? best.file : null;
}

/** 这个 sid 有没有 pi 转录（G2 resume 检测用） */
export async function hasPiSession(sessionDir) {
  return (await findLatestSessionFile(sessionDir)) != null;
}

/** entry.timestamp（ISO）优先；兜底 message.timestamp（Unix ms）→ ISO */
function entryIso(entry, msg) {
  if (typeof entry?.timestamp === 'string' && entry.timestamp) return entry.timestamp;
  const ms = msg?.timestamp;
  if (typeof ms === 'number' && Number.isFinite(ms)) return new Date(ms).toISOString();
  return new Date(0).toISOString();
}

/** pi TextContent/ImageContent → Anthropic user/tool_result 内容块（其他类型跳过） */
function mapUserContentBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'image' && typeof block.data === 'string') {
    // 前端读 cb.source.data / cb.source.media_type（session-to-messages.js）
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mimeType, data: block.data },
    };
  }
  return null;
}

/** pi AssistantMessage content → Anthropic assistant blocks（thinking/text/tool_use） */
function mapAssistantBlock(block) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null;
    case 'thinking':
      return typeof block.thinking === 'string' ? { type: 'thinking', thinking: block.thinking } : null;
    case 'toolCall':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.arguments ?? {} };
    default:
      return null;
  }
}

/**
 * 一条 `type:"message"` entry → SDK SessionMessage（C5 映射表）；非消息返回 null。
 *
 * - UserMessage      → {type:'user', message:{role:'user', content}}
 *   （content string 原样；数组里 TextContent→text、ImageContent→Anthropic image
 *    block —— 前端 user 分支只读 text/tool_result，image 静默跳过，转了更保真）
 * - AssistantMessage → {type:'assistant', content: thinking/text/tool_use blocks}
 * - ToolResultMessage→ **user 消息包 tool_result**（SDK 约定；前端从 user content
 *   读 tool_result 回填 tool 状态 / 输出 / 图片）
 * - SystemMessage / custom / 其他 → 跳过（= includeSystemMessages:false 语义）
 */
function mapMessageEntry(entry) {
  if (!entry || entry.type !== 'message') return null;
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return null;
  const base = { uuid: entry.id, timestamp: entryIso(entry, msg) };

  if (msg.role === 'user') {
    let content;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(mapUserContentBlock).filter(Boolean);
    } else {
      return null;
    }
    return { type: 'user', ...base, message: { role: 'user', content } };
  }

  if (msg.role === 'assistant') {
    if (!Array.isArray(msg.content)) return null;
    const content = msg.content.map(mapAssistantBlock).filter(Boolean);
    if (!content.length) return null;
    return { type: 'assistant', ...base, message: { role: 'assistant', content } };
  }

  if (msg.role === 'toolResult') {
    const content = (Array.isArray(msg.content) ? msg.content : [])
      .map(mapUserContentBlock).filter(Boolean);
    return {
      type: 'user',
      ...base,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content,
          is_error: Boolean(msg.isError),
        }],
      },
    };
  }

  return null; // system / 未知 role
}

/** 逐行 parse（坏行跳过）→ 按出现顺序的 message entries */
async function parseMessageEntries(file) {
  const raw = await fs.readFile(file, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }  // 坏行跳过不炸
    if (!obj || typeof obj !== 'object') continue;
    entries.push(obj);
  }
  return entries;
}

/**
 * 活动分支（active branch）：从 leaf 沿 parentId 走到根的 entry 路径（根→leaf 序）。
 *
 * pi JSONL 是 append-only 树（每 entry 带 id/parentId）。rewind（navigate_tree）后
 * 旧分支 entry 仍留在文件里 —— 按文件顺序平铺会把新旧两个分支的消息都显示出来。
 * pi 重启加载时 leaf = 文件最后一条 entry（session-manager.ts L993-996），所以
 * 「最后一条 entry 沿 parentId 向根走」就是 pi 语义的活动分支。
 *
 * 兜底：无树结构的老 JSONL（v1 迁移前，entry 没有 id/parentId 键）退回全量平铺 ——
 * 判据是最后一条 entry 没有 parentId 键（v2 根节点 parentId 是 null 而非缺失）。
 * 单链文件（M3c 前无 rewind）活动分支 = 全文件，行为与旧实现一致。
 */
function activeBranchEntries(entries) {
  const last = entries[entries.length - 1];
  if (!last || last.parentId === undefined) return entries;   // 无树结构 → 平铺兜底
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path = [];
  let cur = last;
  const seen = new Set();   // 环保护：坏文件 parentId 成环时不死循环
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  path.reverse();   // 根 → leaf 时间序
  return path;
}

/**
 * 读会话活动分支的全部消息 → SDK SessionMessage[]（时间顺序）。
 * 目录 / 文件不存在 → []（新会话还没跑过 turn 是常态，不是错误）。
 * M3c：改走活动分支（activeBranchEntries），rewind 后 hydrate 不再显示旧分支。
 */
export async function readPiSessionMessages(sessionDir) {
  const file = await findLatestSessionFile(sessionDir);
  if (!file) return [];
  const entries = await parseMessageEntries(file);
  if (entries.length === 0) return [];
  const out = [];
  for (const entry of activeBranchEntries(entries)) {
    const sm = mapMessageEntry(entry);
    if (sm) out.push(sm);
  }
  return out;
}

/**
 * 活动分支上最后一条 user entry 的 id（8 位 hex）。M3c rewind 索引用（C3b）。
 *
 * 从 leaf 沿 parentId 向根走，找第一条 role==='user'（即活动分支上最新的 user
 * 消息）。⚠️ 不能倒扫文件 —— rewind 后旧分支的 user entry 仍在文件里，倒扫会
 * 读到旧分支。finishTurn 写索引时本轮 user entry 刚被 pi append 为 leaf 或 leaf
 * 的祖先，必在活动分支上（串行 turn 保证它是活动分支最新的 user 消息）。
 * 无树结构的老 JSONL 退回倒扫（单链语义等价）。拿不到 → null。
 */
export async function readLastUserEntryId(sessionDir) {
  const file = await findLatestSessionFile(sessionDir);
  if (!file) return null;
  const entries = await parseMessageEntries(file);
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  if (last.parentId === undefined) {
    // 无树结构兜底：倒扫找最后一条 user message entry
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === 'message' && e.message?.role === 'user' && e.id) return e.id;
    }
    return null;
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  let cur = last;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === 'message' && cur.message?.role === 'user' && cur.id) return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return null;
}

/**
 * 会话列表用的元信息（对齐 SDK getSessionInfo 的可消费键）。
 * 目录 / 文件不存在 → null（list 侧据此过滤）。
 *
 * @returns {Promise<{
 *   sessionId: string,            // Nodesign sid（目录名；pi 内部 id 另给 piSessionId）
 *   piSessionId: string|null,     // header.id（pi 自生成）
 *   cwd: string|null,             // header.cwd
 *   customTitle: string|null,     // session_info entry 的 name（pi 的 /rename 落这里）
 *   summary: string|null,         // 首条 user 文本（截 120 字）—— SDK summary 的对应物
 *   firstPrompt: string|null,
 *   lastModified: number,         // 文件 mtime（ms）
 *   messageCount: number,         // message entry 数
 * }>|null>}
 */
export async function readPiSessionInfo(sessionDir) {
  const file = await findLatestSessionFile(sessionDir);
  if (!file) return null;
  let st;
  try { st = await fs.stat(file); } catch { return null; }

  let header = null;
  let infoName = null;
  let firstUserText = null;
  let messageCount = 0;
  for (const entry of await parseMessageEntries(file)) {
    if (entry.type === 'session' && !header) { header = entry; continue; }
    if (entry.type === 'session_info') {
      if (typeof entry.name === 'string' && entry.name.trim()) infoName = entry.name.trim();
      continue;
    }
    if (entry.type !== 'message') continue;
    messageCount += 1;
    if (firstUserText == null && entry.message?.role === 'user') {
      const c = entry.message.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join(' ')
          : '';
      if (text.trim()) firstUserText = text.trim();
    }
  }

  const sid = path.basename(sessionDir);
  const summary = firstUserText ? (firstUserText.length > 120 ? `${firstUserText.slice(0, 120)}…` : firstUserText) : null;
  return {
    sessionId: sid,
    piSessionId: typeof header?.id === 'string' ? header.id : null,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    customTitle: infoName,
    summary,
    firstPrompt: firstUserText,
    lastModified: st.mtimeMs,
    messageCount,
  };
}

/**
 * 最新 jsonl 里**最后一条带 usage 的 assistant message** 的 pi Usage
 * （{input, output, cacheRead, cacheWrite, totalTokens, ...}）。
 * context-usage 的 M1 近似口径用（api/sessions.js）；拿不到 → null。
 * 从文件尾部倒扫，命中即停。
 */
export async function readLastAssistantUsage(sessionDir) {
  const file = await findLatestSessionFile(sessionDir);
  if (!file) return null;
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj?.type !== 'message') continue;
    const msg = obj.message;
    if (msg?.role !== 'assistant' || !msg.usage || typeof msg.usage !== 'object') continue;
    return msg.usage;
  }
  return null;
}

/**
 * 最新 jsonl 里**最后一条 thinking_level_change 条目**的档位（M1.5）。
 * pi 的 setThinkingLevel 自己落这个条目（session-manager.ts:1100），resume 时
 * getSessionContextSettings 从它恢复 —— 非活会话查当前档位就读它。拿不到 → null。
 */
export async function readLastThinkingLevel(sessionDir) {
  const file = await findLatestSessionFile(sessionDir);
  if (!file) return null;
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj?.type === 'thinking_level_change' && typeof obj.thinkingLevel === 'string') {
      return obj.thinkingLevel;
    }
  }
  return null;
}
