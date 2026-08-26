// 外部 MCP server 装配（2026-08-26）
import { describe, it, expect } from 'vitest';
import { parseExternalMcpServers, externalMcpServers, externalMcpAllowRules } from './external.js';

describe('parseExternalMcpServers', () => {
  it('未设 / 空串 → 空对象（默认行为不引入任何外部 server）', () => {
    expect(parseExternalMcpServers(undefined)).toEqual({});
    expect(parseExternalMcpServers('')).toEqual({});
  });

  it('对象值原样透传，字符串 URL 归一成 sse', () => {
    const out = parseExternalMcpServers(
      '{"nocturne_memory":{"type":"sse","url":"http://127.0.0.1:8233/sse"},"simple":"http://x/sse"}',
    );
    expect(out.nocturne_memory).toEqual({ type: 'sse', url: 'http://127.0.0.1:8233/sse' });
    expect(out.simple).toEqual({ type: 'sse', url: 'http://x/sse' });
  });

  it('JSON 非法 → throw（启动炸，不静默降级）', () => {
    expect(() => parseExternalMcpServers('{oops')).toThrow(/不是合法 JSON/);
  });

  it('名字带非法字符 → throw（会进 mcp__<名> 前缀与 allow 规则，必须严格）', () => {
    expect(() => parseExternalMcpServers('{"bad name":{}}')).toThrow(/名字不合法/);
  });

  it('值不是对象 / 字符串 → throw', () => {
    expect(() => parseExternalMcpServers('{"x":42}')).toThrow(/必须是对象或 URL 字符串/);
  });
});

describe('externalMcpServers / externalMcpAllowRules（双读者同源）', () => {
  it('本次 .env 实测装配：名字进了 mcpServers 键，allow 规则同前缀', () => {
    const servers = externalMcpServers();
    const rules = externalMcpAllowRules();
    // 两个读者必须一一对应 —— 名字错位 = 工具可见但分类器拦 / 反之
    expect(rules.length).toBe(Object.keys(servers).length);
    expect(rules).toEqual(Object.keys(servers).map((n) => `mcp__${n}`));
    for (const name of Object.keys(servers)) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});