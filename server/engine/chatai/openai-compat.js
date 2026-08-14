/**
 * openai-compat.js —— OpenAI 兼容协议的模型通路
 *
 * 一次补全调用，没别的。传 system + messages，回来文本和用量。
 * 谁来拼 messages、拼什么，不是这一层的事。
 *
 * ⚠️ 实测（2026-08-14，中转站 + gemini-3.7-flash-low）：
 *   - **思考 token 关不掉**。一次普通生成正文 240、思考 903，接近四倍。
 *     reasoningTokens 必须单列，否则看着正文纳闷账单为什么是三倍。
 *   - **这条路上没有任何 cache 字段**。同一请求重打两次，prompt_tokens 一模一样
 *     （3748 → 3748），但延迟从 10.0s 掉到 1.8s —— 上游隐式缓存在起作用，但计费
 *     口径上不可见也不可控。所以 cacheReadTokens 在 Gemini 路上恒为 0，别拿它算账。
 *   - 流式分片很粗（一句话四片），因为中转站是把上游收完再重组的。别指望逐字流。
 */

const DEFAULT_TIMEOUT_MS = 180_000;

function normalizeUsage(u = {}) {
  const details = u.completion_tokens_details || {};
  return {
    inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
    reasoningTokens: details.reasoning_tokens ?? u.reasoning_tokens ?? 0,
    cacheReadTokens:
      u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0,
    raw: u,
  };
}

/**
 * @param {object} opts
 *   base/key/model      通路配置
 *   system              系统提示（字符串，可空）
 *   messages            [{role, content}]，至少一条
 *   maxTokens/signal    常规
 *   onDelta             给了就走流式
 */
export async function callOpenAICompat({
  base, key, model, system = '', messages = [], maxTokens = 2000, signal, onDelta,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const stream = typeof onDelta === 'function';
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
    max_tokens: maxTokens,
    stream,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('chatai 超时')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });

  let res;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw Object.assign(new Error(`chatai 请求失败：${err.message}`), { code: 'CHATAI_NETWORK' });
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`chatai 上游 ${res.status}：${text.slice(0, 400)}`),
      { code: 'CHATAI_UPSTREAM', status: res.status },
    );
  }

  if (!stream) {
    clearTimeout(timer);
    const j = await res.json();
    return {
      text: j.choices?.[0]?.message?.content ?? '',
      usage: normalizeUsage(j.usage),
      finish: j.choices?.[0]?.finish_reason ?? null,
    };
  }

  let text = '';
  let usage = {};
  let finish = null;
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices?.[0];
        const piece = d?.delta?.content;
        if (piece) { text += piece; onDelta(piece); }
        if (d?.finish_reason) finish = d.finish_reason;
        if (j.usage) usage = j.usage;      // 中转站每片都带 usage，最后一片为准
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { text, usage: normalizeUsage(usage), finish };
}
