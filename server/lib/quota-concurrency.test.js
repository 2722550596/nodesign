/**
 * 并发闸纯决策（2026-08-21）：免费行不吃全局固定数、内存闸两档都吃、每用户 1 个。
 */
import { describe, it, expect } from 'vitest';
import { decideConcurrency } from './quota.js';

const env = { NODESIGN_MAX_CONCURRENT_RUNS: '3', NODESIGN_FREE_MAX_CONCURRENT_RUNS: '12', NODESIGN_USER_CONCURRENT_RUNS: '1', NODESIGN_MIN_FREE_MEM_MB: '700' };
const base = { running: 0, mine: 0, isAdmin: false, free: false, memMb: 2000, env };

describe('decideConcurrency', () => {
  it('订阅行：全局 3 个满了就拒', () => {
    expect(decideConcurrency({ ...base, running: 3 }).code).toBe('BUSY');
    expect(decideConcurrency({ ...base, running: 2 }).ok).toBe(true);
  });
  it('免费行：全局 3 个满了照放，到免费上限 12 才拒', () => {
    expect(decideConcurrency({ ...base, free: true, running: 3 }).ok).toBe(true);
    expect(decideConcurrency({ ...base, free: true, running: 11 }).ok).toBe(true);
    expect(decideConcurrency({ ...base, free: true, running: 12 }).code).toBe('BUSY');
  });
  it('内存闸：MemAvailable 低于门槛两档都拒；读不到内存（null）不以内存拒', () => {
    expect(decideConcurrency({ ...base, free: true, memMb: 699 }).message).toMatch(/内存/);
    expect(decideConcurrency({ ...base, free: false, memMb: 699 }).message).toMatch(/内存/);
    expect(decideConcurrency({ ...base, free: true, memMb: null }).ok).toBe(true);
  });
  it('每用户 1 个：非 admin 自己有在跑就拒（免费行也一样）；admin 免', () => {
    expect(decideConcurrency({ ...base, free: true, mine: 1 }).message).toMatch(/你有任务正在跑/);
    expect(decideConcurrency({ ...base, free: true, mine: 1, isAdmin: true }).ok).toBe(true);
  });
  it('env 缺省值：3 / 12 / 1 / 700', () => {
    const e = {};
    expect(decideConcurrency({ ...base, env: e, running: 3 }).ok).toBe(false);
    expect(decideConcurrency({ ...base, env: e, free: true, running: 11 }).ok).toBe(true);
    expect(decideConcurrency({ ...base, env: e, memMb: 699 }).ok).toBe(false);
  });
});
