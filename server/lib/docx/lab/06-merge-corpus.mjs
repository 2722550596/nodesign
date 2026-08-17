/**
 * 06-merge-corpus.mjs — 对一组真实 Word 文件跑 mergeRuns，输出每份的
 * 合并统计 + 保真校验（pdftotext 前后一致 + validator 不恶化 + 未动 entry sha 不变）。
 * 跑法: node lab/06-merge-corpus.mjs <dir-with-docx> <outdir>
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readZip, entryData, replaceEntry, writeZip } from '../rawzip.js';
import { parseXml, serialize } from '../xml.js';
import { mergeRuns } from '../merge-runs.js';
import { renderDocx, cleanupRender } from '../render.js';

const dir = process.argv[2];
const outdir = process.argv[3];
mkdirSync(outdir, { recursive: true });
const OXML = '/tmp/claude-1000/-home-wangang-dev/ea3429e6-4aa0-448e-8d17-6b15f9149b67/scratchpad/docxlab2/oxmlcheck/bin/Release/net8.0/oxmlcheck.dll';
const DOTNET = '/home/wangang-dev/.dotnet/dotnet';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const vcount = (f) => {
  try { return execFileSync(DOTNET, [OXML, f], { timeout: 120000 }).toString().trim().split('\n').pop(); }
  catch (e) { return (e.stdout?.toString() ?? '').trim().split('\n').pop() ?? 'ERR'; }
};

for (const name of readdirSync(dir).filter((f) => f.endsWith('.docx')).sort()) {
  const src = join(dir, name);
  try {
    const zip = readZip(readFileSync(src));
    const xml = entryData(zip, 'word/document.xml').toString();
    const doc = parseXml(xml);
    const before = {};
    for (const n of zip.order) before[n] = sha(entryData(zip, n));
    const stats = mergeRuns(doc.root);
    if (stats.merged === 0) { console.log(`${name}: merged=0`); continue; }
    const merged = serialize(doc);
    replaceEntry(zip, 'word/document.xml', merged);
    const out = join(outdir, name);
    writeFileSync(out, writeZip(zip));
    // 保真三件套
    const zip2 = readZip(readFileSync(out));
    const changed = zip2.order.filter((n) => sha(entryData(zip2, n)) !== before[n]);
    let textSame = null;
    try {
      const r0 = await renderDocx(src); const t0 = execFileSync('pdftotext', [r0.pdf, '-']).toString(); await cleanupRender(r0);
      const r1 = await renderDocx(out); const t1 = execFileSync('pdftotext', [r1.pdf, '-']).toString(); await cleanupRender(r1);
      textSame = t0 === t1;
    } catch { textSame = 'render-failed'; }
    const v0 = vcount(src); const v1 = vcount(out);
    console.log(`${name}: merged=${stats.merged} proofErrDropped=${stats.dropped} `
      + `changedEntries=${JSON.stringify(changed)} textSame=${textSame} validator ${v0} -> ${v1}`);
  } catch (e) {
    console.log(`${name}: SKIP (${e.message.slice(0, 80)})`);
  }
}
