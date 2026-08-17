/**
 * 09-style-surgery.mjs — 编辑外来 docx 的推荐路线实证：
 * dump 出 token → 改一个值 → 以「定点手术」写回（不整重建）。
 * 本例：把 Heading1 的颜色改成红色、字号加大 —— 然后验证：
 *   - 只有 word/styles.xml 变了（其余 entry sha 不变）
 *   - validator 错误数不恶化
 *   - 渲染出的第一页像素确实变了（标题变红）而正文文本一字不差
 * 跑法: node lab/09-style-surgery.mjs <docx> <outdir>
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readZip, entryData } from '../rawzip.js';
import { dumpStyles, applyStyleEdit } from '../dump-styles.js';
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
const { tokens } = dumpStyles(buf);
console.log('dump: Heading1 =', JSON.stringify(tokens.styles.Heading1?.run));

// 改 token（象征「用户在 token 层改样式」）→ 手术回写
const edited = applyStyleEdit(buf, 'Heading1', { run: { color: 'CC0000', sizePt: 22 } });
const out = join(outdir, 'surgery.docx');
writeFileSync(out, edited);

// 只有 styles.xml 变
const z0 = readZip(buf); const z1 = readZip(edited);
const changed = z1.order.filter((n) => sha(entryData(z1, n)) !== sha(entryData(z0, n)));
console.log(`变更 entry: ${JSON.stringify(changed)} (期望只有 word/styles.xml)`);

// validator 前后
console.log(`validator: ${vcount(src)} -> ${vcount(out)}`);

// 渲染对比
const r0 = await renderDocx(src, { pngPages: [2, 2], dpi: 100 });
const r1 = await renderDocx(out, { pngPages: [2, 2], dpi: 100 });
const t0 = execFileSync('pdftotext', [r0.pdf, '-']).toString();
const t1 = execFileSync('pdftotext', [r1.pdf, '-']).toString();
console.log(`pdftotext 相同: ${t0 === t1}（样式手术不应动文本）`);
const p0 = readFileSync(r0.pngs[0]); const p1 = readFileSync(r1.pngs[0]);
console.log(`第2页 PNG 相同: ${p0.equals(p1)}（期望 false——标题确实变了）`);
copyFileSync(r0.pngs[0], join(outdir, 'before-p2.png'));
copyFileSync(r1.pngs[0], join(outdir, 'after-p2.png'));
// 二次 dump 验证 token 层读得回改动
const { tokens: t2 } = dumpStyles(edited);
console.log('再 dump: Heading1 =', JSON.stringify(t2.styles.Heading1?.run));
await cleanupRender(r0); await cleanupRender(r1);
