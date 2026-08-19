/**
 * model-ingress 修补流水线测试（纯函数半；带 HTTP server 的转发半在
 * server/lib/_ingress-check.mjs 真跑校验 —— 对照组是 08-19 探针里已知
 * 会丢图的中转站 Gemini 桥）。
 */

import { describe, it, expect } from 'vitest';
import { transformForUpstream, liftImagesFromToolResult, estimateInputTokens } from './model-ingress.js';
import { resolveWireModel, UPSTREAMS } from '../engine/agent/model-context.js';
import sharp from 'sharp';

const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };

function geminiBody(extra = {}) {
  return {
    model: 'claude-sonnet-4-6',   // SDK 序列化时剥了 [1m] 的 alias 形态
    max_tokens: 32000,
    messages: [
      { role: 'user', content: '看一眼' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'peek', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ ...IMG }] }],
      },
    ],
    ...extra,
  };
}

describe('transformForUpstream（Gemini 路：rename + strip thinking + lift）', () => {
  it('model 还原成上游真名', async () => {
    const body = geminiBody();
    await transformForUpstream(body, resolveWireModel(body.model));
    expect(body.model).toBe('中转-gemini-3.1-pro-preview');
  });

  it('thinking 字段被整个删掉（strip 档）', async () => {
    const body = geminiBody({ thinking: { type: 'enabled', budget_tokens: 8192 } });
    await transformForUpstream(body, resolveWireModel('claude-sonnet-4-6'));
    expect('thinking' in body).toBe(false);
  });

  it('⭐tool_result 里的图提升到 user message 顶层，原位留占位文本', async () => {
    const body = geminiBody();
    await transformForUpstream(body, resolveWireModel('claude-sonnet-4-6'));
    const userMsg = body.messages[2];
    const toolResult = userMsg.content[0];
    expect(toolResult.content[0].type).toBe('text');            // 原位变占位
    const last = userMsg.content[userMsg.content.length - 1];
    expect(last.type).toBe('image');                            // 图在顶层末尾
    expect(last.source.data).toBe(IMG.source.data);
  });

  it('Kimi 路：adaptive 改写成 enabled+budget（enabled8k 档），已是 enabled 的不动', async () => {
    const a = { model: 'claude-opus-4-7', thinking: { type: 'adaptive' }, messages: [] };
    await transformForUpstream(a, resolveWireModel(a.model));
    expect(a.model).toBe('kimi-k2.6');
    expect(a.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });

    const b = { model: 'claude-opus-4-7', thinking: { type: 'enabled', budget_tokens: 4096 }, messages: [] };
    await transformForUpstream(b, resolveWireModel(b.model));
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });
});

describe('liftImagesFromToolResult', () => {
  it('assistant message / 无图 tool_result / 字符串 content 都不动', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'plain text' }] },
      { role: 'user', content: 'string content' },
    ];
    const snapshot = JSON.stringify(messages);
    expect(liftImagesFromToolResult(messages)).toBe(false);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('同一条消息里多个 tool_result 各自的图都提升且保序', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ ...IMG }, { type: 'text', text: 'cap' }] },
        { type: 'tool_result', tool_use_id: 'b', content: [{ ...IMG, source: { ...IMG.source, data: 'd29ybGQ=' } }] },
      ],
    }];
    expect(liftImagesFromToolResult(messages)).toBe(true);
    const imgs = messages[0].content.filter((b) => b.type === 'image');
    expect(imgs.map((b) => b.source.data)).toEqual(['aGVsbG8=', 'd29ybGQ=']);
  });
});

