import { describe, it, expect } from 'vitest';
import { sanitizeBoard, sanitizeTag } from './board-sanitize.js';

/** 黑板字段（2026-08-23）：tag / staging / text.format / binding.material 的收与拒 */
describe('board-sanitize 黑板字段', () => {
  it('tag 只收安全字符（进 DOM 属性与 URL），长度 ≤ 40', () => {
    expect(sanitizeTag('sketch-1')).toBe('sketch-1');
    expect(sanitizeTag('头脑风暴_第一轮')).toBe('头脑风暴_第一轮');
    expect(sanitizeTag('a b')).toBeNull();
    expect(sanitizeTag('<x>')).toBeNull();
    expect(sanitizeTag('x'.repeat(41))).toBeNull();
    expect(sanitizeTag(7)).toBeNull();
  });

  it('物件：tag/staging 合法才落字段；plain 不落 format，md 落', () => {
    const b = sanitizeBoard({
      objects: {
        'text:a': { x: 1, y: 2, kind: 'text', data: { t: 'hi', format: 'md' }, tag: 'g1', staging: true },
        'text:b': { x: 1, y: 2, kind: 'text', data: { t: 'yo', format: 'plain' }, tag: 'bad tag', staging: 'yes' },
        'deck:x': { x: 0, y: 0, tag: 'g1' },
      },
    });
    expect(b.objects['text:a']).toMatchObject({ tag: 'g1', staging: true, data: { t: 'hi', format: 'md' } });
    expect(b.objects['text:b'].tag).toBeUndefined();
    expect(b.objects['text:b'].staging).toBeUndefined();
    expect(b.objects['text:b'].data.format).toBeUndefined();
    expect(b.objects['deck:x'].tag).toBe('g1');
  });

  it('md 档字数上限比 plain 宽', () => {
    const long = 'x'.repeat(3000);
    const b = sanitizeBoard({ objects: {
      'text:p': { x: 0, y: 0, kind: 'text', data: { t: long } },
      'text:m': { x: 0, y: 0, kind: 'text', data: { t: long, format: 'md' } },
    } });
    expect(b.objects['text:p'].data.t.length).toBe(2000);
    expect(b.objects['text:m'].data.t.length).toBe(3000);
  });

  it('线：material 只收词汇表里的、ink 不落字段；tag/staging 同物件', () => {
    const b = sanitizeBoard({ bindings: {
      b1: { type: 'link', from: 'a', to: 'b', material: 'yarn', tag: 'g1', staging: true },
      b2: { type: 'link', from: 'a', to: 'c', material: 'ink' },
      b3: { type: 'link', from: 'a', to: 'd', material: 'lava' },
    } });
    expect(b.bindings.b1).toMatchObject({ material: 'yarn', tag: 'g1', staging: true });
    expect(b.bindings.b2.material).toBeUndefined();
    expect(b.bindings.b3.material).toBeUndefined();
  });
});
