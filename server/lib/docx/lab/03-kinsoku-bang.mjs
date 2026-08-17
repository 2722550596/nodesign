/**
 * 03-kinsoku-bang.mjs — 用不可压缩标点（！）隔离禁则本体。
 * 期望：临界 k 处，行1 提前收（33字），行2 以「永！」开头 —— 前字被拉下来陪标点。
 * 若出现行2 以「！」开头 = 禁则失效。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildDocx } from '../build.js';
import { presetAcademic } from '../tokens.js';
import { renderDocx, cleanupRender } from '../render.js';

const outdir = process.argv[2] ?? '/tmp/kinsoku-bang';
mkdirSync(outdir, { recursive: true });
const tokens = presetAcademic();

const content = [];
for (let k = 30; k <= 38; k++) {
  content.push({ t: 'p', text: `${'永'.repeat(k)}！${'永'.repeat(60 - k)}`, indent: { firstLineChars: 0 } });
}
const buf = await buildDocx(tokens, content);
const f = join(outdir, 'bang.docx');
writeFileSync(f, buf);
const res = renderDocx(f);
const txt = execFileSync('pdftotext', ['-layout', res.pdf, '-']).toString();
let violations = 0;
for (const ln of txt.split('\n')) {
  const t = ln.trim();
  if (!t) continue;
  if (/^[！。，、；：？]/.test(t)) { violations += 1; console.log('VIOLATION line-start punct:', t.slice(0, 10)); }
  if (t.includes('！')) console.log(`k-line: len=${t.length} bangAt=${t.indexOf('！')}`);
}
console.log(violations === 0 ? 'PASS: 全扫描无行首标点（禁则成立）' : `FAIL: ${violations} 处行首标点`);
cleanupRender(res);
