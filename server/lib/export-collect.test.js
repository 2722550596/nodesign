import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { parseCardId, collectCard, collectCards, exportFormatsFor } from './export-collect.js';

/**
 * 这套测试钉的是重做导出的两条命根子：
 *   1. **收的是「这张卡」的东西**，不是整个项目 —— 旧交付包把整个 shared/assets
 *      递归打包，生产上最大的项目那目录 280MB，导出一份 deck 会把别的任务的图
 *      一起交出去。下面「别的任务的素材不进包」那条就是钉它的。
 *   2. **卡 id 就是地址**，解析不能跟前端 BoardCanvas / board-store 的判据分叉。
 */

let ws;

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-collect-'));
  // 产物扁平住在工作区根（2026-08-07 起）
  await fs.mkdir(path.join(ws, '蘑菇书店/app'), { recursive: true });
  await fs.mkdir(path.join(ws, '别人的任务'), { recursive: true });
  await fs.mkdir(path.join(ws, 'assets/generated'), { recursive: true });
  await fs.mkdir(path.join(ws, 'assets/notes'), { recursive: true });

  await fs.writeFile(path.join(ws, '蘑菇书店/index.html'),
    `<link rel="stylesheet" href="style.css">
     <img src="../assets/generated/店招.png">
     <img src="../assets/generated/丢了的图.png">
     <script src="app/api.js"></script>`);
  await fs.writeFile(path.join(ws, '蘑菇书店/style.css'), 'body{background:url(../assets/generated/纸纹.png)}');
  await fs.writeFile(path.join(ws, '蘑菇书店/app/api.js'), 'export const listBooks = () => [];');

  await fs.writeFile(path.join(ws, '演讲稿.html'), '<img src="assets/generated/封面.png">');

  // 别的任务，引用另一张图 —— 它绝不该出现在蘑菇书店的包里
  await fs.writeFile(path.join(ws, '别人的任务/index.html'), '<img src="../assets/generated/别人的图.png">');

  for (const f of ['店招.png', '纸纹.png', '封面.png', '别人的图.png', '没人引用的孤儿图.png']) {
    await fs.writeFile(path.join(ws, 'assets/generated', f), 'x');
  }
  await fs.writeFile(path.join(ws, 'assets/notes/决策.md'), '# 决策\n拼贴风');
  await fs.writeFile(path.join(ws, 'assets/generated/成片.mp4'), 'x');
});

afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

describe('parseCardId', () => {
  it('认目录型和单文件型的任务产物', () => {
    expect(parseCardId('site:蘑菇书店')).toEqual({ kind: 'site', rel: '蘑菇书店' });
    expect(parseCardId('deck:演讲稿.html')).toEqual({ kind: 'deck', rel: '演讲稿.html' });
  });

  it('裸路径 = 文件卡，类型按路径推', () => {
    expect(parseCardId('assets/generated/店招.png').kind).toBe('image');
    expect(parseCardId('assets/generated/成片.mp4').kind).toBe('video');
    expect(parseCardId('assets/notes/决策.md').kind).toBe('note');
    expect(parseCardId('assets/合同.pdf').kind).toBe('file');
  });

  it('路径里的冒号不算前缀（前缀只认纯字母）', () => {
    expect(parseCardId('assets/09:30 的稿子.png').kind).toBe('image');
  });

  it('认不出的输入返回 null', () => {
    expect(parseCardId('')).toBeNull();
    expect(parseCardId(null)).toBeNull();
  });
});

