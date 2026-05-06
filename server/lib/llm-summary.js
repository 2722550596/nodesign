/**
 * server/lib/llm-summary.js — 用 NODESIGN_FAST_MODEL（haiku）对一段文本生成
 * 极短"标题型"摘要。
 *
 * 用途：TimelineGroup 折叠标题（"Architecting data structure..." 风格 ~12 字）。
 *   Stop hook 抓到 turn 末 last_assistant_message → 这里 → emit run.timeline_summary
 *   → 前端 TimelineGroup 显示。
 *
 * 走 NoDesk 网关同 channel 同 key（passthrough → DMXAPI / haiku-cc）。直接 fetch
 * 不经 SDK binary（这是个 host-side helper，不该走那 Anthropic 协议路径）。
 *
 * 失败 fail-soft：返回 null 让 caller 走 fallback（截首段 60 字）。
 */

const NODESK_PASSTHROUGH = '/default/passthrough';
const TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 4000;     // 输入太长就截，防止给 haiku 整页提示词
const MAX_OUTPUT_TOKENS = 60;     // 12 个汉字 ≈ 24 token，60 给余量

/**
 * 把一段文字总结成 ≤12 个字的"动作型标题"。
 *
 * @param {string} text 输入（thinking 段 / last_assistant_message 等）
 * @param {object} [opts]
 * @param {string} [opts.style='action'] 风格："action"=动作型 / "topic"=主题型
 * @returns {Promise<string|null>} 12 字以内中文短标题；失败返回 null
 */
export async function summarizeForTimeline(text, { style = 'action' } = {}) {
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

  const promptByStyle = {
    action: '请把下面这段 agent 工作内容总结成 ≤12 个汉字的动作型标题，'
      + '类似"重排首屏布局"/"补字体回退方案"/"诊断 vision 异常"。'
      + '只输出标题文本，不要引号、不要标点结尾、不要解释。',
    topic: '请把下面这段内容总结成 ≤12 个汉字的主题短语，只输出标题文本，'
      + '不要引号、不要标点结尾、不要解释。',
  };
  const systemPrompt = promptByStyle[style] || promptByStyle.action;

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
      console.warn(`[llm-summary] HTTP ${resp.status}: ${resp.statusText}`);
      return null;
    }
    const json = await resp.json();
    const block = (json?.content || []).find(b => b?.type === 'text');
    const out = block?.text?.trim();
    if (!out) return null;
    // 单行 + 截 60（按字符；Modal/header 还会再截）+ 去尾标点
    return out.split('\n')[0].slice(0, 60).replace(/[。！?,，.!?；;]+$/, '').trim();
  } catch (err) {
    console.warn(`[llm-summary] fetch failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
