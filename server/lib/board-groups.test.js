import { describe, it, expect } from 'vitest';
import { groupObjects, asciiMinimap } from './board-groups.js';

describe('board-groups', () => {
  it('连通分量成组，tag 把没连线的也并进来，自动取材边不成组', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const bindings = {
      b1: { type: 'link', from: 'a', to: 'b' },
      b2: { type: 'flow', from: 'b', to: 'c' },
      b3: { type: 'ref', from: 'e', to: 'f', by: 'auto' },
    };
    const tags = { d: 'g1', a: 'g1' };
    const groups = groupObjects(ids, bindings, id => tags[id] || null);
    expect(groups[0].members.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...groups[0].tags]).toEqual(['g1']);
    expect(groups[0].edges.sort()).toEqual(['b1', 'b2']);
    expect(groups.length).toBe(3);   // {a,b,c,d} {e} {f}
  });
  it('小地图：字母盖格子，图例对得上，视口画框', () => {
    const m = asciiMinimap([
      { id: 'x', x: 0, y: 0, w: 100, h: 100 },
      { id: 'y', x: 900, y: 300, w: 100, h: 100 },
    ], { cols: 20, rows: 8, viewport: { x: 0, y: 0, w: 500, h: 200 } });
    expect(m.legend).toEqual([['a', 'x'], ['b', 'y']]);
    expect(m.grid).toContain('a');
    expect(m.grid).toContain('b');
    expect(m.grid).toContain('┐');
    expect(m.grid.split('\n')[0].length).toBeLessThanOrEqual(20);
  });
});