describe('estimateInputTokens', () => {
  it('中英混合有量级正确的估算（不是 0 也不是天文数字）', () => {
    const n = estimateInputTokens({
      system: '你是一个设计助手。'.repeat(100),
      messages: [{ role: 'user', content: 'hello world '.repeat(200) }],
      tools: [{ name: 'peek', description: 'take a screenshot', input_schema: { type: 'object' } }],
    });
    expect(n).toBeGreaterThan(1000);
    expect(n).toBeLessThan(10000);
  });

  it('解析不了（如循环引用进 JSON.stringify）返回保守值', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(estimateInputTokens({ tools: [{ name: 'x', input_schema: cyclic }] })).toBe(50000);
  });
});

/**
 * 图片归一（2026-08-19）：生产真撞过 —— llama.cpp 走 stb_image 解不开 webp，
 * 上游返回一句看不出真因的 400。断言用**真图字节**（sharp 现造），不用假 base64：
 * 这条路的全部逻辑都在 sharp 的 metadata 上分流，喂假数据等于什么都没测。
 */
describe('图片归一：按上游声明的 imageFormats 转码', () => {
  const mk = async (fmt, w = 64, h = 64, alpha = false) => {
    const base = sharp({
      create: { width: w, height: h, channels: alpha ? 4 : 3,
        background: alpha ? { r: 200, g: 30, b: 30, alpha: 0.5 } : { r: 200, g: 30, b: 30 } },
    });
    const buf = await (fmt === 'webp' ? base.webp() : fmt === 'png' ? base.png() : base.jpeg()).toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: `image/${fmt}`, data: buf.toString('base64') } };
  };
  const msgs = (block) => [{ role: 'user', content: [block] }];
  const wireFor = (upstream) => ({ wireModel: 'qwen3.8-27b', upstream });

  it('webp → qwenLocal 会被转码（真因就在这：stb_image 不认 webp）', async () => {
    const parsed = { model: 'x', messages: msgs(await mk('webp')) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    const out = parsed.messages[0].content[0].source;
    expect(out.media_type).toBe('image/jpeg');                       // 无 alpha → jpeg
    const meta = await sharp(Buffer.from(out.data, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');                                 // 真的是 jpeg 字节，不只是改了标签
    expect(meta.width).toBe(64);                                      // 没顺手缩掉
  });

  it('带 alpha 的 webp 转 png（保住透明），小图不 resize', async () => {
    const parsed = { model: 'x', messages: msgs(await mk('webp', 64, 64, true)) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    const out = parsed.messages[0].content[0].source;
    expect(out.media_type).toBe('image/png');
    expect((await sharp(Buffer.from(out.data, 'base64')).metadata()).hasAlpha).toBe(true);
  });

  it('png / jpeg 本来就在白名单里 → 一个字节都不动', async () => {
    for (const fmt of ['png', 'jpeg']) {
      const block = await mk(fmt);
      const before = block.source.data;
      const parsed = { model: 'qwen3.8-27b', messages: msgs(block) };
      const mutated = await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
      expect(parsed.messages[0].content[0].source.data, `${fmt} 被动了`).toBe(before);
      expect(mutated).toBe(false);
    }
  });

  it('⚠️ 没声明 imageFormats 的上游（中转站）维持原样 —— webp 照旧透传', async () => {
    const block = await mk('webp');
    const before = block.source.data;
    const parsed = { model: 'x', messages: msgs(block) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.lament));
    expect(parsed.messages[0].content[0].source.media_type).toBe('image/webp');
    expect(parsed.messages[0].content[0].source.data).toBe(before);
  });

  it('tool_result 内嵌的图同样被转码（llama.cpp 那条路 liftImages 是关的，图就留在里面）', async () => {
    const parsed = { model: 'x', messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [await mk('webp')] },
    ] }] };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    expect(parsed.messages[0].content[0].content[0].source.media_type).toBe('image/jpeg');
  });

  it('gif 不进这条路（重 encode 会丢帧），原样透传', async () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGOD' } };
    const parsed = { model: 'x', messages: msgs(block) };
    await transformForUpstream(parsed, wireFor(UPSTREAMS.qwenLocal));
    expect(parsed.messages[0].content[0].source.media_type).toBe('image/gif');
  });
});