describe('collectCard —— site 卡', () => {
  it('收整棵树，且只收它真正引用到的素材', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    expect(b.kind).toBe('site');
    expect(b.files.map(f => f.rel).sort()).toEqual([
      '蘑菇书店/app/api.js', '蘑菇书店/index.html', '蘑菇书店/style.css',
    ]);
    const assets = b.assets.map(a => a.rel);
    expect(assets).toContain('assets/generated/店招.png');
    expect(assets).toContain('assets/generated/纸纹.png');
  });

  it('⭐别的任务的素材不进包（这条钉的就是 280MB 那个病）', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const assets = b.assets.map(a => a.rel);
    expect(assets).not.toContain('assets/generated/别人的图.png');
    expect(assets).not.toContain('assets/generated/孤儿图.png');
    expect(assets).not.toContain('assets/generated/没人引用的孤儿图.png');
    expect(assets).not.toContain('assets/generated/成片.mp4');
  });

  it('引用了但磁盘上没有的，进 missing 而不是静默丢掉', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    expect(b.missing).toContain('assets/generated/丢了的图.png');
    expect(b.assets.map(a => a.rel)).not.toContain('assets/generated/丢了的图.png');
  });

  it('站内的 js/css 算产物自身，不算素材', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:蘑菇书店' });
    const assets = b.assets.map(a => a.rel);
    expect(assets).not.toContain('蘑菇书店/style.css');
    expect(assets).not.toContain('蘑菇书店/app/api.js');
  });
});

describe('collectCard —— deck / 文件卡', () => {
  it('deck 卡只收那一份 html + 它的素材', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'deck:演讲稿.html' });
    expect(b.files.map(f => f.rel)).toEqual(['演讲稿.html']);
    expect(b.assets.map(a => a.rel)).toEqual(['assets/generated/封面.png']);
  });

  it('图片卡就是那一个文件，不扫引用', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'assets/generated/店招.png' });
    expect(b.kind).toBe('image');
    expect(b.files.map(f => f.rel)).toEqual(['assets/generated/店招.png']);
    expect(b.assets).toEqual([]);
    expect(b.unresolved).toEqual([]);
  });

  it('每种形态各自报自己能导出成什么', async () => {
    expect(exportFormatsFor('site')).toContain('site');
    expect(exportFormatsFor('deck')).toContain('pdf');
    expect(exportFormatsFor('image')).toEqual(['raw', 'zip']);
    expect(exportFormatsFor('note')).toContain('md');
    expect(exportFormatsFor('没这种')).toEqual([]);
  });
});

describe('collectCard —— 拒绝', () => {
  it('越界路径 400', async () => {
    await expect(collectCard({ workspaceRoot: ws, cardId: '../../../etc/passwd' }))
      .rejects.toMatchObject({ status: 400 });
  });
  it('不存在的产物 404', async () => {
    await expect(collectCard({ workspaceRoot: ws, cardId: 'deck:没有这个.html' }))
      .rejects.toMatchObject({ status: 404 });
  });
  it('site 卡指到文件上 = 单页站点，不该拒（_drafts 试作就是这种卡）', async () => {
    const b = await collectCard({ workspaceRoot: ws, cardId: 'site:演讲稿.html' });
    expect(b.single).toBe(true);
    expect(b.files.map(f => f.rel)).toEqual(['演讲稿.html']);
  });
});

