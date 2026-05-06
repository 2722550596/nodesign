/**
 * server/lib/llm-translate.js — 把一段中文搜索词翻成简洁英文搜索词。
 *
 * 用途：web_search.js include_images=true 时，CJK query → tavily 之前先翻英文。
 * Tavily 顶层 images[].description 字段在英文 query 下质量明显高（实测 100% 有
 * 详细描述；中文 query 尾部 ~50% null）。
 *
 * 走 NoDesk 网关同 channel 同 key（passthrough → DMXAPI / haiku-cc），不经 SDK binary。
 * 失败 fail-soft：返回 null，caller 决定回退（用原始 CJK query 或拒绝）。
 */
const NODESK_PASSTHROUGH = '/default/passthrough';
const TIMEOUT_MS = 8_000;
const MAX_INPUT_CHARS = 500;
const MAX_OUTPUT_TOKENS = 80;

/**
 * 把搜索 query 翻成 ≤15 词英文搜索词。
 *
 * @param {string} text 输入 query（中/英/混合都行）
 * @returns {Promise<string|null>} 英文短 query；失败返回 null
 */
export async function translateToEnglish(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!trimmed) return null;

  const gatewayUrl = process.env.NODESIGN_GATEWAY_URL;
  const gatewayKey = process.env.NODESIGN_GATEWAY_KEY;
  const channel = process.env.NODESIGN_GATEWAY_CHANNEL || 'DMX';
  const channelUrlBase = (process.env.NODESIGN_GATEWAY_CHANNEL_URL_BASE
    || 'https://www.dmxapi.cn').replace(/\/$/, '');
  const fastModel = process.env.NODESIGN_FAST_MODEL || 'claude-haiku-4-5-20251001-cc';

  if (!gatewayUrl || !gatewayKey) return null;

  const systemPrompt =
    'Translate the user-provided search query into a concise English image-search query, '
    + '≤15 words. Preserve product / brand names verbatim. Output only the English query, '
    + 'no quotes, no explanation, no trailing punctuation.';

  const body = {
    channel,
    channel_url: `${channelUrlBase}/v1/messages`,
    model: fastModel,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: trimmed }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = gatewayUrl.replace(/\/$/, '') + NODESK_PASSTHROUGH;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`[llm-translate] HTTP ${resp.status}`);
      return null;
    }
    const json = await resp.json();
    const block = (json?.content || []).find(b => b?.type === 'text');
    const out = block?.text?.trim();
    if (!out) return null;
    return out.split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim().slice(0, 200);
  } catch (err) {
    console.warn(`[llm-translate] fetch failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
