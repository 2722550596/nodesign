import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { detectTaskKind, taskManifest, can, KINDS, formatAllowed } from './index.js';
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

describe('detect 判定', () => {
  it('只有 token 源也算 word 任务（构建前的窗口期）', async () => {
    const d = await mkTask({ '文档.json': '{"tokens":{},"content":[]}' });
    expect(await detectTaskKind(d)).toBe('docx');
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

  it('⭐deck 任务里的 .docx 是素材，不能把任务判成 word，也不占产物卡', async () => {
    const d = await mkTask({ 'canvas.html': '<section data-page="1">x</section>' });
    await fs.writeFile(path.join(d, '参考资料.docx'), docxBuf);
    const m = await taskManifest(d);
    expect(m.kind).toBe('deck');
    expect(m.artifacts).toHaveLength(1);
    expect(m.artifacts[0].kind).toBe('deck');
  });

  it('site 任务同理', async () => {
    const d = await mkTask({ 'index.html': '<p>x</p>' });
    await fs.writeFile(path.join(d, '需求.docx'), docxBuf);
    expect((await taskManifest(d)).kind).toBe('site');
  });

  it('Word 的 ~$ 锁文件不算产物', async () => {
    const d = await mkTask({});
    await fs.writeFile(path.join(d, '~$文档.docx'), 'lock');
    expect(await detectTaskKind(d)).toBeNull();
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
