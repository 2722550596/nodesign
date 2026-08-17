import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { collectAssetRefs, renderUnresolvedReport } from './asset-refs.js';
import { fileKindOf, fileFormatAllowed } from './kinds/file-kinds.js';

/**
 * 这套测试盯的是**静默漏引用**：扫描器少认一种写法，导出的包就少一张图，
 * 而且不会报错 —— 用户解压之后才看见裂图。所以每种真实写法都要有一条断言。
 */

let root;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-refs-'));
  await fs.mkdir(path.join(root, '站点/子页'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets/generated'), { recursive: true });

  await fs.writeFile(path.join(root, '站点/index.html'), `
    <link rel="stylesheet" href="style.css">
    <img src="../assets/generated/封面.png">
    <img src="../assets/generated/带查询.webp?w=480">
    <img srcset="../assets/generated/小.png 1x, ../assets/generated/大.png 2x">
    <video poster="../assets/generated/海报.jpg"></video>
    <a href="子页/详情.html">进去</a>
    <img src="https://example.com/远程.png">
    <img src="data:image/png;base64,AAAA">
    <script>
      const n = '3';
      img.src = 'assets/generated/动态-' + n + '.png';
    </script>
  `);
  await fs.writeFile(path.join(root, '站点/style.css'), `
    body { background: url('../assets/generated/纹理.png'); }
    .x { background: url(../assets/generated/无引号.svg); }
  `);
  await fs.writeFile(path.join(root, '站点/子页/详情.html'), `
    <img src="../../assets/generated/子页图.png">
  `);
  for (const f of ['封面.png', '带查询.webp', '小.png', '大.png', '海报.jpg', '纹理.png', '无引号.svg', '子页图.png']) {
    await fs.writeFile(path.join(root, 'assets/generated', f), 'x');
  }
});

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function scanSite() {
  const rels = ['站点/index.html', '站点/style.css', '站点/子页/详情.html'];
  return collectAssetRefs({
    files: rels.map(rel => ({ rel, abs: path.join(root, rel) })),
    baseRoot: root,
  });
}

describe('collectAssetRefs', () => {
  it('认得 src / href / poster / srcset / css url 五种写法', async () => {
    const { refs } = await scanSite();
    for (const f of ['封面.png', '小.png', '大.png', '海报.jpg', '纹理.png', '无引号.svg']) {
      expect(refs, `漏了 ${f}`).toContain(`assets/generated/${f}`);
    }
  });

  it('查询串要剥掉再解析（?w=480 的变体不是另一个文件）', async () => {
    const { refs } = await scanSite();
    expect(refs).toContain('assets/generated/带查询.webp');
    expect(refs.some(r => r.includes('?'))).toBe(false);
  });

  it('子目录页面按它自己的深度解析（../../ 不能当成 ../）', async () => {
    const { refs } = await scanSite();
    expect(refs).toContain('assets/generated/子页图.png');
  });

  it('外链 / data: 不收，产物自己的页面也不算素材', async () => {
    const { refs } = await scanSite();
    expect(refs.some(r => r.includes('example.com'))).toBe(false);
    expect(refs.some(r => r.startsWith('data:'))).toBe(false);
    expect(refs).not.toContain('站点/子页/详情.html');   // 站内链接不是素材
    expect(refs).not.toContain('站点/style.css');
  });

  it('逃出工作区的引用不收', async () => {
    const bad = path.join(root, '坏.html');
    await fs.writeFile(bad, '<img src="../../../../etc/passwd">');
    const { refs } = await collectAssetRefs({
      files: [{ rel: '坏.html', abs: bad }], baseRoot: root,
    });
    expect(refs).toEqual([]);
  });

  it('动态拼的路径进 unresolved，且不混进 refs', async () => {
    const { refs, unresolved } = await scanSite();
    expect(refs.some(r => r.includes('动态'))).toBe(false);
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved[0].from).toBe('站点/index.html');
  });

  it('没有动态引用时不生成清单（别再造一个常年空着的占位文件）', () => {
    expect(renderUnresolvedReport([])).toBeNull();
    expect(renderUnresolvedReport(undefined)).toBeNull();
  });

  it('有动态引用时清单按文件分组', async () => {
    const { unresolved } = await scanSite();
    const md = renderUnresolvedReport(unresolved);
    expect(md).toContain('站点/index.html');
    expect(md).toContain('没能解析的素材引用');
  });
});

describe('fileKindOf —— 判据次序必须跟前端 BoardCanvas 那四行一致', () => {
  it('便签先于扩展名：note 也是 .md，先问来源', () => {
    expect(fileKindOf({ kind: 'note', isImage: false })).toBe('note');
  });
  it('图片 / 视频 / 其余', () => {
    expect(fileKindOf({ kind: 'generated', isImage: true })).toBe('image');
    expect(fileKindOf({ kind: 'generated', isVideo: true })).toBe('video');
    expect(fileKindOf({ kind: 'upload' })).toBe('file');
    expect(fileKindOf(null)).toBe('file');
  });
  it('导出守卫：便签能合并成 md，图片不能', () => {
    expect(fileFormatAllowed('note', 'md')).toBe(true);
    expect(fileFormatAllowed('image', 'md')).toBe(false);
    expect(fileFormatAllowed('image', 'zip')).toBe(true);
    expect(fileFormatAllowed('不存在', 'zip')).toBe(false);
  });
});
