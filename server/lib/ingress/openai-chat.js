/**
 * lib/ingress/openai-chat.js — Anthropic Messages ⇄ OpenAI Chat Completions 协议转换（2026-08-21）
 *
 * ## 为什么有这层
 *
 * SDK binary 永远说 Anthropic Messages；model-ingress 以前只会**转发**（上游也说 Anthropic）。
 * OpenCode Zen 的免费模型 Ox Alpha（x-preview-f-free）只有 OpenAI chat 格式能用工具
 * （Zen 给它架的 /v1/messages 桥一带 tools 就 [1210]，08-21 四种写法探死），newapi 中转站
 * 同病。所以协议映射得自己做 —— 不上 gproxy（外部守护进程 + 四个已知洞 + 第二个 quirk
 * 真相源），在 ingress 里按上游 `protocol: 'openai-chat'` 分岔，其余上游一字不动。
 *
 * ## 映射要点（都是探针实测逼出来的，不是抄规范）
 *
 * - tool_result 里的图一律提到紧随其后的 user 消息里：tool 角色消息里放 image_url 上游挂死 120s
 * - tool_result 必须紧跟 assistant 的 tool_calls：Anthropic 一条 user 消息里 tool_result 与
 *   文本混排 → 先吐 role:tool 条，再吐 role:user 条（文本 + 提出来的图）
 * - thinking 块不回传（没有 signature 机制）；assistant 历史里的 thinking 合成 reasoning_content
 *   （models.dev 标 interleaved.field=reasoning_content，回传给模型接着想）
 * - Anthropic thinking 参数 → reasoning_effort（行内 reasoningEffort，Ox 三档 low|high|max）
 * - 流式：OpenAI chunk → 合成 message_start / content_block_* / message_delta / message_stop；
 *   usage 在最后一个 chunk（stream_options.include_usage），Anthropic 口径 input 不含 cache 命中
 * - stop_reason：tool_calls→tool_use · stop→end_turn · length→max_tokens；有 tool_calls 但
 *   finish 说 stop 也算 tool_use（CLI 认块不认 stop_reason，但别给它矛盾信号）
 * - **上游私货 finish_reason**（08-21）：Zen 会吐 `finish_reason:"network_error"`（它到模型
 *   提供方那一跳断了），实测形态是挂 185 秒或快败 6~9 秒后零 delta 收场。这种值不在
 *   STOP_MAP 里，以前落 `|| 'end_turn'` = 把上游故障包装成"成功的空回合"，CLI 只能补一句
 *   "你上一轮没有可见输出"再跑一整轮（真实代价：185s 空转 + 一整轮重来）。现在改成发
 *   error 事件 —— **假上游实验实测：CLI 收到流中 error 会在 0.2~0.4 秒内原样重发，用户
 *   全程无感**，所以重试交给它，ingress 不自建（两层重试互不知情，只会让失败会话多占并发槽）
 * - **refusal 字段**：OpenAI 的拒答走 `delta.refusal` / `message.refusal` 而不是 content，
 *   我们以前整个没读 = 又一种"零可见输出的假成功"。当文本吐出去即可。
 *   ⚠️ 别顺手把 content_filter 映射成 Anthropic 的 `refusal` stop_reason（gproxy 那么写）：
 *   实测 CLI 见到 stop_reason=refusal 会弹「Start a new session」并丢弃随流正文，
 *   会话直接判死 —— 现有的 content_filter→end_turn 在 Claude Code 语境下才是对的
 */
import { Transform } from 'node:stream';

const STOP_MAP = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens', content_filter: 'end_turn', function_call: 'tool_use' };

/** finish_reason 是不是上游私货（不在 STOP_MAP 里）。null/undefined 不算 —— 那是"没给收尾原因"，另有分支 */
const isAlienFinish = (finish) => Boolean(finish) && !(finish in STOP_MAP);

function textOfBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

function imagePart(block) {
  const src = block?.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

/** tool_result.content → (text, images[])。图不留在 tool 消息里（上游挂死），拿出来给调用方放进 user 消息 */
function splitToolResult(block) {
  const images = [];
  let text = '';
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    const parts = [];
    for (const inner of block.content) {
      if (inner?.type === 'text') parts.push(inner.text || '');
      else if (inner?.type === 'image') { const p = imagePart(inner); if (p) { images.push(p); parts.push('[image: see the image attached to the following user message]'); } }
    }
    text = parts.join('\n');
  }
  if (block.is_error && text) text = `[tool error] ${text}`;
  return { text, images };
}

