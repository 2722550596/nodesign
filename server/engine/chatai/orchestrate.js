/**
 * orchestrate.js —— 编排编译：把演出文件夹里的 `编排.yaml` 变成一次 chatai
 * 调用的 system + messages。
 *
 * 三区模型（2026-08-15 定案，来路：酒馆的播放单心智 + NovelAI 的三位置 +
 * Anthropic 的排序纪律）：
 *
 *   系统层  → system 参数。身份/世界观/规则/文风，整区冻结，是缓存的本体。
 *   历史    → 对话.jsonl。弹性区：被「上下文预算」从最旧挤压，被摘要折叠。
 *   尾部    → 拼进当轮 user 消息前部。唯一允许每轮变化的区。
 *
 * ⭐ 触发条目只许住尾部——这是结构性的缓存保护，不是纪律约束。酒馆把触发
 * 词条插在前缀中段，573 条词库实测缓存命中率 0%、一轮一美元；把易变的东西
 * 全部关进「最新对话之后」的位置，前缀想不稳定都难。
 *
 * 机制层不认识「角色卡 / 世界书 / 文风锚」——那些是 skill 教 agent 的类型学。
 * 这里只有条目（名字 / 文件或内容 / 触发 / 停用）和区归属。
 *
 * 「每轮允许多大范围变化」的旋钮 = 条目的区归属：放系统层是冻住换缓存，
 * 挪尾部是放开换灵活。设置页把它画成拖过一条线。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { readLog, readSummary } from './chat-log.js';

export const CONFIG_FILE = '编排.yaml';

/** 触发词的扫描窗口：最近 8 条记录（≈4 轮）+ 当轮输入。写死不做旋钮。 */
const TRIGGER_SCAN_RECORDS = 8;

const DEFAULTS = Object.freeze({
  最大输出: 2000,
  上下文预算: 60000,
  历史: Object.freeze({ 文件: '对话.jsonl', 保留轮数: 40 }),
  摘要: Object.freeze({ 启用: true, 保留轮数: 12, 触发轮数: 24, 长度: 500 }),
});

function fail(msg) {
  throw Object.assign(new Error(msg), { code: 'ORCH_INVALID' });
}

/**
 * token 估算（下限口径）：CJK 按 1 字 1 token，其余按 4 字符 1 token。
 * 不含聊天模板开销，只用于预算挤压和设置页展示，不用于计费。
 */
export function estTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[⺀-鿿豈-﫿＀-￯]/g) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** 文件引用只许指向文件夹内部（配置是用户/agent 写的，但端点跑在服务端） */
function resolveInside(dir, rel, ctx) {
  const abs = path.resolve(dir, String(rel));
  if (abs !== path.resolve(dir) && !abs.startsWith(path.resolve(dir) + path.sep)) {
    fail(`${ctx}：文件引用「${rel}」跑出了演出文件夹`);
  }
  return abs;
}

function normalizeEntry(raw, zone, i) {
  if (!raw || typeof raw !== 'object') fail(`${zone}第 ${i + 1} 条不是对象`);
  const 名字 = String(raw.名字 || `${zone}${i + 1}`);
  const hasFile = raw.文件 != null;
  const hasText = raw.内容 != null;
  if (hasFile && hasText) fail(`${zone}「${名字}」同时给了 文件 和 内容，只能二选一`);
  if (!hasFile && !hasText) fail(`${zone}「${名字}」既没有 文件 也没有 内容`);
  let 触发 = null;
  if (raw.触发 != null) {
    if (zone === '系统层') {
      fail(`系统层「${名字}」带了触发——触发条目只能住尾部（缓存稳定性的结构保证），要么去掉触发，要么整条挪到尾部`);
    }
    if (!Array.isArray(raw.触发) || !raw.触发.length || raw.触发.some(k => typeof k !== 'string' || !k.trim())) {
      fail(`尾部「${名字}」的触发要是非空字符串数组`);
    }
    触发 = raw.触发.map(k => k.trim());
  }
  return {
    名字, 触发,
    文件: hasFile ? String(raw.文件) : null,
    内容: hasText ? String(raw.内容) : null,
    停用: raw.停用 === true,
  };
}

