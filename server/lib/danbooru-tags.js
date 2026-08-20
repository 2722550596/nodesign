/**
 * server/lib/danbooru-tags.js — danbooru 标签收录量校验 + 查询（2026-08-18 起）
 *
 * ## 为什么需要
 *
 * danbooru 系模型（noobai / noobai-eps / pony）吃的是 danbooru 标签。标签写错
 * **不会报错，只会静默失效** —— 模型收到的等于空气。一个 agent 在一轮长时间
 * 配图里因此烧掉至少五轮出图，每次都是"图不对 → 用户反馈 → 去查标签 → 发现
 * 根本没有这个词"。
 *
 * 最典型的一次：连续三张图里"妆花了"完全不生效，用户反复说"她太干净了"，
 * 而 `running_makeup` / `smeared_eyeliner` / `dried_tears` / `ruined_makeup`
 * 四个词**全是 0 收录**。真正有货的是 tears(29万) / crying_with_eyes_open(5.4万)
 * / smeared_lipstick / dirty_face。
 *
 * ⭐ **判据是 post_count 不是"标签存不存在"**：`running_makeup` 在 danbooru 上
 * 确实有这个条目，`post_count` 是 0 —— 存在但没有一张图用过它，训练里等于不存在。
 * 只查"有没有这个条目"会漏掉整类问题（实测过）。
 *
 * ## 两个入口，一份逻辑（2026-08-20）
 *
 * - `lintTags`：paint_still **画完之后**的体检 —— 收录量 + 「这段像句子不像标签」
 *   + 「带下划线」两项本地判定（不联网也能说）。
 * - `lookupTags`：`lookup_tags` 工具，**画之前**查 —— 同一套收录量判定，外加
 *   弱词自动给候选替换（danbooru 通配搜索按收录量排序）、自由词搜索、wiki 释义。
 *   目的是把"先理解用户意思 → 查真实标签 → 再画"的纪律变得比 curl 便宜。
 *
 * ## 纪律
 *
 * - **fail-open**：查不到、超时、断网一律不挡出图。这是一个提示，不是闸门。
 * - **只提示不改写**：绝不替 agent 改 prompt —— 「逐字传递」是既有纪律，
 *   而且替换词的选择是创作判断，不是查表能定的。
 */

const API = 'https://danbooru.donmai.us';
const BATCH = 100;
const LOW = 1000;
const UA = { 'User-Agent': 'nodesign-tag-lint' };

/** 进程内缓存。标签收录量是慢变量，一个进程生命周期内不用重查。 */
const cache = new Map();   // name → post_count（-1 = 查过但 danbooru 上没有这个条目）

// 句子判定用的功能词。⚠️ 刻意不收 of/with/on/in/own：danbooru 真标签里满是
// `hand_on_own_chest` / `playing_with_own_hair` / `cup_of_tea`，收了就是误伤。
const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'is', 'are', 'was', 'were',
  'who', 'which', 'she', 'he', 'they', 'her', 'his', 'their', 'being', 'very']);

/** 把 prompt 切成逗号片段（剥 <lora>、BREAK），保留原文便于回显。 */
function splitFragments(text) {
  if (!text || typeof text !== 'string') return [];
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\bBREAK\b/gi, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** 片段是否像自然语言句子而不是标签（模型基本不认这种输入）。 */
export function isSentenceLike(fragment) {
  const bare = fragment.replace(/[()[\]{}]/g, '').replace(/:\s*[\d.]+\s*$/, '').trim();
  if (!bare) return false;
  if (/[぀-ヿ㐀-鿿]/.test(bare)) return true;        // 中日文
  const words = bare.toLowerCase().split(/[\s_]+/).filter(Boolean);
  if (words.length >= 6) return true;
  return words.length >= 3 && words.some(w => STOPWORDS.has(w));
}

/**
 * 本地判定（不联网）：哪些片段像句子、哪些带下划线。
 * @returns {{sentences:string[], underscored:string[]}}
 */
export function classifyFragments(text) {
  const sentences = [], underscored = [];
  for (const f of splitFragments(text)) {
    if (isSentenceLike(f)) sentences.push(f);
    else if (f.includes('_')) underscored.push(f);
  }
  return { sentences, underscored };
}

function balanced(s) {
  let d = 0;
  for (const ch of s) { if (ch === '(') d++; else if (ch === ')') { d--; if (d < 0) return false; } }
  return d === 0;
}

/**
 * 标签名归一成 danbooru 的 name：剥反斜杠转义、`(tag:1.2)` 权重、纯强调用的外层括号、
 * `artist:` 一类前缀；空格转下划线。⚠️ 名字自带的括号要留：`lucy \(cyberpunk\)` → `lucy_(cyberpunk)`。
 */
export function normalizeTag(raw) {
  let s = String(raw).replace(/\\/g, '').trim();
  s = s.replace(/:\s*[\d.]+\s*(\)*)\s*$/, '$1');           // (tag:1.2) → (tag)
  while (/^[([{][\s\S]*[)\]}]$/.test(s)) {                  // 外层强调括号
    const inner = s.slice(1, -1).trim();
    if (!balanced(inner)) break;
    s = inner;
  }
  return s.replace(/[[\]{}]/g, '')
    .toLowerCase()
    .replace(/^(artist|character|copyright|meta|general):/, '')
    .trim().replace(/\s+/g, '_');
}

