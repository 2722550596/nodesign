/**
 * rewrite-refs 单测（08-24，iss_mt38uih6）。自动改写用户内容的东西，
 * 正反两面都要钉：该改的改到、不该碰的一个字不动。
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rewriteTextRefs, rebaseSelfRefs, rewriteWorkspaceRefs } from './rewrite-refs.js';

describe('rewriteTextRefs（引用文件没搬，目标搬了）', () => {
  const pairs = [['assets/generated/a.png', '素材/a.png']];

  it('根层 html 的引号引用', () => {
    const r = rewriteTextRefs('<img src="assets/generated/a.png">', '', '', pairs);
    expect(r.text).toBe('<img src="素材/a.png">');
    expect(r.hits).toBe(1);
  });

  it('子目录页面的 ../ 写法按自己目录换算', () => {
    const r = rewriteTextRefs('url(../assets/generated/a.png)', '站点', '站点', pairs);
    expect(r.text).toBe('url(../素材/a.png)');
  });

  it('URL 编码变体也认', () => {
    const p2 = [['素 材/图 1.png', '归档/图 1.png']];
    const r = rewriteTextRefs('<img src="%E7%B4%A0%20%E6%9D%90/%E5%9B%BE%201.png">', '', '', p2);
    expect(r.text).toContain(encodeURI('归档/图 1.png'));
  });

  it('普通文字里的同名串不误伤（无边界字符不替换）', () => {
    const r = rewriteTextRefs('说明：xassets/generated/a.pngy 不是引用', '', '', pairs);
    expect(r.hits).toBe(0);
  });

  it('搬文件夹：前缀延续（/ 后面还有段）也改', () => {
    const p2 = [['旧夹', '新夹']];
    const r = rewriteTextRefs('<a href="旧夹/深处/x.png">', '', '', p2);
    expect(r.text).toBe('<a href="新夹/深处/x.png">');
  });
});

describe('rebaseSelfRefs（引用文件自己搬了）', () => {
  it('指向没搬目标的引用换基准', () => {
    const r = rebaseSelfRefs('<img src="assets/x.png">', '', '夹', new Map());
    expect(r.text).toBe('<img src="../assets/x.png">');
  });

  it('目标也搬了：查 moves 表', () => {
    const moves = new Map([['assets/x.png', '夹/x.png']]);
    const r = rebaseSelfRefs('<img src="assets/x.png">', '', '夹', moves);
    expect(r.text).toBe('<img src="x.png">');
  });

  it('http/data/锚点/绝对路径不碰', () => {
    const t = '<a href="https://a.b/c.png"><img src="data:image/png;base64,xx"><a href="#top"><a href="/abs.png">';
    const r = rebaseSelfRefs(t, '', '夹', new Map());
    expect(r.text).toBe(t);
  });
});

describe('rewriteWorkspaceRefs（真文件端到端）', () => {
  it('归纳图片进新夹：根 deck 与子页引用都改，改动数如实上报', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'rwref-'));
    await mkdir(path.join(ws, 'assets/generated'), { recursive: true });
    await mkdir(path.join(ws, '站点'), { recursive: true });
    await mkdir(path.join(ws, '素材'), { recursive: true });
    await writeFile(path.join(ws, 'assets/generated/a.png'), 'x');
    await writeFile(path.join(ws, 'canvas.html'), '<img src="assets/generated/a.png">');
    await writeFile(path.join(ws, '站点/index.html'), '<img src="../assets/generated/a.png">');
    // 真搬（工具里 moveEntry 干的事，这里手动 rename 模拟）
    await rename(path.join(ws, 'assets/generated/a.png'), path.join(ws, '素材/a.png'));
    const out = await rewriteWorkspaceRefs(ws, [{ from: 'assets/generated/a.png', to: '素材/a.png' }]);
    expect(out.files).toBe(2);
    expect(out.hits).toBe(2);
    expect(await readFile(path.join(ws, 'canvas.html'), 'utf8')).toBe('<img src="素材/a.png">');
    expect(await readFile(path.join(ws, '站点/index.html'), 'utf8')).toBe('<img src="../素材/a.png">');
  });
});
