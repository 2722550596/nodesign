/**
 * docx.test.js — docx 引擎的密闭单测（不碰 soffice/网络/fixture，秒级）。
 * 大件证据在 lab/ 里（真渲染、真 Word 语料），这里钉住不变量：
 *   - xml.js 保真闸门与增改行为
 *   - rawzip 未动 entry 的字节级保真
 *   - order 排序/体检
 *   - merge-runs 的合并与不合并边界
 *   - build 出的三 preset 过自家 checkOrder + token 校验
 */
import { describe, it, expect } from 'vitest';
import { parseXml, serialize, elem, textNode } from './xml.js';
import { sortChildren, checkOrder } from './order.js';
import { readZip, entryData, replaceEntry, addEntry, writeZip } from './rawzip.js';
import { mergeRuns } from './merge-runs.js';
import { buildStylesXml, buildDocumentXml } from './build.js';
import { PRESETS, validateTokens } from './tokens.js';

const W = 'xmlns:w';

describe('xml 保真', () => {
  it('parse→serialize 逐字节还原（含实体/自闭合/注释/xml:space）', () => {
    const s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
      + '<w:document xmlns:w="x"><w:body><!-- c --><w:p><w:r><w:t xml:space="preserve"> a&amp;b&#8203; </w:t></w:r></w:p><w:sectPr/></w:body></w:document>';
    expect(serialize(parseXml(s))).toBe(s);
  });
  it('拒绝 DTD/未闭合（fail-closed）', () => {
    expect(() => parseXml('<!DOCTYPE x><a/>')).toThrow();
    expect(() => parseXml('<a><b></a>')).toThrow();
  });
  it('没碰的兄弟节点保留原始字节，碰过的规范化', () => {
    const doc = parseXml('<a><b  x = "1"/><c y="2"></c></a>');
    doc.root.childElems('c')[0].setAttr('y', '3');
    expect(serialize(doc)).toBe('<a><b  x = "1"/><c y="3"/></a>');
  });
});

describe('rawzip 保真', () => {
  it('替换一个 entry，其余 entry 原始压缩字节原样拷贝', () => {
    const zip = { entries: new Map(), order: [] };
    addEntry(zip, 'a.xml', '<a/>');
    addEntry(zip, 'b.xml', '<b/>');
    const v1 = writeZip(zip);
    const z2 = readZip(v1);
    const rawA = z2.entries.get('a.xml').locRaw;
    replaceEntry(z2, 'b.xml', '<b2/>');
    const v2 = writeZip(z2);
    const z3 = readZip(v2);
    expect(z3.entries.get('a.xml').locRaw.equals(rawA)).toBe(true);
    expect(entryData(z3, 'b.xml').toString()).toBe('<b2/>');
  });
});

describe('order', () => {
  it('sortChildren 按规范表排；checkOrder 抓乱序', () => {
    const pPr = elem('w:pPr', [], [elem('w:jc', [['w:val', 'center']]), elem('w:spacing', [['w:after', '0']]), elem('w:pStyle', [['w:val', 'a']])]);
    expect(checkOrder(pPr).length).toBeGreaterThan(0);
    sortChildren(pPr);
    expect(pPr.childElems().map((c) => c.name)).toEqual(['w:pStyle', 'w:spacing', 'w:jc']);
    expect(checkOrder(pPr)).toEqual([]);
  });
});

describe('merge-runs', () => {
  const P = (inner) => parseXml(`<w:document xmlns:w="x"><w:body><w:p>${inner}</w:p></w:body></w:document>`);
  const runB = (t) => `<w:r><w:rPr><w:b/></w:rPr><w:t>${t}</w:t></w:r>`;
  it('同格式相邻 run 合并（越过 proofErr 并丢弃），rsid 差异视为同格式', () => {
    const doc = P('<w:r w:rsidR="A"><w:rPr><w:b/></w:rPr><w:t>你好</w:t></w:r>'
      + '<w:proofErr w:type="spellStart"/>'
      + '<w:r w:rsidR="B"><w:rPr><w:b/></w:rPr><w:t>世界</w:t></w:r>');
    const s = mergeRuns(doc.root);
    expect(s.merged).toBe(1);
    expect(serialize(doc)).toContain('<w:t>你好世界</w:t>');
    expect(serialize(doc)).not.toContain('proofErr');
  });
  it('不同格式不合并；bookmark 是硬边界', () => {
    const doc = P(`${runB('a')}<w:r><w:rPr><w:i/></w:rPr><w:t>b</w:t></w:r>`);
    expect(mergeRuns(doc.root).merged).toBe(0);
    const doc2 = P(`${runB('a')}<w:bookmarkStart w:id="0" w:name="x"/>${runB('b')}`);
    expect(mergeRuns(doc2.root).merged).toBe(0);
  });
  it('合并出首尾空白时补 xml:space', () => {
    const doc = P(`${runB('a')}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">b </w:t></w:r>`);
    mergeRuns(doc.root);
    expect(serialize(doc)).toContain('<w:t xml:space="preserve">ab </w:t>');
  });
});

describe('build × 三 preset', () => {
  for (const [name, mk] of Object.entries(PRESETS)) {
    it(`${name}: token 校验通过，styles/document 过 checkOrder`, () => {
      const tokens = mk();
      expect(validateTokens(tokens)).toEqual([]);
      const styles = buildStylesXml(tokens);
      expect(checkOrder(parseXml(styles).root)).toEqual([]);
      const docXml = buildDocumentXml(tokens, [
        { t: 'p', style: 'Normal', text: '正文' },
        { t: 'table', widthsTwip: [4000, 4000], rows: [['甲', '乙']] },
      ]);
      expect(checkOrder(parseXml(docXml).root)).toEqual([]);
    });
  }
  it('firstLineChars 双发：chars + 按有效字号折算的 twip 兜底', () => {
    const tokens = PRESETS.学术论文();
    const xml = buildStylesXml(tokens);
    // Normal 小四=12pt → 2 字符 = 480 twip
    expect(xml).toMatch(/<w:ind w:firstLine="480" w:firstLineChars="200"\/>/);
  });
});
