import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { makeCardsExportHandler } from './cards.js';

/**
 * 并发闸的失败模式很毒：抛错时不减计数 = 闸门永久卡死，两次失败之后这个功能
 * 就再也用不了，而且**重启前查不出原因**（没有报错，只有 429）。所以钉住它。
 */

let ws;
const guard = () => ({ id: 'p1', name: '测试项目' });
const rootOf = () => ws;

function fakeRes() {
  const r = { headers: {}, code: 200, body: null, ended: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = (b) => { r.ended = b; return r; };
  return r;
}
const run = (body) => new Promise((resolve) => {
  const res = fakeRes();
  makeCardsExportHandler({ guard, rootOf })({ body, params: {} }, res, (e) => { res.err = e; resolve(res); })
    .then(() => resolve(res));
});

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-route-'));
  await fs.mkdir(path.join(ws, 'assets/generated'), { recursive: true });
  await fs.writeFile(path.join(ws, 'assets/generated/图.png'), 'PNG');
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

describe('按卡导出路由', () => {
  it('入参校验：空 cardIds / 未知格式 / 超量', async () => {
    expect((await run({ cardIds: [], format: 'zip' })).code).toBe(400);
    expect((await run({ cardIds: ['a'], format: '没这种' })).code).toBe(400);
    expect((await run({ cardIds: Array(201).fill('a'), format: 'zip' })).code).toBe(400);
  });

  it('一张都收不到时 404，且把 skipped 的具体原因带回去', async () => {
    const res = await run({ cardIds: ['deck:不存在.html'], format: 'zip' });
    expect(res.code).toBe(404);
    expect(res.body.skipped[0].reason).toMatch(/不存在/);
  });

  it('正常导出出 zip，头齐全', async () => {
    const res = await run({ cardIds: ['assets/generated/图.png'], format: 'raw' });
    expect(res.code).toBe(200);
    expect(res.ended.toString()).toBe('PNG');
    expect(res.headers['content-disposition']).toContain('filename*=UTF-8');
    expect(Number(res.headers['content-length'])).toBe(3);
  });

  it('⭐失败之后闸门必须放开（漏 finally 的话这条会红）', async () => {
    for (let i = 0; i < 5; i++) await run({ cardIds: ['deck:不存在.html'], format: 'zip' });
    // 连着五次失败之后仍然能正常导出 —— 计数没有泄漏
    const res = await run({ cardIds: ['assets/generated/图.png'], format: 'raw' });
    expect(res.code).toBe(200);
  });

  it('同项目并发第二发被 429 挡下，且带 Retry-After', async () => {
    const a = run({ cardIds: ['assets/generated/图.png'], format: 'raw' });
    const b = await run({ cardIds: ['assets/generated/图.png'], format: 'raw' });
    expect(b.code).toBe(429);
    expect(b.headers['retry-after']).toBe('10');
    await a;
    // 前一发跑完之后闸门放开
    expect((await run({ cardIds: ['assets/generated/图.png'], format: 'raw' })).code).toBe(200);
  });
});
