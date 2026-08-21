/**
 * tier-gate.test.js —— 工具闸包装器：档位放行/拒绝、basic 档 web_search 日上限、handler 透传。
 * 不起 SDK、不造项目：直接喂 owner 对象。
 */
import { describe, it, expect } from 'vitest';
import { tierDenialForOwner, withTierGate, chargeForImage } from './tier-gate.js';

const admin = { id: 'a', role: 'admin' };
const pro = { id: 'p', role: 'user', plan: 'pro' };
const basic = { id: 'b-' + Date.now(), role: 'user', plan: 'basic' };

describe('tierDenialForOwner', () => {
  it('imageGen：admin/pro/basic 都放行（08-21 深夜 basic 开放，按张计价）；无主拒绝（带 denied 前缀和工具名）', () => {
    expect(tierDenialForOwner(admin, 'imageGen', 'generate_image')).toBeNull();
    expect(tierDenialForOwner(pro, 'imageGen', 'generate_image')).toBeNull();
    expect(tierDenialForOwner(basic, 'imageGen', 'generate_image')).toBeNull();
    const d = tierDenialForOwner(null, 'imageGen', 'generate_image');
    expect(d.isError).toBe(true);
    expect(d.content[0].text).toMatch(/^generate_image denied: /);
  });
  it('webSearch：三档都放行；basic 到日上限后拒绝；pro 不计数', () => {
    const saved = process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY;
    process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY = '2';
    try {
      expect(tierDenialForOwner(admin, 'webSearch', 'web_search')).toBeNull();
      for (let i = 0; i < 5; i++) expect(tierDenialForOwner(pro, 'webSearch', 'web_search')).toBeNull();
      expect(tierDenialForOwner(basic, 'webSearch', 'web_search')).toBeNull();
      expect(tierDenialForOwner(basic, 'webSearch', 'web_search')).toBeNull();
      const d = tierDenialForOwner(basic, 'webSearch', 'web_search');
      expect(d.isError).toBe(true);
      expect(d.content[0].text).toMatch(/每天最多 2 次/);
      expect(tierDenialForOwner(null, 'webSearch', 'web_search')?.isError).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY; else process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY = saved;
    }
  });
});

describe('withTierGate', () => {
  it('其余字段原样透传；projectId 不存在 → owner 为空 → 拒绝，不碰原 handler', async () => {
    let called = 0;
    const def = { name: 'generate_image', description: 'd', inputSchema: {}, handler: async () => { called++; return { content: [] }; } };
    const wrapped = withTierGate(def, 'imageGen', 'proj_does_not_exist');
    expect(wrapped.name).toBe('generate_image');
    expect(wrapped.description).toBe('d');
    const r = await wrapped.handler({}, {});
    expect(r.isError).toBe(true);
    expect(called).toBe(0);
  });
});

describe('chargeForImage（08-21 深夜：生图按张计价，$0.20 默认，env NODESIGN_IMAGE_PRICE_USD）', () => {
  it('出了图记一笔到 ctx.addToolCharge；错误/没图不记', () => {
    const saved = process.env.NODESIGN_IMAGE_PRICE_USD; delete process.env.NODESIGN_IMAGE_PRICE_USD;
    try {
      const charges = []; const ctx = { addToolCharge: (n, v) => charges.push([n, v]) };
      expect(chargeForImage({ content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'x', mimeType: 'image/png' }] }, ctx)).toBe(0.2);
      expect(chargeForImage({ isError: true, content: [{ type: 'image', data: 'x' }] }, ctx)).toBe(0);
      expect(chargeForImage({ content: [{ type: 'text', text: 'failed' }] }, ctx)).toBe(0);
      expect(chargeForImage(null, ctx)).toBe(0);
      expect(charges).toEqual([['generate_image', 0.2]]);
      process.env.NODESIGN_IMAGE_PRICE_USD = '0.5';
      expect(chargeForImage({ content: [{ type: 'image', data: 'x' }] }, null)).toBe(0.5);   // ctx 为空也不抛
    } finally { if (saved === undefined) delete process.env.NODESIGN_IMAGE_PRICE_USD; else process.env.NODESIGN_IMAGE_PRICE_USD = saved; }
  });
});
