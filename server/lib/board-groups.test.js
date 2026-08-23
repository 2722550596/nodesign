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
    // tag 优先：a-b 那条线一端有 tag 一端没有 → 组间线，不把 b 粘进 #g1
    const byKey = Object.fromEntries(groups.map(g => [g.members.slice().sort().join(','), g]));
    expect(Object.keys(byKey).sort()).toEqual(['a,d', 'b,c', 'e', 'f']);
    expect([...byKey['a,d'].tags]).toEqual(['g1']);
    expect(byKey['b,c'].edges).toEqual(['b2']);
    expect(groups.cross).toEqual(['b1']);
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