function intField(v, def, name, { min = 1 } = {}) {
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) fail(`${name} 要是 ≥${min} 的整数，拿到的是 ${JSON.stringify(v)}`);
  return n;
}

/**
 * 读并校验 `编排.yaml`。硬错误直接抛（演出拒开比带病开演好——
 * 假数据教训的同族：静默兜底比报错更坏）。
 */
export async function loadOrchestration(dir) {
  let raw;
  try {
    raw = await fs.readFile(path.join(dir, CONFIG_FILE), 'utf8');
  } catch {
    throw Object.assign(
      new Error(`这个文件夹没有 ${CONFIG_FILE}，不是演出文件夹`),
      { code: 'ORCH_NO_CONFIG' },
    );
  }
  let doc;
  try { doc = YAML.parse(raw); } catch (e) {
    fail(`${CONFIG_FILE} 不是合法 YAML：${e.message}`);
  }
  if (!doc || typeof doc !== 'object') fail(`${CONFIG_FILE} 顶层要是对象`);

  const 系统层 = (doc.系统层 ?? []).map((e, i) => normalizeEntry(e, '系统层', i));
  const 尾部 = (doc.尾部 ?? []).map((e, i) => normalizeEntry(e, '尾部', i));

  const 历史 = {
    文件: String(doc.历史?.文件 ?? DEFAULTS.历史.文件),
    保留轮数: intField(doc.历史?.保留轮数, DEFAULTS.历史.保留轮数, '历史.保留轮数', { min: 0 }),
  };
  const 摘要 = {
    启用: doc.摘要?.启用 !== false,
    模型: doc.摘要?.模型 ? String(doc.摘要.模型) : null,
    提示: doc.摘要?.提示 ? String(doc.摘要.提示) : null,
    保留轮数: intField(doc.摘要?.保留轮数, DEFAULTS.摘要.保留轮数, '摘要.保留轮数'),
    触发轮数: intField(doc.摘要?.触发轮数, DEFAULTS.摘要.触发轮数, '摘要.触发轮数'),
    长度: intField(doc.摘要?.长度, DEFAULTS.摘要.长度, '摘要.长度'),
  };
  if (摘要.触发轮数 <= 摘要.保留轮数) {
    fail(`摘要.触发轮数(${摘要.触发轮数}) 必须大于 摘要.保留轮数(${摘要.保留轮数})，不然每轮都在摘要`);
  }

  return {
    模型: doc.模型 ? String(doc.模型) : null,
    最大输出: intField(doc.最大输出, DEFAULTS.最大输出, '最大输出'),
    上下文预算: intField(doc.上下文预算, DEFAULTS.上下文预算, '上下文预算'),
    系统层, 历史, 尾部, 摘要,
  };
}

async function resolveEntryText(dir, entry, zone) {
  if (entry.内容 != null) return entry.内容;
  const abs = resolveInside(dir, entry.文件, `${zone}「${entry.名字}」`);
  try {
    return await fs.readFile(abs, 'utf8');
  } catch {
    fail(`${zone}「${entry.名字}」引用的文件不存在：${entry.文件}`);
  }
}

/**
 * 编译一轮演出的上下文。
 *
 * 拼装次序（= 进模型的次序）：
 *   system  = 系统层条目按配置顺序拼接
 *   messages = [摘要折叠后的历史…, 当轮 user 消息]
 *   当轮 user 消息 = (无历史时的前情提要) + 尾部资料块 + 用户输入
 *
 * 前情提要注入进第一条 user 消息（历史为空时进当轮输入），不占独立消息位——
 * 两种协议对消息交替的要求不同，塞进已有 user 消息是最不挑协议的做法。
 *
 * ⭐ 注入每轮现算现拼，绝不写进 对话.jsonl。记录只存双方真实发言，否则注入
 * 随历史滚雪球，且改配置无法影响已有对话。
 *
 * @returns {{ model, maxTokens, system, messages, meta }}
 */
