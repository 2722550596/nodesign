/**
 * model-ingress 修补流水线测试（纯函数半；带 HTTP server 的转发半在
 * server/lib/_ingress-check.mjs 真跑校验 —— 对照组是 08-19 探针里已知
 * 会丢图的中转站 Gemini 桥）。
 */

import { describe, it, expect } from 'vitest';
import { transformForUpstream, liftImagesFromToolResult, estimateInputTokens } from './model-ingress.js';
import { resolveWireModel } from '../engine/agent/model-context.js';

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
