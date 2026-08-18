// 自动编号（2026-08-18）。这一版之前 `para.list` 会产出**指向空处的 numId**，
// Word 打开可能直接报文档损坏 —— 所以测试要钉的不只是"能产出 XML"，
// 还有"引用完整性"和"三处登记要么全有要么全没有"。
import { describe, it, expect } from 'vitest';
import { buildNumberingXml, numIdMap, validateNumbering, NUM_PRESETS } from './numbering.js';
import { buildDocx } from './build.js';
import { PRESETS, validateTokens } from './tokens.js';
import { readZip, entryData } from './rawzip.js';

// ⚠️ 别拿 buf.toString() 去搜 —— [Content_Types].xml 和 rels 在 zip 里是 deflate
// 过的，raw buffer 里只有**文件名**是明文。第一版断言就是这么写错的：功能是对的，
// 测试在骗自己。真解压才算查过。
const partOf = (buf, name) => entryData(readZip(buf), name).toString('utf8');

const baseTokens = () => PRESETS['办公标准']();

describe('numbering.xml 产出', () => {
  it('没有编号定义时不产这个 part（空的合法但毫无意义）', () => {
    expect(buildNumberingXml(undefined)).toBeNull();
    expect(buildNumberingXml({})).toBeNull();
  });

  it('内置梯队产出 abstractNum + num 成对，numId 从 1 起且顺序稳定', () => {
    const xml = buildNumberingXml({ 甲: '公文条款', 乙: '圈码' });
    expect(xml).toMatch(/<w:abstractNum w:abstractNumId="1"/);
    expect(xml).toMatch(/<w:abstractNum w:abstractNumId="2"/);
    expect(xml).toMatch(/<w:num w:numId="1"><w:abstractNumId w:val="1"\/><\/w:num>/);
    const ids = numIdMap({ 甲: '公文条款', 乙: '圈码' });
    expect([...ids]).toEqual([['甲', 1], ['乙', 2]]);
  });

  it('⭐ 公文梯队用首行缩进 + suff:nothing（中文编号后面不该再加间隔）', () => {
    const xml = buildNumberingXml({ 条款: '公文条款' });
    expect(xml).toMatch(/<w:suff w:val="nothing"\/>/);
    expect(xml).toMatch(/<w:ind w:left="0" w:firstLine="480"\/>/);
    expect(xml).toMatch(/w:val="chineseCounting"/);
  });

  it('技术梯队用悬挂缩进（折行要对齐到文字起点）', () => {
    const xml = buildNumberingXml({ t: '数字条款' });
    expect(xml).toMatch(/<w:ind w:left="360" w:hanging="360"\/>/);
    expect(xml).toMatch(/<w:lvlText w:val="%1\.%2"\/>/);
  });

  it('自定义 levels 照收', () => {
    const xml = buildNumberingXml({ x: { levels: [{ fmt: 'ideographTraditional', text: '%1、', indent: 1 }] } });
    expect(xml).toMatch(/w:val="ideographTraditional"/);
  });
});

describe('校验（拦的是"写了会坏"而不是"写了没生效"）', () => {
  it('内置梯队名写错 → 报错并列出可选', () => {
    const e = validateNumbering({ x: '公文体' });
    expect(e[0]).toMatch(/unknown numbering preset/);
    expect(e[0]).toMatch(/公文条款/);
  });
  it('fmt 不在支持列表里 → 拒', () => {
    expect(validateNumbering({ x: { levels: [{ fmt: 'aiueoFullWidth', text: '%1.' }] } })[0])
      .toMatch(/不在支持的编号格式里/);
  });
  it('⭐ 非 bullet 的 text 里没有 %N → 拒（编号值根本不会出现在文档里）', () => {
    expect(validateNumbering({ x: { levels: [{ fmt: 'decimal', text: '一、' }] } })[0])
      .toMatch(/没有 %N 占位符/);
  });
  it('bullet 不需要 %N', () => {
    expect(validateNumbering({ x: { levels: [{ fmt: 'bullet', text: '●' }] } })).toEqual([]);
  });
  it('⭐ 引用一个不存在的编号名 → 拒（以前会产出悬空 numId）', () => {
    const tok = baseTokens();
    tok.styles.X = { type: 'paragraph', name: 'X', para: { list: { name: '没定义过' } } };
    expect(validateTokens(tok).join('\n')).toMatch(/没有名为 '没定义过' 的编号定义/);
  });
  it('引用对得上就放行', () => {
    const tok = baseTokens();
    tok.numbering = { 条款: '公文条款' };
    tok.styles.X = { type: 'paragraph', name: 'X', para: { list: '条款' } };
    expect(validateTokens(tok)).toEqual([]);
  });
});

describe('容器登记（三处要么全有要么全没有）', () => {
  it('有编号 → part / content-type / rel 三处齐全', async () => {
    const tok = baseTokens();
    tok.numbering = { 条款: '公文条款' };
    const buf = await buildDocx(tok, [{ t: 'p', style: 'Normal', text: 'x', list: '条款' }], {});
    expect(readZip(buf).order).toContain('word/numbering.xml');
    expect(partOf(buf, '[Content_Types].xml')).toMatch(/wordprocessingml\.numbering\+xml/);
    expect(partOf(buf, 'word/_rels/document.xml.rels')).toMatch(/relationships\/numbering/);
    expect(partOf(buf, 'word/numbering.xml')).toMatch(/chineseCounting/);
  });

  it('没有编号 → 三处都不出现（声明了 rel 却没有 part 是 Word 硬报错）', async () => {
    const buf = await buildDocx(baseTokens(), [{ t: 'p', style: 'Normal', text: 'x' }], {});
    expect(readZip(buf).order).not.toContain('word/numbering.xml');
    expect(partOf(buf, '[Content_Types].xml')).not.toMatch(/numbering/);
    expect(partOf(buf, 'word/_rels/document.xml.rels')).not.toMatch(/numbering/);
  });

  it('段落引用编号 → document.xml 里有 numPr 且 numId 对得上名字', async () => {
    const tok = baseTokens();
    tok.numbering = { 甲: '圈码', 乙: '公文条款' };
    const buf = await buildDocx(tok, [{ t: 'p', style: 'Normal', text: 'x', list: { name: '乙', ilvl: 1 } }], {});
    // 乙 是第二个 → numId 2；ilvl 1
    expect(partOf(buf, 'word/document.xml'))
      .toMatch(/<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="2"\/><\/w:numPr>/);
  });

  it('build 时引用不存在的名字 → 抛错，不产悬空 numId', async () => {
    await expect(buildDocx(baseTokens(), [{ t: 'p', text: 'x', list: '无' }], {}))
      .rejects.toThrow(/没有名为 '无' 的编号定义/);
  });
});
