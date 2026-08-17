/**
 * 10-direct-format-sweep.mjs — 直排格式（direct formatting）的全文扫改。
 *
 * 现实教训（lab/09 查出）：真实世界的 docx（包括 Mac Word 用户文件与 OpenAI
 * 模板）常常 0 个 pStyle——全部直排。改「样式」动不了它们，得扫 document.xml
 * 里的 rPr 直改。本例：把全部深蓝标题字（w:color 1F3A5F）改成红（CC0000），
 * 顺带把这些 run 的 eastAsia 字体改成楷体——覆盖「字体+颜色」两类最常见编辑。
 *
 * 验证：只有 document.xml 变 / 文本一字不差 / validator 不恶化 / 渲染像素确实变了。
 * 跑法: node lab/10-direct-format-sweep.mjs <docx> <outdir>
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readZip, entryData, replaceEntry, writeZip } from '../rawzip.js';
import { parseXml, serialize } from '../xml.js';
import { renderDocx, cleanupRender } from '../render.js';

const src = process.argv[2];
const outdir = process.argv[3];
mkdirSync(outdir, { recursive: true });
const OXML = '/tmp/claude-1000/-home-wangang-dev/ea3429e6-4aa0-448e-8d17-6b15f9149b67/scratchpad/docxlab2/oxmlcheck/bin/Release/net8.0/oxmlcheck.dll';
const DOTNET = '/home/wangang-dev/.dotnet/dotnet';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const vcount = (f) => {
  try { return execFileSync(DOTNET, [OXML, f], { timeout: 120000 }).toString().trim().split('\n').pop(); }
  catch (e) { return (e.stdout?.toString() ?? '').trim().split('\n').pop() ?? 'ERR'; }
};

const buf = readFileSync(src);
const zip = readZip(buf);
const doc = parseXml(entryData(zip, 'word/document.xml').toString());

let hits = 0;
for (const rPr of doc.root.find('w:rPr')) {
  const color = rPr.firstChild('w:color');
  if (color?.attr('w:val') === '1F3A5F') {
    color.setAttr('w:val', 'CC0000');
    const f = rPr.firstChild('w:rFonts');
    if (f) f.setAttr('w:eastAsia', '楷体');
    hits += 1;
  }
}
console.log(`扫改命中 ${hits} 处 rPr`);
replaceEntry(zip, 'word/document.xml', serialize(doc));
const out = join(outdir, 'sweep.docx');
writeFileSync(out, writeZip(zip));

const z1 = readZip(readFileSync(out));
const changed = z1.order.filter((n) => sha(entryData(z1, n)) !== sha(entryData(zip, n) && entryData(readZip(buf), n)));
// 上一行绕了：直接对原 buf 重新读一份干净的
const z0 = readZip(buf);
const changed2 = z1.order.filter((n) => sha(entryData(z1, n)) !== sha(entryData(z0, n)));
console.log(`变更 entry: ${JSON.stringify(changed2)} (期望只有 word/document.xml)`);
console.log(`validator: ${vcount(src)} -> ${vcount(out)}`);

const r0 = await renderDocx(src, { pngPages: [2, 3], dpi: 100 });
const r1 = await renderDocx(out, { pngPages: [2, 3], dpi: 100 });
const t0 = execFileSync('pdftotext', [r0.pdf, '-']).toString();
const t1 = execFileSync('pdftotext', [r1.pdf, '-']).toString();
console.log(`pdftotext 相同: ${t0 === t1}`);
r0.pngs.forEach((p, i) => {
  const same = readFileSync(p).equals(readFileSync(r1.pngs[i]));
  console.log(`第${i + 2}页 PNG 相同: ${same}（期望 false）`);
});
copyFileSync(r1.pngs[0], join(outdir, 'after-p2.png'));
copyFileSync(r0.pngs[0], join(outdir, 'before-p2.png'));
await cleanupRender(r0); await cleanupRender(r1);
