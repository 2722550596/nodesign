/**
 * server/lib/danbooru-tags.js — danbooru 标签收录量校验（2026-08-18）
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
 * ## 纪律
 *
 * - **fail-open**：查不到、超时、断网一律不挡出图。这是一个提示，不是闸门。
 * - **只提示不改写**：绝不替 agent 改 prompt —— 「逐字传递」是既有纪律，
 *   而且替换词的选择是创作判断，不是查表能定的。
 */

const API = 'https://danbooru.donmai.us/tags.json';
const BATCH = 100;
const LOW = 1000;

/** 进程内缓存。标签收录量是慢变量，一个进程生命周期内不用重查。 */
const cache = new Map();   // name → post_count（-1 = 查过但 danbooru 上没有这个条目）

/**
 * 从一段 danbooru 风格 prompt 里抠出标签名。
 * 剥掉权重 `(tag:1.2)`、方括号、LoRA `<lora:x:1>`、`BREAK`，把空格转下划线。
 */
export function extractTags(text) {
  if (!text || typeof text !== 'string') return [];
  return String(text)
    .replace(/<[^>]*>/g, ' ')                 // <lora:...>
    .replace(/\bBREAK\b/gi, ',')
    .split(',')
    .map(raw => raw
      .replace(/[()[\]{}]/g, '')              // 权重括号
      .replace(/:\s*[\d.]+\s*$/, '')          // :1.2 权重
      .trim().toLowerCase()
      .replace(/\s+/g, '_'))
    .filter(t => t
      && t.length >= 3 && t.length <= 60
      && /^[a-z0-9_\-'.()]+$/.test(t)         // 中文/自然语言句子不是 danbooru 标签，跳过
      && !/^\d+$/.test(t));
}

async function fetchCounts(names, timeoutMs) {
  const out = new Map();
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const url = `${API}?search%5Bname_comma%5D=${encodeURIComponent(chunk.join(','))}&limit=${BATCH * 2}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'nodesign-tag-lint' } });
      if (!res.ok) return null;                          // fail-open
      for (const row of await res.json()) {
        if (row?.name) out.set(row.name, Number(row.post_count) || 0);
      }
      for (const n of chunk) if (!out.has(n)) out.set(n, -1);   // danbooru 上没这条目
    } catch {
      return null;                                      // 超时/断网 → fail-open
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/**
 * @param {string[]} texts  prompt / negative 原文
 * @returns {Promise<{zero:string[], low:Array<[string,number]>, missing:string[], checked:number}|null>}
 *   null = 查不了（fail-open，调用方什么都不要说）
 */
export async function lintTags(texts, { timeoutMs = 3000 } = {}) {
  const names = [...new Set(texts.flatMap(extractTags))];
  if (!names.length) return null;

  const need = names.filter(n => !cache.has(n));
  if (need.length) {
    const fetched = await fetchCounts(need, timeoutMs);
    if (!fetched) return null;
    for (const [k, v] of fetched) cache.set(k, v);
  }

  const zero = [], low = [], missing = [];
  for (const n of names) {
    const c = cache.get(n);
    if (c == null) continue;
    if (c === -1) missing.push(n);
    else if (c === 0) zero.push(n);
    else if (c < LOW) low.push([n, c]);
  }
  return { zero, low, missing, checked: names.length };
}

/** 把 lint 结果写成给 agent 看的一段话。没什么可说时返回 null。 */
export function formatTagLint(r) {
  if (!r) return null;
  const parts = [];
  if (r.missing.length) parts.push(`不存在的标签：${r.missing.join(', ')}`);
  if (r.zero.length) parts.push(`0 收录（存在但训练里等于没有）：${r.zero.join(', ')}`);
  if (r.low.length) {
    parts.push(`低收录（<${LOW}，建议配近义词一起写）：`
      + r.low.map(([n, c]) => `${n}(${c})`).join(', '));
  }
  if (!parts.length) return null;
  return `⚠️ 标签体检（查了 ${r.checked} 个）：\n  ${parts.join('\n  ')}\n`
    + '  这些词模型收不到，等于没写 —— 换成有收录量的近义词再滚一次，别按这批图判断方向。';
}
