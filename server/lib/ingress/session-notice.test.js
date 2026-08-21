import { describe, it, expect } from 'vitest';
import { SessionNotices } from './session-notice.js';

const mk = (nowRef) => new SessionNotices({ minIntervalMs: 1000, now: () => nowRef.t });

describe('SessionNotices —— ingress 往会话推一句人话', () => {
  it('注册了才推得到；没注册的会话静默丢弃', () => {
    const nowRef = { t: 0 };
    const n = mk(nowRef);
    const got = [];
    expect(n.notice('sid1', { text: '在重试' })).toBe(false);   // 还没注册
    n.register('sid1', (p) => got.push(p.text));
    expect(n.notice('sid1', { text: '在重试' })).toBe(true);
    expect(got).toEqual(['在重试']);
  });

  it('节流：窗口内第二条不推，过了窗口又能推', () => {
    const nowRef = { t: 0 };
    const n = mk(nowRef);
    const got = [];
    n.register('s', (p) => got.push(p.text));
    expect(n.notice('s', { text: '一' })).toBe(true);
    nowRef.t = 999;
    expect(n.notice('s', { text: '二' })).toBe(false);
    nowRef.t = 1000;
    expect(n.notice('s', { text: '三' })).toBe(true);
    expect(got).toEqual(['一', '三']);
  });

  it('throttle:false 强制推（给必须让用户看见的那种）', () => {
    const nowRef = { t: 0 };
    const n = mk(nowRef);
    const got = [];
    n.register('s', (p) => got.push(p.text));
    n.notice('s', { text: '一' });
    expect(n.notice('s', { text: '二' }, { throttle: false })).toBe(true);
    expect(got).toEqual(['一', '二']);
  });

  it('节流按会话分桶，别让一个会话堵住另一个', () => {
    const nowRef = { t: 0 };
    const n = mk(nowRef);
    const got = [];
    n.register('a', () => got.push('a'));
    n.register('b', () => got.push('b'));
    n.notice('a', { text: 'x' });
    expect(n.notice('b', { text: 'x' })).toBe(true);
    expect(got).toEqual(['a', 'b']);
  });

  it('注销后不再推，且节流状态一起清（重开会话立刻能收到第一条）', () => {
    const nowRef = { t: 0 };
    const n = mk(nowRef);
    const got = [];
    n.register('s', () => got.push(1));
    n.notice('s', { text: 'x' });
    n.unregister('s');
    expect(n.notice('s', { text: 'y' })).toBe(false);
    n.register('s', () => got.push(2));
    expect(n.notice('s', { text: 'z' })).toBe(true);   // 节流没跟着旧会话留下来
    expect(got).toEqual([1, 2]);
  });

  it('⛔ 注销带身份比对：旧会话的 finally 迟到几秒，不能把同 sid 新会话的通道删掉', () => {
    const n = mk({ t: 0 });
    const oldFn = () => {}; const newFn = () => {};
    n.register('s', oldFn);
    n.register('s', newFn);           // 新会话接管
    n.unregister('s', oldFn);         // 旧会话的 finally 迟到
    expect(n.handlers.get('s')).toBe(newFn);
    n.unregister('s', newFn);
    expect(n.handlers.has('s')).toBe(false);
  });

  it('不带 expected 时照旧无条件删（老调用点不变）', () => {
    const n = mk({ t: 0 });
    n.register('s', () => {});
    n.unregister('s');
    expect(n.handlers.has('s')).toBe(false);
  });

  it('handler 抛错不冒泡（通知不该弄死会话）', () => {
    const n = mk({ t: 0 });
    n.register('s', () => { throw new Error('boom'); });
    expect(() => n.notice('s', { text: 'x' })).not.toThrow();
    expect(n.notice('s', { text: 'x' }, { throttle: false })).toBe(false);
  });

  it('空文本不推', () => {
    const n = mk({ t: 0 });
    let hit = 0;
    n.register('s', () => { hit += 1; });
    expect(n.notice('s', { text: '' })).toBe(false);
    expect(hit).toBe(0);
  });
});