describe('collectCards —— 批量', () => {
  it('单张失败不拖累整批，少了什么要看得见', async () => {
    const { bundles, skipped } = await collectCards({
      workspaceRoot: ws,
      cardIds: ['assets/generated/店招.png', 'deck:没有这个.html', 'assets/generated/封面.png'],
    });
    expect(bundles).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].cardId).toBe('deck:没有这个.html');
    expect(skipped[0].reason).toMatch(/不存在/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2026-08-17 评审补充：下面每一条在修之前都是红的，钉的是六个 P0
// ──────────────────────────────────────────────────────────────────────────

import { fileKindOfPath, fileKindOf } from './kinds/file-kinds.js';

describe('评审补充 · 根级站点卡（扁平化后「根 index.html = 一个站」是常态）', () => {
  let ws2;
  beforeAll(async () => {
    ws2 = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-root-'));
    await fs.mkdir(path.join(ws2, 'assets/generated'), { recursive: true });
    await fs.mkdir(path.join(ws2, 'exports'), { recursive: true });
    await fs.mkdir(path.join(ws2, '别的任务'), { recursive: true });
    await fs.mkdir(path.join(ws2, 'lib'), { recursive: true });
    await fs.writeFile(path.join(ws2, 'index.html'), '<script src="lib/chart.js"></script><img src="assets/generated/店招.png">');
    await fs.writeFile(path.join(ws2, 'lib/chart.js'), '//x');
    await fs.writeFile(path.join(ws2, 'board.json'), '{}');
    await fs.writeFile(path.join(ws2, 'exports/老导出.zip'), 'x');
    await fs.writeFile(path.join(ws2, '别的任务/index.html'), 'x');
    await fs.writeFile(path.join(ws2, 'assets/generated/店招.png'), 'x');
    await fs.writeFile(path.join(ws2, 'assets/generated/没用到的大图.png'), 'x');
  });
  afterAll(async () => { await fs.rm(ws2, { recursive: true, force: true }); });

  it('⭐不许把共享素材 / exports / 画布私档打进包（280MB 病的真身）', async () => {
    const b = await collectCard({ workspaceRoot: ws2, cardId: 'site:' });
    const rels = b.files.map(f => f.rel);
    expect(rels.some(r => r.startsWith('assets/'))).toBe(false);
    expect(rels.some(r => r.startsWith('exports/'))).toBe(false);
    expect(rels).not.toContain('board.json');
  });

  it('页面清单由 manifest 说了算，非页面的资源从引用走', async () => {
    const b = await collectCard({ workspaceRoot: ws2, cardId: 'site:' });
    // files = 权威解析器认领的页面；lib/chart.js 不是页面，它是被引用的资源
    expect(b.files.map(f => f.rel)).toContain('index.html');
    expect(b.assets.map(a => a.rel)).toContain('lib/chart.js');
    // ⚠️ 有根站时，裸子目录会被根站吞掉当成它的页（rootSiteClaims 口径）——
    // 这是解析器的判断，导出跟着它走，不自己另立判据
    expect(b.files.map(f => f.rel)).toContain('别的任务/index.html');
  });

  it('被引用的共享素材仍然按引用收进来', async () => {
    const b = await collectCard({ workspaceRoot: ws2, cardId: 'site:' });
    expect(b.assets.map(a => a.rel)).toContain('assets/generated/店招.png');
    expect(b.assets.map(a => a.rel)).not.toContain('assets/generated/没用到的大图.png');
  });
});

describe('评审补充 · 单页站点卡 / 扫描器四病 / 软链', () => {
  let ws3;
  beforeAll(async () => {
    ws3 = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-misc-'));
    await fs.mkdir(path.join(ws3, '任务A/_drafts'), { recursive: true });
    await fs.mkdir(path.join(ws3, 'assets/generated'), { recursive: true });
    await fs.mkdir(path.join(ws3, '别的任务'), { recursive: true });
    await fs.mkdir(path.join(ws3, '站/关于'), { recursive: true });
    await fs.writeFile(path.join(ws3, '任务A/_drafts/试作.html'), '<p>x</p>');
    await fs.writeFile(path.join(ws3, '别的任务/index.html'), 'x');
    await fs.writeFile(path.join(ws3, '站/index.html'),
      `<script src="chart.js"></script>
       <!-- <img src="../assets/generated/注释里的旧图.png"> -->
       <img src="../assets/generated/it's.png">
       <a href="../别的任务/index.html">别人</a>
       <a href="关于/">关于</a>
       <script>const 图集 = ['../assets/generated/画廊1.png'];</script>`);
    await fs.writeFile(path.join(ws3, '站/chart.js'), '//x');
    await fs.writeFile(path.join(ws3, '站/关于/index.html'), 'x');
    for (const f of ['注释里的旧图.png', "it's.png", '画廊1.png']) {
      await fs.writeFile(path.join(ws3, 'assets/generated', f), 'x');
    }
  });
  afterAll(async () => { await fs.rm(ws3, { recursive: true, force: true }); });

  it('单页站点卡能收，且没有「整站 zip」这个格式', async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:任务A/_drafts/试作.html' });
    expect(b.files.map(f => f.rel)).toEqual(['任务A/_drafts/试作.html']);
    expect(b.single).toBe(true);
    expect(b.exportFormats).not.toContain('site');
  });

  it('<script src> 是真引用，摘脚本块不许连它一起摘', async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:站' });
    expect(b.files.map(f => f.rel)).toContain('站/chart.js');
  });

  it('HTML 注释里的旧引用不进包', async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:站' });
    expect(b.assets.map(a => a.rel)).not.toContain('assets/generated/注释里的旧图.png');
  });

  it("撇号文件名不许截断成幻影（it's.png 不能变成 it）", async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:站' });
    expect(b.assets.map(a => a.rel)).toContain("assets/generated/it's.png");
    expect(b.missing).not.toContain('assets/generated/it');
  });

  it('⭐树外引用只认 assets/：别的任务的产物不进包，但要进清单', async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:站' });
    expect(b.assets.map(a => a.rel)).not.toContain('别的任务/index.html');
    expect(b.unresolved.some(u => u.snippet.includes('别的任务'))).toBe(true);
  });

  it('pretty-URL 目录引用不算裂图（about/ 指的是 about/index.html）', async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:站' });
    expect(b.missing).not.toContain('站/关于');
  });

  it('脚本里的字面量：磁盘上真有就收（那不是猜，是扫得到）', async () => {
    const b = await collectCard({ workspaceRoot: ws3, cardId: 'site:站' });
    expect(b.assets.map(a => a.rel)).toContain('assets/generated/画廊1.png');
  });

  it('脚本里的字面量：磁盘上没有的不许多塞，只进清单', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-lit-'));
    await fs.mkdir(path.join(dir, '站'), { recursive: true });
    await fs.writeFile(path.join(dir, '站/index.html'),
      `<script>const 图集 = ['./不存在的图.png'];</script>`);
    const b = await collectCard({ workspaceRoot: dir, cardId: 'site:站' });
    expect(b.assets).toEqual([]);
    expect(b.unresolved.some(u => u.snippet.includes('不存在的图'))).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('软链指到工作区外的文件，不许收进包', async () => {
    const secret = path.join(os.tmpdir(), `机密-${Date.now()}.txt`);
    await fs.writeFile(secret, 'SECRET');
    await fs.symlink(secret, path.join(ws3, '看起来无害.txt'));
    await expect(collectCard({ workspaceRoot: ws3, cardId: '看起来无害.txt' }))
      .rejects.toMatchObject({ status: 400 });
    await fs.rm(secret, { force: true });
  });
});

