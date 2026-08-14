// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { applyOpsToSource } from './site-source-patch.js';
import { versionOfSitePage } from './file-versions.js';

const SRC = `<!doctype html>
<html><head><title>t</title><style>.card{padding:8px}</style></head>
<body>
  <h1>标题</h1>
  <div class="cards">
    <div class="card" id="a"><h2>甲</h2><p>一</p></div>
    <div class="card" id="b"><h2>乙</h2><p>二</p></div>
    <div class="card" id="c"><h2>丙</h2><p>三</p></div>
  </div>
</body></html>`;

// 模拟"运行时锚点"：在带污染的运行时 DOM 上算出来的 path/textHint。
// 这里直接用干净结构算（等价于脚本没动过目标元素祖先链的情形）。
const anchorOf = (path, textHint) => ({ dataId: null, path, textHint, bbox: { x: 0, y: 0, w: 10, h: 10 } });

describe('applyOpsToSource', () => {
  it('text op：只改目标文本，源码其余原样', () => {
    const out = applyOpsToSource(SRC, [
      { type: 'text', anchor: anchorOf('div > div:nth-of-type(2) > h2', '乙'), newText: '乙改' },
    ]);
    expect(out).toContain('<h2>乙改</h2>');
    expect(out).toContain('<h2>甲</h2>');
    expect(out).toContain('<style>.card{padding:8px}</style>');
    expect(out).toMatch(/^<!doctype html>/i);
  });

  it('move op：丙插到甲之前，保持在 .cards 内', () => {
    const out = applyOpsToSource(SRC, [{
      type: 'move',
      anchor: anchorOf('div > div:nth-of-type(3)', '丙'),
      container: anchorOf('div', ''),   // .cards 是 body 下唯一 div
      before: anchorOf('div > div:nth-of-type(1)', '甲'),
    }]);
    const cards = out.match(/id="([abc])"/g).map(s => s.slice(4, 5));
    expect(cards).toEqual(['c', 'a', 'b']);
  });

  it('style op：写 styles + 父容器 relative', () => {
    const out = applyOpsToSource(SRC, [{
      type: 'style',
      anchor: anchorOf('div > div:nth-of-type(1)', '甲'),
      styles: { position: 'absolute', left: '90px', top: '60px' },
      parentNeedsRelative: true,
    }]);
    expect(out).toMatch(/id="a"[^>]*style="[^"]*position:\s*absolute/);
    expect(out).toMatch(/class="cards"[^>]*style="[^"]*position:\s*relative/);
  });

  it('duplicate op：克隆插入，原元素保留', () => {
    const out = applyOpsToSource(SRC, [{
      type: 'duplicate',
      anchor: anchorOf('div > div:nth-of-type(2)', '乙'),
      container: anchorOf('div', ''),
      before: null,
    }]);
    expect(out.match(/<h2>乙<\/h2>/g)).toHaveLength(2);
  });

  it('textHint 兜底：path 对不上时按文本找到同一元素', () => {
    const out = applyOpsToSource(SRC, [
      { type: 'text', anchor: anchorOf('section > div:nth-of-type(9) > h2', '丙'), newText: '丙改' },
    ]);
    expect(out).toContain('丙改');
  });

  it('锚点彻底找不到 → 整体放弃返回 null（调用方回退）', () => {
    const out = applyOpsToSource(SRC, [
      { type: 'text', anchor: anchorOf('article > span:nth-of-type(9)', '不存在的文案'), newText: 'x' },
    ]);
    expect(out).toBeNull();
  });

  it('textHint 不被祖先抢跑：容器「甲一」解析成 card-a 而非 .cards、before「甲」解析成 h2', () => {
    // .cards 的整体文本也以「甲一」开头（祖先文本 = 后代文本连接），文档序第一个
    // 命中永远是祖先 —— 2026-07-30 真机 bug：move 因此静默退化成 append 到 .cards
    const out = applyOpsToSource(SRC, [{
      type: 'move',
      anchor: anchorOf('div > div:nth-of-type(3)', '丙'),
      container: anchorOf('nonexistent > q', '甲一'),   // path 全 miss，逼走 textHint
      before: anchorOf('nonexistent > q', '甲'),
    }]);
    expect(out).not.toBeNull();
    expect(out).toMatch(/id="a"><div class="card" id="c"/);   // 丙嵌进 card-a、在 h2 之前
  });

  it('move 严格校验：before 解析不出 → 整体回退（不许静默 append 近似）', () => {
    const out = applyOpsToSource(SRC, [{
      type: 'move',
      anchor: anchorOf('div > div:nth-of-type(3)', '丙'),
      container: anchorOf('nonexistent > q', '甲一'),
      before: anchorOf('nonexistent > q', '这段文本不存在'),
    }]);
    expect(out).toBeNull();
  });

  it('move 严格校验：before 不是 container 的孩子 → 整体回退', () => {
    const out = applyOpsToSource(SRC, [{
      type: 'move',
      anchor: anchorOf('div > div:nth-of-type(3)', '丙'),
      container: anchorOf('nonexistent > q', '甲一'),   // card-a
      before: anchorOf('nonexistent > q', '乙'),        // card-b 的 h2（不在 card-a 里）
    }]);
    expect(out).toBeNull();
  });

  it('多 op 顺序重放：改字 + 搬移一起落', () => {
    const out = applyOpsToSource(SRC, [
      { type: 'text', anchor: anchorOf('div > div:nth-of-type(1) > h2', '甲'), newText: '甲改' },
      {
        type: 'move',
        anchor: anchorOf('div > div:nth-of-type(3)', '丙'),
        container: anchorOf('div', ''),
        before: anchorOf('div > div:nth-of-type(1)', '甲改'),
      },
    ]);
    expect(out).toContain('甲改');
    const cards = out.match(/id="([abc])"/g).map(s => s.slice(4, 5));
    expect(cards).toEqual(['c', 'a', 'b']);
  });
});

describe('versionOfSitePage', () => {
  const versions = {
    'tasks/t/index.html': 3,
    'tasks/t/about.html': 5,
    'tasks/t/style.css': 2,
    'tasks/t/js/app.js': 1,
    'tasks/other/index.html': 9,
  };
  it('本页 + 非 html 资产计入，其它页不计', () => {
    expect(versionOfSitePage(versions, 'tasks/t', 'index.html')).toBe(3 + 2 + 1);
    expect(versionOfSitePage(versions, 'tasks/t', 'about.html')).toBe(5 + 2 + 1);
  });
  it('改别的页不影响本页版本（不触发重载）', () => {
    const before = versionOfSitePage(versions, 'tasks/t', 'index.html');
    const after = versionOfSitePage({ ...versions, 'tasks/t/about.html': 6 }, 'tasks/t', 'index.html');
    expect(after).toBe(before);
  });
  it('构建型：base 限定在 dist 内', () => {
    const v = { 'tasks/b/dist/index.html': 1, 'tasks/b/dist/x.css': 1, 'tasks/b/src/index.html': 7, 'tasks/b/src/m.js': 4 };
    expect(versionOfSitePage(v, 'tasks/b/dist', 'index.html')).toBe(2);
  });
  it('根站：base 为空串时页面 key 无前缀、全工作区非 html 都是资产', () => {
    const v = { 'index.html': 2, 'posts/chapter-1.html': 5, 'style.css': 3 };
    expect(versionOfSitePage(v, '', 'index.html')).toBe(2 + 3);
    expect(versionOfSitePage(v, '', 'posts/chapter-1.html')).toBe(5 + 3);
  });
});
