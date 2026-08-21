/**
 * 真跑探针：起 ingress，按 SDK 会说的 Anthropic 格式（alias 名）打 ox-alpha，验证转换层。
 *   node --env-file=.env server/lib/_zen-check.mjs [text|tool|image|stream|all]
 */
import { getOrStartIngress, registerIngressSession, stopIngress } from './model-ingress.js';
import { resolveModelRoute } from '../engine/agent/model-context.js';

const which = process.argv[2] || 'all';
const route = resolveModelRoute('ox-alpha');
const { baseUrl } = await getOrStartIngress();
registerIngressSession('zenprobe-session', 'ox-alpha');
const url = `${baseUrl}/__nd/zenprobe-session/v1/messages`;
const MODEL = route.sdkAlias;
const TXT = (s) => [{ type: 'text', text: s }];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP4z8CAFTEMSQkGBqIkABzhNbvHCQN6AAAAAElFTkSuQmCC';
const T = [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
async function post(body, { stream = false } = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, dt: Date.now() - t0 };
}
function show(name, r) { console.log(`\n### ${name} → ${r.status} (${r.dt}ms)\n${r.text.slice(0, 700)}`); }
if (which === 'all' || which === 'text') show('text', await post({ model: MODEL, max_tokens: 300, system: [{ type: 'text', text: 'Answer tersely.' }], messages: [{ role: 'user', content: TXT('用三个词打个招呼') }], thinking: { type: 'adaptive' } }));
if (which === 'all' || which === 'tool') show('tool round trip', await post({ model: MODEL, max_tokens: 600, tools: T, messages: [{ role: 'user', content: TXT('Weather in Tokyo? Use the tool.') }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '22C sunny' }] }] }));
if (which === 'all' || which === 'image') show('image in tool_result', await post({ model: MODEL, max_tokens: 300, tools: [{ name: 'screenshot', description: 'shot', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: TXT('Take a screenshot; what colour? one word') }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'screenshot', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] }] }));
if (which === 'all' || which === 'stream') {
  const r = await post({ model: MODEL, max_tokens: 600, stream: true, tools: T, messages: [{ role: 'user', content: TXT('Weather in Paris? Use the tool.') }] });
  console.log(`\n### stream+tool → ${r.status} (${r.dt}ms)`);
  const evs = r.text.split('\n').filter(l => l.startsWith('event:')).map(l => l.slice(6).trim());
  console.log('events:', evs.join(' '));
  for (const l of r.text.split('\n')) if (/tool_use|stop_reason|usage/.test(l)) console.log(' ', l.slice(0, 260));
}
if (which === 'all' || which === 'count') show('count_tokens', await post({ model: MODEL, messages: [{ role: 'user', content: 'hello world' }] }).then(r => r));
await stopIngress();