/**
 * 从一段 danbooru 风格 prompt 里抠出标签名（像句子的片段跳过 —— 它们另有去处）。
 */
export function extractTags(text) {
  return splitFragments(text)
    .filter(f => !isSentenceLike(f))
    .map(normalizeTag)
    .filter(t => t
      && t.length >= 3 && t.length <= 60
      && /^[a-z0-9_\-'.()!?&+]+$/.test(t)     // 中文/自然语言句子不是 danbooru 标签，跳过
      && !/^\d+$/.test(t));
}

async function getJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: UA });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCounts(names, timeoutMs) {
  const out = new Map();
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const rows = await getJson(`${API}/tags.json?search%5Bname_comma%5D=${encodeURIComponent(chunk.join(','))}&limit=${BATCH * 2}`, timeoutMs);
    if (!rows) return null;                               // fail-open
    for (const row of rows) if (row?.name) out.set(row.name, Number(row.post_count) || 0);
    for (const n of chunk) if (!out.has(n)) out.set(n, -1);   // danbooru 上没这条目
  }
  return out;
}

async function countsFor(names, timeoutMs) {
  const need = names.filter(n => !cache.has(n));
  if (need.length) {
    const fetched = await fetchCounts(need, timeoutMs);
    if (!fetched) return false;
    for (const [k, v] of fetched) cache.set(k, v);
  }
  return true;
}

function bucket(names) {
  const zero = [], low = [], missing = [], ok = [];
  for (const n of names) {
    const c = cache.get(n);
    if (c == null) continue;
    if (c === -1) missing.push(n);
    else if (c === 0) zero.push(n);
    else if (c < LOW) low.push([n, c]);
    else ok.push([n, c]);
  }
  return { zero, low, missing, ok };
}

/**
 * @param {string[]} texts  prompt / negative 原文
 * @returns {Promise<{zero:string[], low:Array<[string,number]>, missing:string[], checked:number,
 *   sentences:string[], underscored:string[], offline:boolean}|null>}
 *   null = 既查不了也没什么本地可说的（调用方什么都不要说）
 */
export async function lintTags(texts, { timeoutMs = 3000 } = {}) {
  const local = { sentences: [], underscored: [] };
  for (const t of texts) {
    const c = classifyFragments(t);
    local.sentences.push(...c.sentences);
    local.underscored.push(...c.underscored);
  }
  local.sentences = [...new Set(local.sentences)];
  local.underscored = [...new Set(local.underscored)];

  const names = [...new Set(texts.flatMap(extractTags))];
  const online = names.length ? await countsFor(names, timeoutMs) : true;
  const b = online ? bucket(names) : { zero: [], low: [], missing: [] };
  const r = { ...b, ok: undefined, checked: online ? names.length : 0, ...local, offline: !online };
  delete r.ok;
  if (!r.zero.length && !r.low.length && !r.missing.length && !r.sentences.length && !r.underscored.length) return null;
  return r;
}

/** 把 lint 结果写成给 agent 看的一段话。没什么可说时返回 null。 */
export function formatTagLint(r) {
  if (!r) return null;
  const parts = [];
  if (r.sentences?.length) {
    parts.push('像句子不像标签（模型基本不认这种输入，还摊薄其它标签的权重 —— 拆成标签）：'
      + r.sentences.map(s => `"${s}"`).join(' · '));
  }
  if (r.underscored?.length) parts.push(`带下划线（手册要求写成空格）：${r.underscored.join(', ')}`);
  if (r.missing?.length) parts.push(`不存在的标签：${r.missing.join(', ')}`);
  if (r.zero?.length) parts.push(`0 收录（存在但训练里等于没有）：${r.zero.join(', ')}`);
  if (r.low?.length) {
    parts.push(`低收录（<${LOW}，弱但不是禁区：主流需求换掉，用户要的本来就偏门就照用、配近义词加固）：`
      + r.low.map(([n, c]) => `${n}(${c})`).join(', '));
  }
  if (!parts.length) return null;
  const head = r.offline ? '⚠️ 标签体检（danbooru 查不到，只做了本地判定）：' : `⚠️ 标签体检（查了 ${r.checked} 个）：`;
  return `${head}\n  ${parts.join('\n  ')}\n`
    + '  这些词模型收不到，等于没写 —— 用 lookup_tags 换成有收录量的词再滚一次，别按这批图判断方向。';
}

