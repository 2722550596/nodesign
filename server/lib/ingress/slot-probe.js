/**
 * lib/ingress/slot-probe.js — 模型插槽体检（08-22，探针脚本转正）。
 *
 * 配置页「体检」按钮打的就是它：对一行 API 模型，**穿过进程内入口**（model-ingress → 转换层 → 上游）
 * 发五发最小请求，回一张红绿表。为什么必须穿入口而不是直打上游：quirk 表按上游写（gproxy 的
 * network_error、refusal 映射、空体 5xx），用户自带的新端点踩的坑和内置行不一样，直打上游测不出转换层
 * 那一段；而真会话里 CLI 发的就是经过入口的请求（body.model 是剥了 [1m] 的 sdkAlias）。
 *
 * 五项：text（非流式）/ stream（SSE）/ tool_use（工具调用 + 入参能解析）/ vision（64×64 纯红图问颜色）/
 * count_tokens。vision 与 count_tokens 标 info：上游不支持不算这行不能当主力，但用户该知道。
 *
 * 订阅行不经入口（CLI 自己的登录态），这里不探，回一条说明。
 */

import sharp from 'sharp';
import { getOrStartIngress } from '../model-ingress.js';
import { registerIngressSession, unregisterIngressSession } from './session-routes.js';
import { resolveModelRoute } from '../../engine/agent/model-context.js';

const PEEK_TOOL = {
  name: 'peek',
  description: 'Return the secret number. Call it with a one-sentence reason.',
  input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
};

async function redPng() {
  return (await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toBuffer()).toString('base64');
}

function parseSse(text) {
  const events = [];
  for (const chunk of text.split(/\n\n+/)) {
    const line = chunk.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* 非 JSON 行（ping 等）跳过 */ }
  }
  return events;
}

const textOf = (json) => (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

/**
 * @param {string} appModel
 * @param {{ timeoutMs?: number, vision?: boolean }} [opts]
 * @returns {Promise<{ appModel: string, mode: 'api'|'subscription', checks: Array<{ id, label, ok: boolean|null, level: 'core'|'info', ms: number, note: string }> }>}
 */
export async function probeModel(appModel, { timeoutMs = 45_000, vision = true } = {}) {
  const route = resolveModelRoute(appModel);
  if (route.mode !== 'api') {
    return { appModel, mode: 'subscription', checks: [{ id: 'subscription', label: '订阅/直连行', ok: null, level: 'info', ms: 0,
      note: '这一行由 Claude Code 自己的登录态或 ANTHROPIC_API_KEY 驱动，不经入口，这里不探；开个项目发一句话就能验' }] };
  }
  const ingress = await getOrStartIngress();
  const tag = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  registerIngressSession(tag, appModel);
  const model = route.sdkAlias.replace(/\[1m\]$/i, '');   // CLI 序列化时剥 [1m]，体检照它发
  const base = `${ingress.baseUrl}/__nd/${encodeURIComponent(tag)}`;
  const checks = [];

  async function post(path, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(base + path, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': 'nd-ingress-managed', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, ...body }),
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* SSE 或非 JSON */ }
      return { status: res.status, text, json, ms: Date.now() - t0 };
    } catch (err) {
      return { status: 0, text: '', json: null, ms: Date.now() - t0, error: err.name === 'AbortError' ? `超时 ${timeoutMs / 1000}s` : err.message };
    } finally { clearTimeout(timer); }
  }
  const errNote = (r) => r.error || `HTTP ${r.status}${r.text ? `：${r.text.slice(0, 160)}` : ''}`;

  try {
    // 1 text
    {
      const r = await post('/v1/messages', { max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly the word pong and nothing else.' }] });
      const ok = r.status === 200 && !!textOf(r.json);
      checks.push({ id: 'text', label: '非流式文本', ok, level: 'core', ms: r.ms,
        note: ok ? `答「${textOf(r.json).slice(0, 40)}」 stop=${r.json.stop_reason} in/out=${r.json.usage?.input_tokens ?? '?'}/${r.json.usage?.output_tokens ?? '?'}` : errNote(r) });
    }
    // 2 stream
    {
      const r = await post('/v1/messages', { max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Reply with exactly the word pong and nothing else.' }] });
      const ev = r.status === 200 ? parseSse(r.text) : [];
      const types = new Set(ev.map((e) => e.type));
      const delta = ev.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
      const ok = r.status === 200 && types.has('message_start') && types.has('message_stop') && !!delta.trim();
      const errEv = ev.find((e) => e.type === 'error');
      checks.push({ id: 'stream', label: '流式（SSE）', ok, level: 'core', ms: r.ms,
        note: ok ? `${ev.length} 个事件，文本「${delta.trim().slice(0, 40)}」` : (r.status === 200 ? `事件类型 ${[...types].join(',') || '(空)'}${errEv ? ` error=${JSON.stringify(errEv.error || errEv).slice(0, 120)}` : ''}` : errNote(r)) });
    }
    // 3 tool_use
    {
      const r = await post('/v1/messages', { max_tokens: 200, tools: [PEEK_TOOL], tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: 'Call the peek tool now with a short reason. Do not answer in text.' }] });
      const tu = (r.json?.content || []).find((b) => b.type === 'tool_use');
      const ok = r.status === 200 && !!tu && tu.name === 'peek' && tu.input && typeof tu.input === 'object';
      checks.push({ id: 'tool_use', label: '工具调用', ok, level: 'core', ms: r.ms,
        note: ok ? `stop=${r.json.stop_reason} input=${JSON.stringify(tu.input).slice(0, 80)}` : (r.status === 200 ? `没发起 tool_use（stop=${r.json?.stop_reason}，内容=${textOf(r.json).slice(0, 80) || JSON.stringify(r.json?.content || []).slice(0, 80)}）` : errNote(r)) });
    }
    // 4 vision
    if (vision) {
      const png = await redPng();
      const r = await post('/v1/messages', { max_tokens: 32, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'text', text: 'What color is this image? Answer with one English word.' },
      ] }] });
      const ans = textOf(r.json);
      const ok = r.status === 200 && /red/i.test(ans);
      checks.push({ id: 'vision', label: '看图', ok, level: 'info', ms: r.ms,
        note: r.status === 200 ? `纯红图答「${ans.slice(0, 40)}」${ok ? '' : '（没认出 red：这行看不了图，截图自检会瞎）'}` : errNote(r) });
    }
    // 5 count_tokens
    {
      const r = await post('/v1/messages/count_tokens', { messages: [{ role: 'user', content: 'hello there' }] });
      const ok = r.status === 200 && Number.isFinite(r.json?.input_tokens);
      checks.push({ id: 'count_tokens', label: 'count_tokens', ok, level: 'info', ms: r.ms,
        note: ok ? `input_tokens=${r.json.input_tokens}（上游没有该端点时入口本地估算，数会偏）` : errNote(r) });
    }
  } finally {
    unregisterIngressSession(tag);
  }
  return { appModel, mode: 'api', upstream: route.upstreamId, wireModel: route.upstream && undefined, checks };
}
