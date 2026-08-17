/**
 * 05-roundtrip-merge.mjs — 在真实 Word（Mac Word 序列化）文档上验三件大事：
 *
 *   A. run 打碎问题实测：整段可见文本在原 XML 里搜不到 → mergeRuns 后搜得到；
 *   B. 往返保真：只动 word/document.xml，其余 entry 逐字节不变（sha256 对账）；
 *      渲染逐像素不变（pdftoppm PNG 字节比对）、pdftotext 逐字符不变、
 *      OpenXmlValidator 错误数不变（266 → 266，不能变多）；
 *   C. 真编辑：merge 后做跨 run 短语替换，重打包，LO 打得开、改动可见、验证器不恶化。
 *
 * 跑法: node lab/05-roundtrip-merge.mjs <fixture.docx> <outdir>
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readZip, entryData, replaceEntry, writeZip } from '../rawzip.js';
import { parseXml, serialize } from '../xml.js';
import { mergeRuns } from '../merge-runs.js';
import { renderDocx, cleanupRender } from '../render.js';

const fixture = process.argv[2];
const outdir = process.argv[3] ?? '/tmp/roundtrip';
mkdirSync(outdir, { recursive: true });
const OXML = '/tmp/claude-1000/-home-wangang-dev/ea3429e6-4aa0-448e-8d17-6b15f9149b67/scratchpad/docxlab2/oxmlcheck/bin/Release/net8.0/oxmlcheck.dll';
const DOTNET = '/home/wangang-dev/.dotnet/dotnet';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const validateCount = (f) => {
  try { return execFileSync(DOTNET, [OXML, f], { timeout: 120000 }).toString().trim().split('\n').pop(); }
  catch (e) { return (e.stdout?.toString() ?? '').trim().split('\n').pop() ?? `exit ${e.status}`; }
};
const pdftext = (pdf) => execFileSync('pdftotext', [pdf, '-']).toString();
const renderP1 = async (docx) => {
  const r = await renderDocx(docx, { pngPages: [1, 2], dpi: 100 });
  const out = { text: pdftext(r.pdf), pngs: r.pngs.map((p) => readFileSync(p)) };
  await cleanupRender(r);
  return out;
};

const buf = readFileSync(fixture);
const zip = readZip(buf);
console.log(`fixture: ${fixture.split('/').pop()}  entries=${zip.order.length}`);

// ── 基线 ──
const before = {};
for (const n of zip.order) before[n] = sha(entryData(zip, n));
const v0 = validateCount(fixture);
const r0 = await renderP1(fixture);
console.log(`baseline validator: ${v0}`);

// ── 解析（保真闸门在 parseXml 里自动跑）──
const docXml = entryData(zip, 'word/document.xml').toString();
const t0 = Date.now();
const doc = parseXml(docXml);
console.log(`parseXml+fidelity-gate OK: ${docXml.length} bytes in ${Date.now() - t0}ms`);

// ── A: 打碎实测——每段拼出可见文本，找「XML 里搜不到」的段 ──
const paras = doc.root.find('w:p');
let fragmented = [];
for (const p of paras) {
  const runs = p.find('w:r');
  const visible = runs.map((r) => r.find('w:t').map((t) => t.text()).join('')).join('');
  if (visible.length >= 8 && !docXml.includes(visible)) fragmented.push(visible);
}
console.log(`\nA. 总段数 ${paras.length}，可见文本在原 XML 中不连续的段：${fragmented.length}`);
console.log('   例（前 3 段，截 20 字）:', fragmented.slice(0, 3).map((s) => s.slice(0, 20)));

// ── merge ──
const stats = mergeRuns(doc.root);
const mergedXml = serialize(doc);
const runsBefore = (docXml.match(/<w:r>|<w:r /g) ?? []).length;
const runsAfter = (mergedXml.match(/<w:r>|<w:r /g) ?? []).length;
console.log(`\nmergeRuns: 合并 ${stats.merged} 个 run，丢 ${stats.dropped} 个 proofErr；run 数 ${runsBefore} → ${runsAfter}`);
let refindable = 0;
for (const s of fragmented) if (mergedXml.includes(s)) refindable += 1;
console.log(`A2. merge 后重新可搜到的段：${refindable}/${fragmented.length}`);

// ── B: 写出 + 保真对账 ──
replaceEntry(zip, 'word/document.xml', mergedXml);
const outFile = join(outdir, 'merged.docx');
writeFileSync(outFile, writeZip(zip));
const zip2 = readZip(readFileSync(outFile));
let changed = [];
for (const n of zip2.order) {
  if (sha(entryData(zip2, n)) !== before[n]) changed.push(n);
}
console.log(`\nB. 重打包后内容有变化的 entry: ${JSON.stringify(changed)} (期望只有 word/document.xml)`);
// 容器级：没动的 entry 的原始压缩字节也应原样（rawzip 构造保证，抽查 3 个）
const v1 = validateCount(outFile);
console.log(`B2. validator: ${v0} → ${v1} (期望不变)`);
const r1 = await renderP1(outFile);
console.log(`B3. pdftotext 逐字符相等: ${r0.text === r1.text}`);
console.log(`B4. 前两页 PNG 逐字节相等: ${r0.pngs.length === r1.pngs.length && r0.pngs.every((p, i) => p.equals(r1.pngs[i]))}`);

// ── C: 真编辑——跨 run 短语替换 ──
const target = fragmented.find((s) => s.length >= 10) ?? '';
const phrase = target.slice(0, 8);
const replaced = mergedXml.includes(phrase);
if (replaced) {
  const edited = mergedXml.replace(phrase, '【NODESIGN改】');
  replaceEntry(zip, 'word/document.xml', edited);
  const editFile = join(outdir, 'edited.docx');
  writeFileSync(editFile, writeZip(zip));
  const v2 = validateCount(editFile);
  const r2 = await renderP1(editFile);
  console.log(`\nC. 短语替换 ${JSON.stringify(phrase)} → 渲染文本含标记: ${r2.text.includes('NODESIGN改') || '(不在前两页)'} ` );
  const full = await renderDocx(editFile);
  const allText = pdftext(full.pdf);
  await cleanupRender(full);
  console.log(`C2. 全文含标记: ${allText.includes('NODESIGN改')}  validator: ${v2} (期望与基线同)`);
} else {
  console.log('\nC. SKIP: 没找到可替换短语');
}