// ── 画之前查：lookup_tags ──

/** 从一个弱标签里挑最多两个值得拿去通配搜索的词（最长的非功能词优先）。 */
function searchWordsOf(tag) {
  const words = tag.split(/[_\s\-()]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w)
    && !['own', 'with', 'and', 'from', 'the', 'out', 'off'].includes(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 2);
}

/** 弱标签 → 候选：每个关键词各搜一次，合并按收录量排，太弱的（<100）不当候选。 */
async function candidatesFor(tag, timeoutMs) {
  const seen = new Map();
  for (const w of searchWordsOf(tag)) {
    const hits = await wildcard(w, timeoutMs, 6);
    for (const [n, c] of hits || []) if (n !== tag && c >= 100) seen.set(n, c);
  }
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

async function wildcard(term, timeoutMs, limit = 8) {
  const q = `*${normalizeTag(term).replace(/^\*+|\*+$/g, '')}*`;
  const rows = await getJson(`${API}/tags.json?search%5Bname_matches%5D=${encodeURIComponent(q)}`
    + `&search%5Border%5D=count&search%5Bhide_empty%5D=true&limit=${limit}`, timeoutMs);
  if (!rows) return null;
  return rows.map(r => [r.name, Number(r.post_count) || 0]);
}

async function wikiOf(tag, timeoutMs) {
  const rows = await getJson(`${API}/wiki_pages.json?search%5Btitle%5D=${encodeURIComponent(normalizeTag(tag))}&only=title,body`, timeoutMs);
  const body = rows?.[0]?.body;
  if (!body) return null;
  return body.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * @param {{tags?:string[], search?:string[], explain?:string[]}} q
 * @returns {Promise<{offline:boolean, tags:{ok:Array, low:Array, zero:string[], missing:string[]},
 *   suggestions:Array<[string, Array<[string,number]>]>, searches:Array<[string, Array<[string,number]>|null]>,
 *   wiki:Array<[string,string|null]>}>}
 */
export async function lookupTags({ tags = [], search = [], explain = [] } = {}, { timeoutMs = 5000 } = {}) {
  const names = [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, 60);
  const online = names.length ? await countsFor(names, timeoutMs) : true;
  const b = online ? bucket(names) : { ok: [], low: [], zero: [], missing: [] };

  const suggestions = [];
  if (online) {
    const weak = [...b.missing, ...b.zero, ...b.low.map(([n]) => n)].slice(0, 8);
    for (const w of weak) {
      const hits = await candidatesFor(w, timeoutMs);
      if (hits.length) suggestions.push([w, hits]);
    }
  }
  const searches = [];
  for (const s of [...new Set(search)].slice(0, 10)) searches.push([s, await wildcard(s, timeoutMs, 10)]);
  const wiki = [];
  for (const t of [...new Set(explain)].slice(0, 8)) wiki.push([t, await wikiOf(t, timeoutMs)]);
  return { offline: !online, tags: b, suggestions, searches, wiki };
}

/** lookup_tags 的文本输出。 */
export function formatLookup(r) {
  const fmt = (arr) => arr.map(([n, c]) => `${n}(${c})`).join(', ');
  const out = [];
  if (r.offline) out.push('⚠️ danbooru 暂时查不到（超时/断网），收录量这部分空着；别因此停工，照手册词表写。');
  const t = r.tags;
  if (t.ok?.length) out.push(`✅ 可用（≥${LOW}）：${fmt(t.ok)}`);
  if (t.low?.length) out.push(`⚠️ 低收录（<${LOW}）：${fmt(t.low)} —— 弱但不是禁区：主流需求换成候选，用户要的本来就偏门就照用、配近义词加固`);
  if (t.zero?.length) out.push(`✗ 0 收录（等于不存在）：${t.zero.join(', ')}`);
  if (t.missing?.length) out.push(`✗ 不存在：${t.missing.join(', ')}`);
  for (const [w, hits] of r.suggestions) out.push(`  ↳ ${w} 的候选（按收录量）：${fmt(hits) || '（没搜到相近的）'}`);
  for (const [s, hits] of r.searches) {
    out.push(`🔍 *${s}*：${hits == null ? '（查不到）' : hits.length ? fmt(hits) : '（没有匹配的标签）'}`);
  }
  for (const [tag, body] of r.wiki) out.push(`📖 ${tag}：${body || '（没有 wiki）'}`);
  if (!out.length) out.push('（什么都没查 —— tags / search / explain 至少给一个）');
  return out.join('\n');
}
