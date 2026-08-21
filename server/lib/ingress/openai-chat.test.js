import { describe, it, expect } from 'vitest';
import { toOpenAIChatRequest, fromOpenAIChatResponse, toAnthropicError, OpenAIToAnthropicSSE } from './openai-chat.js';

const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

describe('toOpenAIChatRequest', () => {
  it('system 块 / 字符串 content / tools / tool_choice / thinking→reasoning_effort / stream_options', () => {
    const out = toOpenAIChatRequest({
      model: 'x', stream: true, max_tokens: 32000,
      system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }, { type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'any' }, thinking: { type: 'adaptive' }, metadata: { user_id: 'u' },
    }, { reasoningEffort: 'high', maxOutput: 1000 });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'A\nB' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0].function.name).toBe('f');
    expect(out.tool_choice).toBe('required');
    expect(out.reasoning_effort).toBe('high');
    expect(out.max_tokens).toBe(1000);            // 钳到上游上限
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.metadata).toBeUndefined();
  });
  it('tool_use → tool_calls；tool_result 先于同条 user 文本；tool_result 里的图提到 user 消息；thinking→reasoning_content', () => {
    const out = toOpenAIChatRequest({
      model: 'x', max_tokens: 10,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'shot?' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call_1', name: 'shot', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'done' }, img] }, { type: 'text', text: 'next' }] },
      ],
    });
    const [u1, a, t, u2] = out.messages;
    expect(u1).toEqual({ role: 'user', content: 'shot?' });
    expect(a.reasoning_content).toBe('hmm');
    expect(a.content).toBe('ok');
    expect(a.tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'shot', arguments: '{"a":1}' } });
    expect(t.role).toBe('tool'); expect(t.tool_call_id).toBe('call_1'); expect(t.content).toMatch(/^done\n\[image/);
    expect(u2.role).toBe('user');
    expect(u2.content[0]).toEqual({ type: 'text', text: 'next' });
    expect(u2.content[1].type).toBe('image_url');
    expect(u2.content[1].image_url.url).toBe('data:image/png;base64,AAAA');
  });
  it('tool_result 只有图、没别的文本时也会有一条 user 消息承载图', () => {
    const out = toOpenAIChatRequest({ model: 'x', max_tokens: 10, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'shot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [img] }] },
    ] });
    expect(out.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(out.messages[2].content[0].type).toBe('image_url');
  });
});

describe('fromOpenAIChatResponse', () => {
  it('reasoning/text/tool_calls → 块；stop_reason；usage 口径 input 不含 cache 命中', () => {
    const r = fromOpenAIChatResponse({ id: 'i', model: 'm', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'think', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get', arguments: '{"city":"Tokyo"}' } }] } }], usage: { prompt_tokens: 220, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 64 } } });
    expect(r.content[0]).toEqual({ type: 'thinking', thinking: 'think', signature: '' });
    expect(r.content[1]).toEqual({ type: 'tool_use', id: 'call_9', name: 'get', input: { city: 'Tokyo' } });
    expect(r.stop_reason).toBe('tool_use');
    expect(r.usage).toEqual({ input_tokens: 156, output_tokens: 40, cache_read_input_tokens: 64, cache_creation_input_tokens: 0 });
  });
  it('length→max_tokens；坏 JSON 参数不炸', () => {
    const r = fromOpenAIChatResponse({ choices: [{ finish_reason: 'length', message: { content: 'x', tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{bad' } }] } }] });
    expect(r.content[1].input).toEqual({ _raw_arguments: '{bad' });
    expect(r.stop_reason).toBe('tool_use');
    expect(fromOpenAIChatResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop_reason).toBe('max_tokens');
  });
  it('toAnthropicError 按状态分型、拆上游 message', () => {
    expect(toAnthropicError(429, '{"error":{"message":"slow down"}}')).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    expect(toAnthropicError(500, 'plain').error.type).toBe('api_error');
  });
});

function collect(xf, chunks) {
  return new Promise((resolve) => {
    let out = '';
    xf.on('data', (d) => { out += d.toString(); });
    xf.on('end', () => resolve(out));
    for (const c of chunks) xf.write(c);
    xf.end();
  });
}
const ev = (sse) => sse.split('\n\n').filter(Boolean).map(b => {
  const e = /^event: (.*)$/m.exec(b)[1]; const d = JSON.parse(/^data: (.*)$/m.exec(b)[1]); return { e, d };
});

describe('OpenAIToAnthropicSSE', () => {
  it('reasoning→thinking 块，text 块，tool_calls 增量→tool_use+input_json_delta，末 chunk usage → message_delta；[DONE] 后的尾巴忽略', async () => {
    const id = 'abc';
    const c = (delta, extra = {}) => `data: ${JSON.stringify({ id, model: 'ox', choices: [{ index: 0, delta, ...extra }] })}\n\n`;
    const sse = await collect(new OpenAIToAnthropicSSE({ model: 'alias' }), [
      c({ role: 'assistant', reasoning_content: 'The' }), c({ reasoning_content: ' user' }),
      c({ content: 'Sure' }),
      c({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }),
      'data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] }).slice(0, 40),   // 切半行
      JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] }).slice(40) + '\n\n',
      `data: ${JSON.stringify({ id, choices: [{ index: 0, finish_reason: 'tool_calls', delta: { content: '' } }], usage: { prompt_tokens: 234, completion_tokens: 28, prompt_tokens_details: { cached_tokens: 34 } } })}\n\n`,
      'data: [DONE]\n\n', 'data: {"choices":[],"cost":"0"}\n\n',
    ]);
    const events = ev(sse);
    expect(events.map(x => x.e)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events[0].d.message.id).toBe('abc');
    expect(events[1].d.content_block.type).toBe('thinking');
    expect(events[5].d.content_block).toEqual({ type: 'text', text: '' });
    expect(events[8].d.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} });
    expect(events[9].d.delta).toEqual({ type: 'input_json_delta', partial_json: '{"ci' });
    expect(events[10].d.delta.partial_json).toBe('ty":"Paris"}');
    expect(events[12].d.delta.stop_reason).toBe('tool_use');
    expect(events[12].d.usage).toEqual({ input_tokens: 200, output_tokens: 28, cache_read_input_tokens: 34, cache_creation_input_tokens: 0 });
  });
  it('档位只看 reasoningEffort（thinking 字段已在 ingress 被 strip）；disabled 才不发', () => {
    expect(toOpenAIChatRequest({ model: 'x', max_tokens: 10, messages: [] }, { reasoningEffort: 'high' }).reasoning_effort).toBe('high');
    expect(toOpenAIChatRequest({ model: 'x', max_tokens: 10, messages: [], thinking: { type: 'disabled' } }, { reasoningEffort: 'high' }).reasoning_effort).toBeUndefined();
    expect(fromOpenAIChatResponse({ error: { message: 'x' } })).toBeNull();
    expect(fromOpenAIChatResponse({ choices: [] })).toBeNull();
  });
  it('一个 chunk 都没来 → error 事件而不是空的 end_turn', async () => {
    const events = ev(await collect(new OpenAIToAnthropicSSE(), ['\n']));
    expect(events.map(x => x.e)).toEqual(['message_start', 'error']);
  });
  it('上游断流没给 [DONE] 也能收尾（flush）；无 tool 时 stop→end_turn', async () => {
    const events = ev(await collect(new OpenAIToAnthropicSSE(), [`data: ${JSON.stringify({ id: 'z', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\n`]));
    expect(events.at(-2).d.delta.stop_reason).toBe('end_turn');
    expect(events.at(-1).e).toBe('message_stop');
  });
});