/**
 * @param {object} parsed Anthropic Messages body（已过 transformForUpstream：model 已是 wireModel）
 * @param {{ reasoningEffort?: string, maxOutput?: number }} opts
 * @returns {object} OpenAI chat.completions body
 */
export function toOpenAIChatRequest(parsed, opts = {}) {
  const out = { model: parsed.model, messages: [] };
  const sys = textOfBlocks(parsed.system);
  if (sys) out.messages.push({ role: 'system', content: sys });

  for (const msg of parsed.messages || []) {
    if (!msg) continue;
    if (msg.role === 'assistant') {
      const m = { role: 'assistant', content: '' };
      if (typeof msg.content === 'string') m.content = msg.content;
      else if (Array.isArray(msg.content)) {
        const texts = []; const thoughts = []; const calls = [];
        for (const b of msg.content) {
          if (b?.type === 'text') texts.push(b.text || '');
          else if (b?.type === 'thinking' && b.thinking) thoughts.push(b.thinking);
          else if (b?.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
        // 只有 thinking（被打断的回合）时 content 为空且无 tool_calls，部分 OpenAI 兼容后端会 400 —— 补个占位
        m.content = texts.join('\n') || (calls.length ? '' : '(no text)');
        if (thoughts.length) m.reasoning_content = thoughts.join('\n');
        if (calls.length) m.tool_calls = calls;
      }
      out.messages.push(m);
      continue;
    }
    // user：tool_result 先出（紧跟 tool_calls），其余文本/图合成一条 user
    if (typeof msg.content === 'string') { out.messages.push({ role: 'user', content: msg.content }); continue; }
    if (!Array.isArray(msg.content)) continue;
    const toolMsgs = []; const parts = []; const lifted = [];
    for (const b of msg.content) {
      if (b?.type === 'tool_result') {
        const { text, images } = splitToolResult(b);
        toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text || '(empty)' });
        lifted.push(...images);
      } else if (b?.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b?.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
      else if (b?.type === 'document') parts.push({ type: 'text', text: '[document attachment omitted: upstream cannot read documents]' });
    }
    out.messages.push(...toolMsgs);
    const all = [...parts, ...lifted];
    if (all.length) {
      const onlyText = all.every(p => p.type === 'text');
      out.messages.push({ role: 'user', content: onlyText ? all.map(p => p.text).join('\n') : all });
    }
  }

  if (Array.isArray(parsed.tools)) {
    const fns = parsed.tools
      .filter(t => t && t.name && (t.type === undefined || t.type === 'custom'))
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
    if (fns.length) out.tools = fns;
  }
  const tc = parsed.tool_choice;
  if (tc && out.tools) {
    if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else out.tool_choice = 'auto';
  }

  const cap = opts.maxOutput || 131072;
  out.max_tokens = Math.max(1, Math.min(Number(parsed.max_tokens) || cap, cap));
  if (typeof parsed.temperature === 'number') out.temperature = parsed.temperature;
  if (typeof parsed.top_p === 'number') out.top_p = parsed.top_p;
  if (Array.isArray(parsed.stop_sequences) && parsed.stop_sequences.length) out.stop = parsed.stop_sequences.slice(0, 4);
  if (parsed.stream) { out.stream = true; out.stream_options = { include_usage: true }; }
  // 档位只看行内 reasoningEffort：Anthropic 的 thinking 字段在进到这里之前已被 transformForUpstream
  // 按行内 thinking:'strip' 删掉（fable 评审抓的：以前以它存在为前提，档位从没发出去过）
  if (opts.reasoningEffort && parsed.thinking?.type !== 'disabled') out.reasoning_effort = opts.reasoningEffort;
  return out;
}

function usageFromOpenAI(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const cached = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  const prompt = Number(u.prompt_tokens) || 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: Number(u.completion_tokens) || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

function parseArgs(s) {
  if (s == null || s === '') return {};
  try { return JSON.parse(s); } catch { return { _raw_arguments: String(s) }; }
}

/**
 * 非流式：OpenAI chat.completion → Anthropic message。
 * 返回 null = 别包成成功回合，调用方回 502（CLI 会重试）。两种情况返 null：
 *   ① 没有 choices（上游 200 但给了错误体/空体）
 *   ② finish_reason 是上游私货且零可见输出（流式那条 `_finish` 的孪生洞，同一张 STOP_MAP）
 */
export function fromOpenAIChatResponse(json) {
  if (!json || !Array.isArray(json.choices) || !json.choices.length) return null;
  const choice = json.choices[0] || {};
  const m = choice.message || {};
  const content = [];
  if (m.reasoning_content) content.push({ type: 'thinking', thinking: String(m.reasoning_content), signature: '' });
  if (m.content) content.push({ type: 'text', text: String(m.content) });
  if (m.refusal) content.push({ type: 'text', text: String(m.refusal) });
  for (const c of m.tool_calls || []) {
    content.push({ type: 'tool_use', id: c.id || `call_${content.length}`, name: c.function?.name || '', input: parseArgs(c.function?.arguments) });
  }
  const hasTools = (m.tool_calls || []).length > 0;
  const hasVisible = hasTools || Boolean(m.content) || Boolean(m.refusal);
  if (isAlienFinish(choice.finish_reason) && !hasVisible) {
    console.warn(`[ingress/openai-chat] upstream finish_reason='${choice.finish_reason}' with no visible output — failing the turn (non-stream)`);
    return null;
  }
  if (!hasVisible) console.warn(`[ingress/openai-chat] finish_reason='${choice.finish_reason}' 收尾但零可见输出（thinking-only，非流式）—— CLI 会补一轮催促`);
  const stop_reason = hasTools ? 'tool_use' : (STOP_MAP[choice.finish_reason] || 'end_turn');
  return {
    id: json?.id || `msg_${Date.now()}`,
    type: 'message', role: 'assistant',
    model: json?.model || '',
    content, stop_reason, stop_sequence: null,
    usage: usageFromOpenAI(json?.usage),
  };
}

/** 上游错误体 → Anthropic 错误体（CLI 会把 message 原样显示） */
export function toAnthropicError(status, bodyText) {
  let message = bodyText;
  try { const j = JSON.parse(bodyText); message = j?.error?.message || j?.message || bodyText; } catch { /* 非 JSON */ }
  const type = status === 401 || status === 403 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error'
      : status >= 500 ? 'api_error' : 'invalid_request_error';
  return { type: 'error', error: { type, message: String(message).slice(0, 2000) } };
}

/**
 * 流式：OpenAI SSE chunk → Anthropic SSE 事件。Transform，直接 pipe。
 * 状态机：当前打开的块（thinking/text/tool_use 之一）+ tool_calls 按 index 映射到块号。
 */
export class OpenAIToAnthropicSSE extends Transform {
  constructor({ model = '' } = {}) {
    super();
    this.model = model;
    this.buf = '';
    this.started = false;
    this.done = false;
    this.blockIndex = -1;      // 最后分配的块号
    this.open = null;          // { kind: 'thinking'|'text'|'tool', index }
    this.toolBlocks = new Map();   // openai tool_call index → block index
    this.finish = null;
    this.usage = null;
    this.id = null;
    this.sawToolCall = false;
    this.sawText = false;      // 有过可见正文（区分"只想没说"的早断流）
  }
  _emit(event, data) { this.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  _ensureStart(chunk) {
    if (this.started) return;
    this.started = true;
    this.id = chunk?.id || `msg_${Date.now()}`;
    if (chunk?.model) this.model = chunk.model;
    this._emit('message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  _closeOpen() {
    if (!this.open) return;
    this._emit('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
  }
  _openBlock(kind, block) {
    this._closeOpen();
    this.blockIndex += 1;
    this.open = { kind, index: this.blockIndex };
    this._emit('content_block_start', { type: 'content_block_start', index: this.blockIndex, content_block: block });
    return this.blockIndex;
  }
  _handleChunk(chunk) {
    this._ensureStart(chunk);
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (d.reasoning_content) {
      if (this.open?.kind !== 'thinking') this._openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
      this._emit('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'thinking_delta', thinking: String(d.reasoning_content) } });
    }
    // content 与 refusal 都是"可见正文"，进同一个 text 块（拒答也是模型说的话，原样吐给用户）
    for (const piece of [d.content, d.refusal]) {
      if (!piece) continue;
      this.sawText = true;
      if (this.open?.kind !== 'text') this._openBlock('text', { type: 'text', text: '' });
      this._emit('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'text_delta', text: String(piece) } });
    }
    for (const tc of d.tool_calls || []) {
      // 按 index 分块；上游不带 index 时：带 id 的是新调用，否则续上一个
      const key = tc.index ?? (tc.id ? `id:${tc.id}` : this.lastToolKey);
      this.lastToolKey = key;
      this.sawToolCall = true;
      if (!this.toolBlocks.has(key)) {
        const idx = this._openBlock('tool', { type: 'tool_use', id: tc.id || `call_${key}`, name: tc.function?.name || '', input: {} });
        this.toolBlocks.set(key, idx);
      } else if (this.open?.kind !== 'tool' || this.open.index !== this.toolBlocks.get(key)) {
        // 上游交错回到旧的 tool_call（少见）：Anthropic 块一旦 stop 不能再开，只能并进当前块号
        this._closeOpen();
        this.open = { kind: 'tool', index: this.toolBlocks.get(key) };
      }
      const args = tc.function?.arguments;
      if (args) this._emit('content_block_delta', { type: 'content_block_delta', index: this.toolBlocks.get(key), delta: { type: 'input_json_delta', partial_json: String(args) } });
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
  }
  _finish() {
    if (this.done) return;
    this.done = true;
    // 一个 chunk 都没来（200 但非 SSE 体 / 首字节前断连）或一个块都没开且没有收尾原因：
    // 别包装成"成功的空消息"让 CLI 当正常结束 —— 发 error 事件（fable 评审 P2）
    if (!this.started || (this.blockIndex < 0 && !this.finish)) {
      this._ensureStart(null);
      this._emit('error', { type: 'error', error: { type: 'api_error', message: 'ingress: upstream returned an empty response' } });
      return;
    }
    // 没给 finish_reason 就断了、而且一个字/一个工具调用都没出（只有 thinking）：
    // 这是上游早断流（Zen 08-21 真发生过），包装成 end_turn 会让 CLI 进"你上一轮没有
    // 可见输出"的催促循环。发 error 让这一轮明确失败。有正文但没 finish_reason 的
    // 算截断，仍按 end_turn 收尾只记 warn（重跑整轮的代价比半截答案更贵）
    if (!this.finish && !this.sawText && !this.sawToolCall) {
      console.warn('[ingress/openai-chat] upstream stream ended without finish_reason and without visible output (thinking-only)');
      this._closeOpen();
      this._emit('error', { type: 'error', error: { type: 'api_error', message: 'ingress: upstream stream ended before any visible output' } });
      return;
    }
    // 给了 finish_reason，但那是上游私货（network_error 之类）而且一个可见块都没出：
    // 同样发 error 让这一轮明确失败，CLI 0.2 秒后自己重发（假上游实测）。有可见输出的
    // 私货 finish 只记 warn 按 end_turn 收尾 —— 半截答案也是答案，重跑整轮更贵
    if (isAlienFinish(this.finish) && !this.sawText && !this.sawToolCall) {
      console.warn(`[ingress/openai-chat] upstream finish_reason='${this.finish}' with no visible output — failing the turn so the CLI retries`);
      this._closeOpen();
      this._emit('error', { type: 'error', error: { type: 'api_error', message: `ingress: upstream ended with finish_reason='${this.finish}' and no visible output` } });
      return;
    }
    if (isAlienFinish(this.finish)) console.warn(`[ingress/openai-chat] 未知 finish_reason='${this.finish}'（有可见输出）；按 end_turn 收尾`);
    // 已知 finish 但零可见块（thinking-only）：行为不变，先只计数。CLI 会补一轮催促，
    // 跑一周日志看这种情况多不多，再决定要不要一并 fail-loud（08-21 议定）
    else if (this.finish && !this.sawText && !this.sawToolCall) console.warn(`[ingress/openai-chat] finish_reason='${this.finish}' 收尾但零可见输出（thinking-only）—— CLI 会补一轮催促`);
    if (!this.finish) console.warn('[ingress/openai-chat] upstream stream ended without finish_reason (truncated); closing as end_turn');
    this._closeOpen();
    const stop_reason = this.sawToolCall ? 'tool_use' : (STOP_MAP[this.finish] || 'end_turn');
    this._emit('message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: usageFromOpenAI(this.usage) });
    this._emit('message_stop', { type: 'message_stop' });
  }
  _transform(chunk, _enc, cb) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { this._finish(); continue; }
      if (this.done) continue;          // Zen 在 [DONE] 后还补一条 {"choices":[],"cost":"0"}，忽略
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j?.error) {   // 流中途的错误体：转成 Anthropic error 事件
        this._ensureStart(j);
        this._emit('error', { type: 'error', error: { type: 'api_error', message: String(j.error.message || j.error) } });
        continue;
      }
      try { this._handleChunk(j); } catch (err) { console.warn('[ingress/openai-chat] chunk handling failed:', err.message); }
    }
    cb();
  }
  _flush(cb) { this._finish(); cb(); }
}
