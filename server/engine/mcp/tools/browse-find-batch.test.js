/**
 * browser_batch 的合同：串行、遇错即停、halt 文案逐字、结尾补截图、名字/入参把关。
 * 用假工具定义跑（handler 是 spy），不起浏览器。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { makeBrowserBatchTool, HALT_TEXT, BATCHABLE } from './browse-find-batch.js';
import { formatMatches, staleRefText } from '../../browse/refs.js';

const fake = (name, shape, impl) => ({ name, description: name, inputSchema: shape, handler: impl });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function rig() {
  const log = [];
  const tools = [
    fake('browser_computer', { action: z.string(), text: z.string().optional() },
      async (a) => { log.push(`computer:${a.action}`); return a.action === 'boom' ? text('Error: boom', true) : text(`did ${a.action}`); }),
    fake('browser_find', { query: z.string().min(1) }, async (a) => { log.push(`find:${a.query}`); return text('found ref_1'); }),
    fake('browser_screenshot', {}, async () => { log.push('shot'); return { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'x', mimeType: 'image/webp' }] }; }),
    fake('browser_request_help', { reason: z.string() }, async () => { log.push('help'); return text('helped'); }),   // 不在 BATCHABLE 里
  ];
  return { log, batch: makeBrowserBatchTool({ tools }) };
}

describe('browser_batch', () => {
  it('合同常量：halt 文案逐字；capture 可 batch（逐页采 token）、request_help 不可（阻塞等人）', () => {
    expect(HALT_TEXT).toBe('Not executed: an earlier action in this turn failed.');
    expect(BATCHABLE).toContain('browser_capture');
    expect(BATCHABLE).not.toContain('browser_request_help');
    expect(BATCHABLE).not.toContain('browser_batch');
  });

  it('串行按序跑，结尾补一张截图', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_find', input: { query: 'search' } },
      { name: 'browser_computer', input: { action: 'left_click' } },
      { name: 'browser_computer', input: { action: 'type', text: 'hi' } },
    ] }, {});
    expect(log).toEqual(['find:search', 'computer:left_click', 'computer:type', 'shot']);
    expect(r.isError).toBeUndefined();
    const texts = r.content.filter(b => b.type === 'text').map(b => b.text);
    expect(texts[0]).toBe('[1/3] browser_find: found ref_1');
    expect(texts[1]).toBe('[2/3] browser_computer left_click: did left_click');
    expect(texts.at(-2)).toMatch(/^\[after\] current state/);
    expect(r.content.filter(b => b.type === 'image')).toHaveLength(1);
  });

  it('遇错即停：失败项报错，后面的全部 halt 文案，整体 isError，仍补截图供重规划', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_computer', input: { action: 'left_click' } },
      { name: 'browser_computer', input: { action: 'boom' } },
      { name: 'browser_computer', input: { action: 'type', text: 'never' } },
      { name: 'browser_find', input: { query: 'never' } },
    ] }, {});
    expect(log).toEqual(['computer:left_click', 'computer:boom', 'shot']);
    expect(r.isError).toBe(true);
    const texts = r.content.filter(b => b.type === 'text').map(b => b.text);
    expect(texts[1]).toBe('[2/4] browser_computer boom: Error: boom');
    expect(texts[2]).toBe(`[3/4] browser_computer type: ${HALT_TEXT}`);
    expect(texts[3]).toBe(`[4/4] browser_find: ${HALT_TEXT}`);
    expect(texts[4]).toMatch(/stopped early/);
  });

  it('最后一项已出图就不再补；screenshotAfter:false 也不补', async () => {
    const a = rig();
    await a.batch.handler({ actions: [{ name: 'browser_screenshot', input: {} }] }, {});
    expect(a.log).toEqual(['shot']);
    const b = rig();
    await b.batch.handler({ actions: [{ name: 'browser_find', input: { query: 'x' } }], screenshotAfter: false }, {});
    expect(b.log).toEqual(['find:x']);
  });

  it('不可 batch 的名字 / 不合 schema 的入参 → 当条报错并停', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_request_help', input: { reason: 'x' } },
      { name: 'browser_find', input: { query: 'x' } },
    ] }, {});
    expect(log).toEqual(['shot']);
    expect(r.content[0].text).toMatch(/not batchable/);
    expect(r.content[1].text).toBe(`[2/2] browser_find: ${HALT_TEXT}`);

    const s = rig();
    const r2 = await s.batch.handler({ actions: [{ name: 'browser_find', input: { query: '' } }] }, {});
    expect(s.log).toEqual(['shot']);
    expect(r2.content[0].text).toMatch(/invalid input — query/);
  });
});

describe('refs 文本', () => {
  it('stale 错误是可执行的一句话', () => {
    expect(staleRefText('ref_3')).toMatch(/ref_3 is stale.*browser_find again/);
  });
  it('formatMatches：空结果给下一步，非空带 ref/角色/坐标', () => {
    expect(formatMatches({ matches: [], candidates: 12 }, 'buy').join('\n')).toMatch(/没找到.*12 个/);
    const lines = formatMatches({ candidates: 3, matches: [
      { ref: 'ref_1', role: 'button', name: '接受全部', x: 640, y: 700, w: 120, h: 40, inView: true, href: '' },
      { ref: 'ref_2', role: 'link', name: 'Pricing', x: 300, y: 1200, w: 60, h: 20, inView: false, href: 'https://x.test/pricing' },
    ] }, '接受');
    expect(lines[1]).toContain('ref_1  button  「接受全部」 120×40 @(640,700)');
    expect(lines[2]).toMatch(/ref_2  link.*视口外↓.*→ https:\/\/x\.test\/pricing/);
  });
});
