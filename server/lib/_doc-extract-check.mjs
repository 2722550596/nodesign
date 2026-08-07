/**
 * Office 文档抽取的真跑校验。
 *
 * 夹具是**手写的 OOXML**（不是 Office 存出来的），所以刻意把真实文件里会变的
 * 那几处都写进去了：命名空间前缀在不在、`xml:space="preserve"`、共享字符串
 * 下标 vs 内联字符串、纯数字单元格、页号 10 排在 2 后面还是 1 后面。
 * 这些正是"看起来能跑"的实现会栽的地方。
 *
 * 跑法：node server/lib/_doc-extract-check.mjs
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { zipSync, strToU8 } from 'fflate';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-doc-'));
const { extractDocument, isExtractable, MAX_CHARS } = await import('./doc-extract.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const write = async (name, files) => {
  const p = path.join(TMP, name);
  await fs.writeFile(p, Buffer.from(zipSync(Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, strToU8(v)]),
  ))));
  return p;
};

const CT = (over) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${over}</Types>`;

// ── docx（走 mammoth）─────────────────────────────────────────────────
{
  const docx = await write('a.docx', {
    '[Content_Types].xml': CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>季度评审</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">暗号是 </w:t></w:r><w:r><w:t>栀子灯塔七</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`,
  });
  const r = await extractDocument(docx);
  ok('docx 认出来了', r.kind === 'Word 文档', r.kind);
  ok('docx 正文读到了', r.text.includes('季度评审'), r.text.slice(0, 60));
  // 一句话被拆成两个 run 是 Word 的常态（改过格式就会拆），拼不回来就断句
  ok('同一段里拆开的 run 要拼回一句', r.text.includes('暗号是 栀子灯塔七'),
    JSON.stringify(r.text.slice(0, 80)));
  ok('表格单元格也进来了', r.text.includes('甲') && r.text.includes('乙'));
}

// ── xlsx ─────────────────────────────────────────────────────────────
{
  const xlsx = await write('b.xlsx', {
    '[Content_Types].xml': CT(''),
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>
<sheet name="预算" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>项目</t></si><si><t>金额</t></si><si><t xml:space="preserve">场地租赁 </t></si></sst>`,
    // t="s" = 值是共享表下标；没有 t 就是数字字面量；t="inlineStr" 用 <is><t>
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12000</v></c></row>
<row r="3"/>
<row r="4"><c r="A4" t="inlineStr"><is><t>合计</t></is></c><c r="B4"><v>12000</v></c></row>
</sheetData></worksheet>`,
    // 第二张表带命名空间前缀（真实文件里 x: 前缀很常见）
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
  });
  const r = await extractDocument(xlsx);
  ok('xlsx 认出来了', r.kind === 'Excel 表格', r.kind);
  ok('工作表名按顺序对上', r.text.includes('## 工作表：预算') && r.text.includes('## 工作表：备注'),
    r.text.slice(0, 40));
  // 不查共享表的话这里会读成 "0 1"
  ok('共享字符串下标查回了原文', r.text.includes('项目\t金额'), JSON.stringify(r.text.slice(0, 60)));
  ok('数字单元格原样保留', r.text.includes('12000'));
  ok('内联字符串也读得到', r.text.includes('合计'));
  ok('空行不产出空白行', !/\n\n(?![#])/.test(r.text.split('## 工作表：备注')[0].trim()));
  ok('带命名空间前缀的表照样读', r.text.split('## 工作表：备注')[1]?.includes('项目'));
}

// ── pptx ─────────────────────────────────────────────────────────────
{
  const slide = (txts) => `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>${txts.map(t => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
  const files = {
    '[Content_Types].xml': CT(''),
    'ppt/slides/slide1.xml': slide(['封面', '副标题']),
    'ppt/slides/slide2.xml': slide(['第二页要点']),
    'ppt/slides/slide10.xml': slide(['最后一页']),
    'ppt/slides/slide3.xml': `<?xml version="1.0"?><p:sld xmlns:p="x"><p:cSld/></p:sld>`,
  };
  const pptx = await write('c.pptx', files);
  const r = await extractDocument(pptx);
  ok('pptx 认出来了', r.kind === 'PowerPoint 演示文稿', r.kind);
  ok('每页一节', (r.text.match(/## 第 \d+ 页/g) || []).length === 4);
  // 字典序会把 slide10 排到 slide2 前面 —— 这是这类实现最经典的一处错
  const order = (r.text.match(/## 第 (\d+) 页/g) || []).join(',');
  ok('页顺序按数字不按字典序', r.text.indexOf('第二页要点') < r.text.indexOf('最后一页'), order);
  ok('一页里多个文本框都收进来', r.text.includes('封面') && r.text.includes('副标题'));
  ok('空页说一声而不是消失', r.text.includes('(这一页没有文字)'));
}

// ── 边界 ─────────────────────────────────────────────────────────────
{
  ok('认得出能不能抽', isExtractable('a.docx') && isExtractable('/x/B.XLSX') && !isExtractable('a.pdf'));
  let threw = null;
  try { await extractDocument(path.join(TMP, 'a.pdf')); } catch (e) { threw = e; }
  ok('不认识的格式明确报错', threw?.code === 'UNSUPPORTED', threw?.message);

  const broken = path.join(TMP, 'bad.docx');
  await fs.writeFile(broken, 'not a zip at all');
  let threw2 = null;
  try { await extractDocument(broken); } catch (e) { threw2 = e; }
  ok('坏文件抛错而不是返回空字符串', !!threw2, threw2?.message?.slice(0, 40));

  const long = await write('long.pptx', {
    '[Content_Types].xml': CT(''),
    'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><a:t>${'字'.repeat(MAX_CHARS + 500)}</a:t></p:sld>`,
  });
  const r = await extractDocument(long);
  ok('超长截断并说明', r.truncated === true && r.text.length === MAX_CHARS, `${r.text.length} 字`);
  ok('截断了也报真实总长', r.chars > MAX_CHARS);
}

// ── MCP 工具那一层（寻址 + 该拒的要拒）──────────────────────────────
{
  const { makeReadDocumentTool } = await import('../engine/mcp/tools/read-document.js');
  const ws = path.join(TMP, 'ws'); const shared = path.join(TMP, 'shared', 'assets');
  await fs.mkdir(ws, { recursive: true }); await fs.mkdir(shared, { recursive: true });
  await fs.copyFile(path.join(TMP, 'b.xlsx'), path.join(ws, 'in-ws.xlsx'));
  await fs.copyFile(path.join(TMP, 'b.xlsx'), path.join(shared, '需求.xlsx'));

  const t = makeReadDocumentTool({ workspaceRoot: ws, sharedRoot: path.join(TMP, 'shared') });
  const txt = (r) => r.content.map(c => c.text || '').join('\n');

  const a = await t.handler({ path: 'in-ws.xlsx' });
  ok('相对路径先找会话工作区', !a.isError && txt(a).includes('项目'), txt(a).slice(0, 60));

  const b = await t.handler({ path: 'assets/需求.xlsx' });
  ok('工作区没有就找项目共享目录', !b.isError && txt(b).includes('项目'), txt(b).slice(0, 60));

  const c = await t.handler({ path: path.join(TMP, 'c.pptx') });
  ok('绝对路径也认', !c.isError && txt(c).includes('封面'));
  ok('结果开头说清是什么文件多少字', /PowerPoint 演示文稿：c\.pptx · \d+ 字/.test(txt(c)), txt(c).slice(0, 50));

  const d = await t.handler({ path: 'nope.docx' });
  ok('找不到就说找过哪几个地方', d.isError && txt(d).includes('Looked in'), txt(d).slice(0, 60));

  // PDF 走 Read（真跑验过），这里要把人指回去而不是含糊报个错
  await fs.writeFile(path.join(ws, 'x.pdf'), '%PDF-1.4');
  const e = await t.handler({ path: 'x.pdf' });
  ok('PDF 明确指回 Read 工具', e.isError && txt(e).includes('Read'), txt(e).slice(0, 70));

  const f = await t.handler({ path: '' });
  ok('空路径直接拒', f.isError);
}

await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});

if (fails.length) {
  console.error(`\n✗ ${fails.length} 条失败 / ${pass + fails.length} 条：`);
  fails.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`✓ 文档抽取 ${pass}/${pass} 条全过`);