describe('评审补充 · .ndignore 基准要问权威解析器，不能从卡 id 上切', () => {
  it('根级构建站：.ndignore 在工作区根，必须生效', async () => {
    const ws4 = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ign-'));
    await fs.mkdir(path.join(ws4, 'dist/垃圾'), { recursive: true });
    await fs.writeFile(path.join(ws4, '.ndignore'), 'dist/垃圾/\n');
    await fs.writeFile(path.join(ws4, 'dist/index.html'), 'x');
    await fs.writeFile(path.join(ws4, 'dist/垃圾/中间物.txt'), 'x');
    const b = await collectCard({ workspaceRoot: ws4, cardId: 'site:dist' });
    expect(b.files.map(f => f.rel)).not.toContain('dist/垃圾/中间物.txt');
    await fs.rm(ws4, { recursive: true, force: true });
  });

  it('嵌套站：.ndignore 在站自己那层，必须生效', async () => {
    const ws5 = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ign2-'));
    await fs.mkdir(path.join(ws5, '客户/官网/草稿'), { recursive: true });
    await fs.writeFile(path.join(ws5, '客户/官网/.ndignore'), '草稿/\n');
    await fs.writeFile(path.join(ws5, '客户/官网/index.html'), 'x');
    await fs.writeFile(path.join(ws5, '客户/官网/草稿/废案.html'), 'x');
    const b = await collectCard({ workspaceRoot: ws5, cardId: 'site:客户/官网' });
    expect(b.files.map(f => f.rel)).not.toContain('客户/官网/草稿/废案.html');
    await fs.rm(ws5, { recursive: true, force: true });
  });
});

describe('评审补充 · 两个判形函数必须给同一个答案', () => {
  it('notes/ 下的非 .md 文件（便签按位置判，不看扩展名）', () => {
    for (const p of ['notes/参考图.png', 'assets/notes/摘录.txt', 'notes/无扩展名']) {
      expect(fileKindOfPath(p), p).toBe(fileKindOf({ kind: 'note' }));
    }
  });
  it('notes 之外的图片仍是 image', () => {
    expect(fileKindOfPath('assets/generated/x.png')).toBe('image');
  });
});
