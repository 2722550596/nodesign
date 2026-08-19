/**
 * screenshot 诊断层与等待语义钉子（2026-08-19，agent 上报三案）：
 * - console.log 默认被滤但条数必须可见（iss_msz24e0q_vfwf：被静默吞掉，
 *   agent 以为代码没执行到，白改两轮）
 * - console:'all' 才回传 log 级，单独一桶不挤真错误
 * - waitFor 超时不挡截图，note 说清没等到
 */
import { describe, it, expect } from 'vitest';
import { attachPageDiagnostics, runWaitFor } from './helpers/shot-pipeline.js';

function fakePage() {
  const handlers = {};
  return {
    on(evt, cb) { handlers[evt] = cb; },
    emitConsole(type, text) { handlers.console?.({ type: () => type, text: () => text }); },
  };
}

describe('attachPageDiagnostics console 档位', () => {
  it("默认 'warn'：log 被滤但报条数 —— 没显示≠没发生", () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page);
    page.emitConsole('log', '[char] 可用动作: idle,run');
    page.emitConsole('log', 'boot ok');
    const s = diag.summary();
    expect(s).toContain('console clean');
    expect(s).toContain('2 log-level line(s) filtered');
    expect(s).toContain("console:'all'");
    expect(s).not.toContain('boot ok');
  });

  it("'all'：log 进自己那桶（分组计数），错误照旧在前", () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page, { console: 'all' });
    page.emitConsole('error', 'WebGL stall');
    page.emitConsole('log', 'tick 1');
    page.emitConsole('log', 'tick 1');
    const s = diag.summary();
    expect(s.indexOf('WebGL stall')).toBeLessThan(s.indexOf('tick 1'));
    expect(s).toContain('(×2 similar)');
    expect(s).not.toContain('filtered');
  });

  it('全干净且没滤任何东西 → 原样正向确认', () => {
    const diag = attachPageDiagnostics(fakePage());
    expect(diag.summary()).toBe('console clean, all requests OK');
  });
});

describe('runWaitFor', () => {
  it('条件为真 → null（caption 不加噪音）', async () => {
    expect(await runWaitFor({ waitForFunction: async () => {} }, 'window.__game')).toBeNull();
  });
  it('超时 → note 讲清没等到 + 照样截了', async () => {
    const page = { waitForFunction: async () => { throw new Error('Timeout 15000ms exceeded'); } };
    const note = await runWaitFor(page, 'window.__game');
    expect(note).toContain('not truthy within 15s');
    expect(note).toContain('captured anyway');
  });
  it('表达式抛错 → 也带回 note 而不是炸截图', async () => {
    const page = { waitForFunction: async () => { throw new Error('ReferenceError: x'); } };
    expect(await runWaitFor(page, 'x.y')).toContain('waitFor error');
  });
});
