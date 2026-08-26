/**
 * lib/ingress/strip-sdk-residue.js — 剥 SDK 硬注入残留（sdkPreset='replace' 专用）。
 *
 * 背景（2026-08-26 假网关实测，SDK 2.1.237）：即使 systemPrompt 传纯字符串，SDK
 * 二进制仍往请求里硬塞四样东西——
 *   1. 顶层 system 的计费头块（`x-anthropic-billing-header: …`，73B）
 *   2. 顶层 system 的身份行块（`You are a Claude agent, built on …Claude Agent SDK.`，62B）
 *   3. messages 里的 role=system 动态提醒段（~10.9KB：agent 注册表 + skill 目录 +
 *      `<total_tokens>` 预算），每次请求独立注入，不走 systemPrompt 字段
 *   4. 首条 user 消息里的 `<system-reminder># currentDate` 块（会话时间上下文，
 *      用户自备时间来源，2026-08-26 拍板也剥）
 *
 * 这四样单独看都不大，但对「整份替换 SDK preset」的项目（prompt.sdkPreset='replace'）
 * 它们就是漏网的边角料——目标是模型只看到我们的提示词。本函数在 model-ingress
 * 转发前把这些残留从请求体里剥掉。
 *
 * ⚠️ 只该给 replace 会话开（会话标志见 session-routes.js 的 sessionShouldStrip）：
 * keep 会话的计费头/预算提醒是有用的，别全局剥。
 *
 * 边界：
 *   - 只碰顶层 `system` 数组块、messages 的 system 角色条目、以及形状精确的
 *     currentDate 提醒块（必须以 `<system-reminder>` 开头、含 `# currentDate`）。
 *     user 真实输入、普通助手消息、工具调用、thinking 字段一概不动。
 *   - 幂等：跑两遍结果一样；没命中任何残留 = 原样返回（同一引用）。
 */

/** 计费头块前缀（SDK 每请求注入，上游计费归属用；replace 项目不需要上游归因） */
export const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
/** 身份行特征串（SDK 模式下的三种变体都含这句） */
export const IDENTITY_MARKER = 'You are a Claude agent';
/** currentDate 上下文**段**：`# currentDate` 后跟一行日期。只摘这一小段。
 *  2026-08-26 e2e 实锤：CLAUDE.md（`# claudeMd` 段）与 currentDate 在**同一个
 *  `<system-reminder>` 块**里、currentDate 在后 —— 按整块删会把项目档案一起吃掉。 */
const CURRENT_DATE_SECTION_RE = /[ \t]*# currentDate\s*Today(?:'s)? date is [^\n]*\n?/;
/** 摘掉 currentDate 段后，块里还有没有别的命名上下文段（# claudeMd / # currentDate 等） */
const HAS_CONTEXT_SECTION_RE = /\n# [A-Za-z]/;
/** 只剩提醒骨架、没有命名段的残块：整个 reminder 剥掉（惰性到第一个 </system-reminder>） */
const SCAFFOLD_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/;

/** 摘 currentDate 段 + 清理骨架。返回 { text, dropped }：dropped 表示整块已无内容 */
function cleanCurrentDateRemnant(text) {
  const cleaned = text.replace(CURRENT_DATE_SECTION_RE, '');
  const bare = cleaned.trim();
  if (bare === '') return { dropped: true };
  if (!HAS_CONTEXT_SECTION_RE.test(bare) && bare.includes('<system-reminder>')) {
    // 剩的只有提醒骨架（无 # claudeMd 这类命名段）→ 剥骨架，保留骨架外的真实文本
    const withoutScaffold = cleaned.replace(SCAFFOLD_RE, '');
    if (withoutScaffold.trim() === '') return { dropped: true };
    return { text: withoutScaffold };
  }
  return { text: cleaned };
}

/** 剥一条消息里的 currentDate 段：保留同块其余内容（CLAUDE.md 等常与 currentDate
 *  同块注入 —— 整块删会把项目档案一起吃掉）。 */
function stripCurrentDateBlocks(m) {
  if (!m) return m;
  if (typeof m.content === 'string') {
    if (m.content.includes('# currentDate') && m.content.includes('<system-reminder>')) {
      const { text, dropped } = cleanCurrentDateRemnant(m.content);
      m.content = dropped ? '' : text;
    }
    return m;
  }
  if (!Array.isArray(m.content)) return m;
  const out = [];
  let changed = false;
  for (const b of m.content) {
    const t = typeof b === 'string' ? b : b?.text;
    if (typeof t === 'string' && t.includes('# currentDate') && t.includes('<system-reminder>')) {
      const { text, dropped } = cleanCurrentDateRemnant(t);
      if (dropped) {
        changed = true;      // 整块只剩提醒 → 删块（必须置位，否则内容数组不赋回 —— 2026-08-26 实锤 bug）
        continue;
      }
      if (text !== t) { out.push(typeof b === 'string' ? text : { ...b, text }); changed = true; }
      else out.push(b);
    } else {
      out.push(b);
    }
  }
  if (changed) m.content = out;
  return m;
}

/**
 * 把块的文本取出来（块可能是 string 或 {type:'text', text}）
 */
function blockText(b) {
  return typeof b === 'string' ? b : (b?.text ?? '');
}

/** 顶层 system 数组：滤掉计费头块与身份行块 */
function stripSystemArray(system) {
  const kept = system.filter((b) => {
    const t = blockText(b);
    if (t.startsWith(BILLING_HEADER_PREFIX)) return false;
    if (t.includes(IDENTITY_MARKER)) return false;
    return true;
  });
  return kept.length ? kept : undefined;   // 全剥光 → 删字段，不留空数组
}

/** 顶层 system 字符串形式：剥身份行（计费头永远走数组块，字符串里没有） */
function stripSystemString(system) {
  const lines = system.split('\n').filter((l) => !l.includes(IDENTITY_MARKER));
  return lines.join('\n');
}

/**
 * 剥除 SDK 残留，就地修改并返回 parsed（幂等）。
 * @param {object} parsed 已 JSON.parse 的 /v1/messages 请求体
 * @returns {object} 同一个对象（就地改），便于链式
 */
export function stripSdkResidue(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  // 1+2. 顶层 system（数组或字符串两种形态）
  if (Array.isArray(parsed.system)) {
    const cleaned = stripSystemArray(parsed.system);
    if (cleaned === undefined) delete parsed.system;   // 全剥光 → 删字段，不留空数组
    else parsed.system = cleaned;
  } else if (typeof parsed.system === 'string' && parsed.system.includes(IDENTITY_MARKER)) {
    const cleaned = stripSystemString(parsed.system);
    if (cleaned) parsed.system = cleaned;
    else delete parsed.system;
  }
  // 3. messages 里的 role=system 动态提醒段（SDK 每次请求塞一条）
  if (Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.filter((m) => m?.role !== 'system');
    for (const m of parsed.messages) stripCurrentDateBlocks(m);
    if (parsed.messages.length === 0) delete parsed.messages;
  }
  return parsed;
}