export async function compileContext({ dir, userInput, config = null }) {
  const cfg = config || await loadOrchestration(dir);
  const input = String(userInput ?? '').trim();
  if (!input) fail('当轮输入是空的');

  const meta = { 条目: [], 历史: {}, 估算: {} };

  // ── 系统层 ──
  const sysTexts = [];
  for (const e of cfg.系统层) {
    if (e.停用) { meta.条目.push({ 区: '系统层', 名字: e.名字, 进入: false, 因: '停用' }); continue; }
    const text = await resolveEntryText(dir, e, '系统层');
    sysTexts.push(text.trim());
    meta.条目.push({ 区: '系统层', 名字: e.名字, 进入: true, tokens: estTokens(text) });
  }
  const system = sysTexts.join('\n\n');

  // ── 历史与摘要边界 ──
  const all = await readLog(dir, cfg);
  const summary = await readSummary(dir);
  const boundary = summary?.至 ?? 0;
  let live = all.filter(r => r.seq > boundary);
  while (live.length && live[0].role !== 'user') live.shift();   // 摘要折叠后开头必须是 user

  // ── 尾部触发扫描：最近 8 条记录 + 当轮输入 ──
  const scanText = live.slice(-TRIGGER_SCAN_RECORDS).map(r => r.text).concat(input).join('\n');
  const tailBlocks = [];
  for (const e of cfg.尾部) {
    if (e.停用) { meta.条目.push({ 区: '尾部', 名字: e.名字, 进入: false, 因: '停用' }); continue; }
    if (e.触发 && !e.触发.some(k => scanText.includes(k))) {
      meta.条目.push({ 区: '尾部', 名字: e.名字, 进入: false, 因: '未触发' });
      continue;
    }
    const text = await resolveEntryText(dir, e, '尾部');
    tailBlocks.push(`<资料 名="${e.名字}">\n${text.trim()}\n</资料>`);
    meta.条目.push({ 区: '尾部', 名字: e.名字, 进入: true, tokens: estTokens(text), ...(e.触发 ? { 因: '触发命中' } : {}) });
  }

  // ── 历史挤压：先按保留轮数截，再按预算从最旧丢，切口永远落在 user 记录上 ──
  const userIdxs = live.map((r, i) => (r.role === 'user' ? i : -1)).filter(i => i >= 0);
  let cut = userIdxs.length > cfg.历史.保留轮数
    ? userIdxs[userIdxs.length - cfg.历史.保留轮数]
    : 0;
  const summaryBlock = summary ? `<前情提要>\n${summary.内容.trim()}\n</前情提要>` : null;
  const fixedEst = estTokens(system) + estTokens(tailBlocks.join('')) + estTokens(input)
    + (summaryBlock ? estTokens(summaryBlock) : 0);
  let dropped = 0;
  const histEst = () => live.slice(cut).reduce((n, r) => n + estTokens(r.text), 0);
  while (cut < live.length && fixedEst + histEst() > cfg.上下文预算) {
    const next = userIdxs.find(i => i > cut);
    dropped += 1;
    if (next == null) { cut = live.length; break; }
    cut = next;
  }
  const hist = live.slice(cut).map(r => ({ role: r.role, content: r.text }));

  meta.历史 = {
    总轮数: all.filter(r => r.role === 'user').length,
    摘要已折叠: boundary > 0,
    进入轮数: hist.filter(m => m.role === 'user').length,
    预算丢弃轮数: dropped,
  };

  // ── 拼消息 ──
  if (summaryBlock && hist.length) {
    hist[0] = { ...hist[0], content: `${summaryBlock}\n\n${hist[0].content}` };
  }
  const currentParts = [];
  if (summaryBlock && !hist.length) currentParts.push(summaryBlock);
  currentParts.push(...tailBlocks, input);
  const messages = [...hist, { role: 'user', content: currentParts.join('\n\n') }];

  meta.估算 = {
    系统层: estTokens(system),
    历史: hist.reduce((n, m) => n + estTokens(m.content), 0),
    当轮: estTokens(messages[messages.length - 1].content),
    预算: cfg.上下文预算,
  };
  meta.估算.合计 = meta.估算.系统层 + meta.估算.历史 + meta.估算.当轮;

  return { model: cfg.模型, maxTokens: cfg.最大输出, system, messages, meta };
}
