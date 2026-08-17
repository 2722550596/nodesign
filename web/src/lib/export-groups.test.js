import { describe, it, expect } from 'vitest';
import { groupArtifacts } from './export-groups.js';

/**
 * 这套盯的是「类型判据不在前端重造」：分组只该消费服务端给的 kind / cardKind，
 * 自己不认扩展名、不猜。漏一个类型的症状是「导出菜单里没有视频这一栏」，
 * 而项目里明明有视频 —— 没人会报这个 bug，只会以为不支持。
 */

const payload = {
  tasks: [
    {
      id: '蘑菇书店', title: '蘑菇书店',
      artifacts: [{ kind: 'site', root: '蘑菇书店', title: '蘑菇书店', exports: ['site', 'html', 'handoff'] }],
    },
    {
      id: '', title: '根站',
      artifacts: [{ kind: 'site', root: '', title: '根站', exports: ['site', 'html', 'handoff'] }],
    },
    {
      id: '演讲', title: '演讲',
      artifacts: [{ kind: 'deck', file: '演讲/canvas.html', title: '演讲', exports: ['html', 'pdf', 'pptx', 'handoff'] }],
    },
  ],
  artifacts: [
    { path: 'assets/generated/店招.png', name: '店招.png', cardKind: 'image', exports: ['raw', 'zip'], size: 1024 },
    { path: 'assets/generated/成片.mp4', name: '成片.mp4', cardKind: 'video', exports: ['raw', 'zip'], size: 2048 },
    { path: 'assets/notes/决策.md', name: '决策.md', cardKind: 'note', exports: ['raw', 'zip', 'md'] },
    { path: 'assets/合同.pdf', name: '合同.pdf', cardKind: 'file', exports: ['raw', 'zip'] },
    { path: 'assets/旧.png', name: '旧.png' },      // 服务端没标 cardKind（旧数据）
  ],
};

describe('groupArtifacts', () => {
  it('六种类型都认得，顺序固定（用户最可能导的排前面）', () => {
    expect(groupArtifacts(payload).map(g => g.type))
      .toEqual(['site', 'deck', 'image', 'video', 'note', 'file']);
  });

  it('卡 id 走 cardIdOf，跟画布拼的、服务端反解的是同一套', () => {
    const g = groupArtifacts(payload);
    const site = g.find(x => x.type === 'site');
    expect(site.items.map(i => i.cardId).sort()).toEqual(['site:', 'site:蘑菇书店']);
    expect(g.find(x => x.type === 'deck').items[0].cardId).toBe('deck:演讲/canvas.html');
    expect(g.find(x => x.type === 'image').items[0].cardId).toBe('assets/generated/店招.png');
  });

  it('没标类型的旧数据跳过，不猜', () => {
    const imgs = groupArtifacts(payload).find(g => g.type === 'image');
    expect(imgs.items.map(i => i.title)).toEqual(['店招.png']);
  });

  it('空分类不出现在菜单里（摆着只是噪音）', () => {
    const g = groupArtifacts({ tasks: [], artifacts: [payload.artifacts[0]] });
    expect(g.map(x => x.type)).toEqual(['image']);
  });

  it('同类型的可用格式取交集 —— 勾几个一起导，格式得对每个都成立', () => {
    const g = groupArtifacts({
      tasks: [], artifacts: [
        { path: 'a.md', name: 'a.md', cardKind: 'note', exports: ['raw', 'zip', 'md'] },
        { path: 'b.md', name: 'b.md', cardKind: 'note', exports: ['raw', 'zip'] },
      ],
    });
    expect(g[0].formats).toEqual(['raw', 'zip']);
  });

  it('空输入不炸', () => {
    expect(groupArtifacts(null)).toEqual([]);
    expect(groupArtifacts({})).toEqual([]);
  });
});
