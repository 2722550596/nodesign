/**
 * board-relations 规则钉子（2026-08-14 可维护性行动 D 刀）。
 *
 * endpointMatchesRel 是一跳邻域注入的命中判据 —— 它曾只做精确匹配，站点页
 * 文件的邻域从来没命中过根卡上的边（十一批查实）。这里把目录型收敛的口径
 * 钉死，**必须与前端 resolveObjectId 同规则**（stage-resolve.test.js 是它的
 * 镜像，两边一起改）。
 */
import { describe, it, expect } from 'vitest';
import { endpointMatchesRel, describeEndpoint } from './board-relations.js';

describe('endpointMatchesRel —— 端点命中', () => {
  it('裸路径与 kind 前缀的精确匹配', () => {
    expect(endpointMatchesRel('assets/a.png', 'assets/a.png')).toBe(true);
    expect(endpointMatchesRel('deck:主稿.html', '主稿.html')).toBe(true);
    expect(endpointMatchesRel('deck:主稿.html', '别稿.html')).toBe(false);
  });

  it('目录型收敛：站点里的文件命中根卡（十一批修的）', () => {
    expect(endpointMatchesRel('site:鉴赏页', '鉴赏页/index.html')).toBe(true);
    expect(endpointMatchesRel('site:鉴赏页', '鉴赏页/posts/a.html')).toBe(true);
    expect(endpointMatchesRel('site:观察日志', '观察日志/posts/一月.html')).toBe(true);
    expect(endpointMatchesRel('site:鉴赏页', '别处/index.html')).toBe(false);
  });

  it('根站（root=空串）收根层散文件，.md 除外，带 / 的不收', () => {
    expect(endpointMatchesRel('site:', 'index.html')).toBe(true);
    expect(endpointMatchesRel('site:', 'style.css')).toBe(true);
    expect(endpointMatchesRel('site:', '随笔.md')).toBe(false);
    expect(endpointMatchesRel('site:', 'notes/决策.md')).toBe(false);
  });

  it('deck 不做目录收敛（单文件产物只认精确匹配）', () => {
    expect(endpointMatchesRel('deck:稿件/主稿.html', '稿件/主稿.html')).toBe(true);
    expect(endpointMatchesRel('deck:稿件/主稿.html', '稿件/主稿.css')).toBe(false);
  });
});

describe('describeEndpoint —— 给 agent 看的端点描述', () => {
  it('根站的空 rel 有专门措辞（空串是身份不是没有值）', () => {
    expect(describeEndpoint('site:', {})).toBe('工作区根上的site');
    expect(describeEndpoint('site:鉴赏页', {})).toBe('鉴赏页（site）');
  });

  it('手写字带内容摘录，裸路径原样', () => {
    const board = { objects: { 'text:t1': { kind: 'text', data: { t: '这版更暗' } } } };
    expect(describeEndpoint('text:t1', board)).toBe('手写字「这版更暗」');
    expect(describeEndpoint('assets/a.png', board)).toBe('assets/a.png');
  });
});
