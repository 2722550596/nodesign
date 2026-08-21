/**
 * hooks/turn-state-memory.js — 每轮状态注入的"上一轮记忆"（2026-08-21）
 *
 * UserPromptSubmit 每轮把工作区状态（素材 / 产物 / 便利贴 / 关系线 / 决策 / tweaks）
 * 注给模型。以前每轮全量，30 轮下来上下文里是十几份几乎一样的块（实测 540~1300
 * token/轮）。现在**首轮全量、之后只报变化**：每节算一个指纹存在这里，下一轮对照。
 *
 * 键按 sessionId（一次对话一份记忆）。两种情况要清掉让下一轮重新全量：
 *   - 上下文压缩之后（PostCompact）：旧的那份已经被摘要吞了，"同上轮"没有所指
 *   - 进程重启：Map 本来就空
 * 上限 300 个会话，LRU 淘汰 —— 会话结束不另外清（多数会话没几轮，留着也就几百字节）。
 */

const MAX_SESSIONS = 300;
/** sessionId → { sections: Map<key, {hash:string, items:string[]|null}>, turns: number } */
const memory = new Map();

/** djb2：够用的短指纹，不引 crypto */
export function fingerprint(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function getTurnMemory(sessionId) {
  if (!sessionId) return null;
  const m = memory.get(sessionId);
  if (m) { memory.delete(sessionId); memory.set(sessionId, m); }   // LRU 触碰
  return m || null;
}

export function setTurnMemory(sessionId, sections) {
  if (!sessionId) return;
  const prev = memory.get(sessionId);
  memory.delete(sessionId);
  memory.set(sessionId, { sections, turns: (prev?.turns || 0) + 1 });
  while (memory.size > MAX_SESSIONS) memory.delete(memory.keys().next().value);
}

/** 压缩后 / 想强制下一轮全量时调 */
export function resetTurnMemory(sessionId) {
  if (sessionId) memory.delete(sessionId);
}

/** 两个清单的差 → { added, removed }（给素材 / 便利贴这种按项报变化的节用） */
export function diffItems(prevItems, nextItems) {
  const prev = new Set(prevItems || []);
  const next = new Set(nextItems || []);
  return {
    added: [...next].filter(x => !prev.has(x)),
    removed: [...prev].filter(x => !next.has(x)),
  };
}

export const _memory = memory;   // 测试用
