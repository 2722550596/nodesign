import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { taskManifest, can, KINDS, formatAllowed } from './index.js';
import { pairDocxSources } from './docx.js';
import { PRESETS } from '../docx/tokens.js';
import { buildDocx } from '../docx/build.js';

/**
 * docx 形态注册的判定链。盯三件容易错的：
 *   1. **能力位分流**：docx 不可浏览、但可渲染 —— 感知工具按能力问，不按形态名问
 *   2. **「声明即意图」窗口期**：token 源写好了、还没构建出 .docx 的那几秒，
 *      任务不能没有形态（site.js 同款处理，抄的是它的教训不是它的代码）
 *   3. ⭐**deck / site 任务里躺着的 .docx 是素材不是产物** —— 判错的话，
 *      用户传一份参考文档进来就能把整个演示任务变成 word 任务
 */

let docxBuf;
const tmps = [];

async function mkTask(files) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-docxkind-'));
  tmps.push(d);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(d, name), content);
  }
  return d;
}

beforeAll(async () => {
  docxBuf = await buildDocx(PRESETS['公文'](), [{ t: 'p', style: 'Normal', text: '正文。' }]);
});

afterAll(async () => {
  await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true })));
});

describe('能力位', () => {
  it('docx 不可浏览但可渲染；deck/site 反之', () => {
    expect(can('docx', 'browsable')).toBe(false);
    expect(can('docx', 'renderable')).toBe(true);
    expect(can('deck', 'browsable')).toBe(true);
    expect(can('deck', 'renderable')).toBe(false);
    expect(can('site', 'browsable')).toBe(true);
  });

  it('形态注册表里有 docx', () => {
    expect(Object.keys(KINDS)).toContain('docx');
  });
});

describe('形态判定（权威 = taskManifest；平行的 detectTaskKind 链 2026-08-19 拆除）', () => {
  it('只有 token 源也算 word 任务（构建前的窗口期）', async () => {
    const d = await mkTask({ '文档.json': '{"tokens":{},"content":[]}' });
    const m = await taskManifest(d);
    expect(m.kind).toBe('docx');
    expect(m.artifacts[0].file).toBe('文档.docx');   // 指向将要出现的地方
  });

  it('外来 docx（没有 token 源）照样是 word 任务', async () => {
    const d = await mkTask({});
    await fs.writeFile(path.join(d, '客户合同.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.kind).toBe('docx');
    expect(m.artifacts[0].title).toBe('客户合同');
    expect(m.artifacts[0].sourceFile).toBeNull();    // 没源 = 改它要走手术不是重建
  });

  it('有源时 manifest 报得出源文件名', async () => {
    const d = await mkTask({ '文档.json': '{}' });
    await fs.writeFile(path.join(d, '文档.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.artifacts[0].sourceFile).toBe('文档.json');
  });

  it('⭐deck 任务里的 .docx 不参与形态判定，但照样出卡（2026-08-18 拍板）', async () => {
    const d = await mkTask({ 'canvas.html': '<section data-page="1">x</section>' });
    await fs.writeFile(path.join(d, '参考资料.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.kind).toBe('deck');                     // 垫底：形态还是 deck 说了算
    expect(m.artifacts).toHaveLength(2);             // 但 word 附件不隐身
    expect(m.artifacts[0].kind).toBe('deck');
    expect(m.artifacts[1].kind).toBe('docx');
  });

  it('site 任务同理', async () => {
    const d = await mkTask({ 'index.html': '<p>x</p>' });
    await fs.writeFile(path.join(d, '需求.docx'), docxBuf);
    expect((await taskManifest(d)).kind).toBe('site');
  });

  it('Word 的 ~$ 锁文件不算产物', async () => {
    const d = await mkTask({});
    await fs.writeFile(path.join(d, '~$文档.docx'), 'lock');
    expect(await taskManifest(d)).toBeNull();
  });
});

describe('word 文件夹（2026-08-18：目录型实例，成员 = 多版本）', () => {
  it('⭐子目录顶层有 .docx 且无网页入口 → 一件目录型产物，成员齐全', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '报告'));
    await fs.writeFile(path.join(d, '报告', '文档.docx'), docxBuf);
    await fs.writeFile(path.join(d, '报告', '文档.json'), '{}');
    await fs.writeFile(path.join(d, '报告', '终稿v2.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.artifacts).toHaveLength(1);             // 整个文件夹是一件，不是两件
    const a = m.artifacts[0];
    expect(a.kind).toBe('docx');
    expect(a.root).toBe('报告');                     // 卡即文件夹的认领范围
    expect(a.file).toBe('报告/文档.docx');           // 主成员（默认名排头）
    expect(a.members.map(x => x.file)).toEqual(['报告/文档.docx', '报告/终稿v2.docx']);
    expect(a.members[0].sourceFile).toBe('报告/文档.json');
    expect(a.members[1].sourceFile).toBeNull();
  });

  it('子目录里有 html → 不是 word 文件夹（那是站点/deck 的地盘）', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '官网'));
    await fs.writeFile(path.join(d, '官网', 'index.html'), '<p>x</p>');
    await fs.writeFile(path.join(d, '官网', '需求.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.artifacts.some(a => a.kind === 'docx' && a.root === '官网')).toBe(false);
  });

  it('成员路径能寻址回这件产物（artifactOfPath 认 members）', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '报告'));
    await fs.writeFile(path.join(d, '报告', '文档.docx'), docxBuf);
    await fs.writeFile(path.join(d, '报告', '文档.json'), '{}');
    await fs.writeFile(path.join(d, '报告', 'v2.docx'), docxBuf);
    const m = await taskManifest(d);
    const { artifactOfPath } = await import('./index.js');
    expect(artifactOfPath(m, '报告/v2.docx')?.kind).toBe('docx');
    expect(artifactOfPath(m, '报告/文档.json')?.kind).toBe('docx');
  });

  it('只有 token 源的 word 文件夹也报 pending 产物（声明即意图）', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '公文'));
    await fs.writeFile(path.join(d, '公文', '文档.json'), '{}');
    const m = await taskManifest(d);
    expect(m.artifacts[0].kind).toBe('docx');
    expect(m.artifacts[0].file).toBe('公文/文档.docx');
  });
});

