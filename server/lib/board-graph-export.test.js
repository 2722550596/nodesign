import { describe, it, expect } from 'vitest';
import { exportGraph } from './board-graph-export.js';

const board = {
  zones: {}, hero: null,
  objects: {
    'site:a': { x: 0, y: 0 },
    'text:1': { x: 700, y: 0, w: 160, h: 40, kind: 'text', data: { t: '一句话 <b>', font: 'pen', size: 'md', color: 'ink' }, tag: 'g1', staging: true },
    'scribble:1': { x: 700, y: 100, w: 50, h: 50, kind: 'scribble', data: { d: 'M 0 0 L 10 10', color: 'red', width: 2 }, tag: 'g1' },
  },
  bindings: {
    b1: { type: 'link', from: 'text:1', to: 'site:a', label: '证物', material: 'yarn', by: 'agent', tag: 'g1' },
    b2: { type: 'flow', from: 'site:a', to: 'text:1' },
  },
};

describe('board-graph-export', () => {
  it('json：节点带几何/标签/草稿位，线带材质', () => {
    const { body } = exportGraph(board, { format: 'json' });
    const g = JSON.parse(body);
    expect(g.nodes.map(n => n.id).sort()).toEqual(['scribble:1', 'site:a', 'text:1']);
    expect(g.nodes.find(n => n.id === 'text:1')).toMatchObject({ tag: 'g1', staging: true, text: '一句话 <b>' });
    expect(g.edges.find(e => e.id === 'b1').material).toBe('yarn');
    // 只导一组：产物卡不带 tag 就不在
    const only = JSON.parse(exportGraph(board, { format: 'json', tag: 'g1' }).body);
    expect(only.nodes.map(n => n.id).sort()).toEqual(['scribble:1', 'text:1']);
  });
  it('mermaid：有向/无向箭头、涂鸦不进、标签进词', () => {
    const { body } = exportGraph(board, { format: 'mermaid' });
    expect(body.startsWith('flowchart LR')).toBe(true);
    expect(body).toMatch(/--- 证物 ---/);
    expect(body).toMatch(/-- 接着 -->/);
    expect(body).not.toMatch(/涂鸦/);
  });
  it('svg：转义、丝线图钉、草稿半透明', () => {
    const { body, mime } = exportGraph(board, { format: 'svg' });
    expect(mime).toMatch(/svg/);
    expect(body).toContain('&lt;b&gt;');
    expect(body).toContain('r="4.6"');
    expect(body).toContain('opacity="0.55"');
    expect(body).toContain('M 0 0 L 10 10');
  });
  it('未知 format 400', () => {
    expect(() => exportGraph(board, { format: 'pdf' })).toThrow();
  });
});