describe('源文件配对自动纠偏（2026-08-19：stem 对不上时的兜底，宁缺勿错）', () => {
  const SRC = JSON.stringify({ preset: '办公标准', content: [{ t: 'p', text: 'x' }] });

  it('纯配对：同 stem 精确 > 版本记号唯一对唯一 > 双方各剩一个', () => {
    // 精确
    expect(pairDocxSources(['a.docx'], ['a.json']).get('a.docx')).toBe('a.json');
    // 版本记号（要带分隔符）
    const m = pairDocxSources(['简历-v2.docx', '简历-v3.docx'], ['文档-v2.json', '文档-v3.json']);
    expect(m.get('简历-v2.docx')).toBe('文档-v2.json');
    expect(m.get('简历-v3.docx')).toBe('文档-v3.json');
    // 裸尾数不算版本（报告2024 撞车风险太高）
    expect(pairDocxSources(['报告2024.docx', '别的.docx'], ['数据2024.json']).get('报告2024.docx')).toBeUndefined();
    // 各剩一个 → 配
    expect(pairDocxSources(['刘万钢-简历-v3.docx'], ['文档-v3.json']).get('刘万钢-简历-v3.docx')).toBe('文档-v3.json');
    // 歧义（两 docx 一源、无版本信号）→ 都不配
    const amb = pairDocxSources(['甲.docx', '乙.docx'], ['源.json']);
    expect(amb.size).toBe(0);
  });

  it('⭐生产实锤形状：文件夹里 docx 与源不同 stem，manifest 也要配得上', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '简历'));
    await fs.writeFile(path.join(d, '简历', '刘万钢-简历-v3.docx'), docxBuf);
    await fs.writeFile(path.join(d, '简历', '文档-v3.json'), SRC);
    const m = await taskManifest(d);
    expect(m.artifacts[0].members[0].sourceFile).toBe('简历/文档-v3.json');
    expect(m.artifacts[0].sourceFile).toBe('简历/文档-v3.json');
  });

  it('不是源形状的 json 不被认走（data.json 躺在旁边）', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '报表'));
    await fs.writeFile(path.join(d, '报表', '季度.docx'), docxBuf);
    await fs.writeFile(path.join(d, '报表', 'data.json'), '{"rows":[1,2,3]}');
    const m = await taskManifest(d);
    expect(m.artifacts[0].members[0].sourceFile).toBeNull();
  });

  it('根层单文件同样兜底', async () => {
    const d = await mkTask({ '排版源.json': SRC });
    await fs.writeFile(path.join(d, '合同终稿.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.artifacts[0].sourceFile).toBe('排版源.json');
  });

  it('同 stem 不读文件也认（pending 半写状态的源不能因为 parse 不过就丢关联）', async () => {
    const d = await mkTask({});
    await fs.mkdir(path.join(d, '公文'));
    await fs.writeFile(path.join(d, '公文', '文档.docx'), docxBuf);
    await fs.writeFile(path.join(d, '公文', '文档.json'), '{ 写到一半的');
    const m = await taskManifest(d);
    expect(m.artifacts[0].members[0].sourceFile).toBe('公文/文档.json');
  });
});

describe('导出格式', () => {
  it('raw 排头（.docx 本身就是交付物），pdf 次之，不给 site/handoff', () => {
    expect(KINDS.docx.exportFormats).toEqual(['raw', 'pdf']);
    expect(formatAllowed('docx', 'raw')).toBe(true);
    expect(formatAllowed('docx', 'pdf')).toBe(true);
    expect(formatAllowed('docx', 'pptx')).toBe(false);
  });
});

describe('describe（每轮注入清单里的那一行）', () => {
  it('有源时提醒改源不改产物', async () => {
    const d = await mkTask({ '文档.json': '{}' });
    await fs.writeFile(path.join(d, '文档.docx'), docxBuf);
    const m = await taskManifest(d);
    const line = await KINDS.docx.describe(d, m.artifacts[0]);
    expect(line).toContain('源 文档.json');
    expect(line).toContain('改源重建');
  });

  it('外来文档说明它没有源', async () => {
    const d = await mkTask({});
    await fs.writeFile(path.join(d, '合同.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(await KINDS.docx.describe(d, m.artifacts[0])).toContain('外来文档');
  });

  it('源在产物没在时说「还没构建」，不报错', async () => {
    const d = await mkTask({ '文档.json': '{}' });
    const m = await taskManifest(d);
    expect(await KINDS.docx.describe(d, m.artifacts[0])).toContain('还没构建');
  });
});
