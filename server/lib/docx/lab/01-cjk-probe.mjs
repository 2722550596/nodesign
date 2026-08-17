/**
 * 01-cjk-probe.mjs — CJK 正确性真跑证明。
 *
 * 验四件事：
 *   A. w:eastAsia 分槽 + fontconfig 替身：pdffonts 里必须出现
 *      NotoSerifCJKsc（宋体）/ NotoSansCJKsc（黑体）/ LXGWWenKai（楷体）
 *      且拉丁文落在 Liberation/Carlito（Times/Calibri 替身）。
 *   B. firstLineChars=200 随字号缩放：16pt 段的首行缩进 ≈ 32pt，
 *      10.5pt 段 ≈ 21pt，比值 ≈ 字号比（用 pdftotext -bbox 量）。
 *   C. 禁则（kinsoku）：同一段标点密集文本，kinsoku 开=行首无 。，；
 *      kinsoku 关（对照组）=出现行首标点 → 证明机制真的在起作用。
 *   D. 着重号 w:em dot 渲染不炸（观感人工看 PNG）。
 *
 * 跑法: node server/lib/docx/lab/01-cjk-probe.mjs <outdir>
 */

import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildDocx } from '../build.js';
import { presetAcademic } from '../tokens.js';
import { renderDocx } from '../render.js';

const outdir = process.argv[2] ?? '/tmp/cjk-probe';
mkdirSync(outdir, { recursive: true });

const tokens = presetAcademic();

// 禁则探针：同字重复 + 单个句号做位置扫描（k=24..50 必有一个正落在行界后一位，
// 关禁则时句号被推到行首；开禁则时被拉回/前字下移 → 两组行首标点计数必然分化）
const kinsokuParas = (cjk) => {
  const out = [];
  for (let k = 24; k <= 50; k++) {
    out.push({ t: 'p', text: `${'永'.repeat(k)}，${'永'.repeat(60 - k)}`, indent: { firstLineChars: 0 }, cjk });
  }
  return out;
};

const content = [
  { t: 'p', style: 'Title', text: '中文排版探针' },
  { t: 'p', style: 'Heading1', text: '一、宋体正文与 Times New Roman 混排 Mixed Latin 123' },
  { t: 'p', text: '这一段是宋体正文，首行缩进两字符，字号小四。The quick brown fox jumps over 懒狗。' },
  { t: 'p', style: 'Quote', text: '这一段是楷体引文，应当渲染成霞鹜文楷的字形。' },
  // B: firstLineChars 缩放对（同文本，不同字号）
  { t: 'p', sizeProbe: 16, runs: [{ text: '甲缩进探针十六磅字号的段落，首行应缩进两个十六磅字宽。', sizePt: 16 }], indent: { firstLineChars: 200 } },
  { t: 'p', sizeProbe: 10.5, runs: [{ text: '乙缩进探针十点五磅字号的段落，首行应缩进两个十点五磅字宽。', sizePt: 10.5 }], indent: { firstLineChars: 200 } },
  // C: 禁则开关对照（位置扫描）
  { t: 'p', style: 'Heading1', text: '二、禁则开（治疗组）' },
  ...kinsokuParas(undefined),
  { t: 'p', style: 'Heading1', text: '三、禁则关（对照组）' },
  ...kinsokuParas({ kinsoku: false, overflowPunct: false, adjustRightInd: false }),
  // D: 着重号
  { t: 'p', runs: ['句子里', { text: '这四个字', em: 'dot' }, '带着重号。'] },
];

const buf = await buildDocx(tokens, content, {
  footer: [{ t: 'p', style: 'Footer', runs: [{ text: '- ' }, { fld: 'PAGE' }, { text: ' -' }] }],
});
const docx = join(outdir, 'cjk-probe.docx');
writeFileSync(docx, buf);
console.log('built', docx, buf.length, 'bytes');

const res = await renderDocx(docx, { pngPages: true, dpi: 120 });
console.log(`render ${res.ms}ms ->`, res.pdf);
copyFileSync(res.pdf, join(outdir, 'cjk-probe.pdf'));
for (const p of res.pngs) copyFileSync(p, join(outdir, p.split('/').pop()));

// ── A: pdffonts ──
console.log('\n== pdffonts ==');
console.log(execFileSync('pdffonts', [res.pdf]).toString());

// ── B: 首行缩进测量（bbox） ──
const bbox = execFileSync('pdftotext', ['-bbox', res.pdf, '-']).toString();
// 抓探针段第一行的第一个词的 xMin，与页面正文左缘（同段第二行 xMin）比
function firstWordX(marker) {
  const re = new RegExp(`<word xMin="([\\d.]+)"[^>]*>[^<]*${marker}`);
  const m = bbox.match(re);
  return m ? parseFloat(m[1]) : null;
}
const xA = firstWordX('甲缩进探针');
const xB = firstWordX('乙缩进探针');
// 正文左缘：拿 Heading1「一、宋体正文」那行的 xMin 当页边基准（无缩进段落）
const xBase = firstWordX('一、宋体正文');
console.log('== firstLineChars 缩放 ==');
console.log(`左缘基准 x=${xBase}  16pt 段 x=${xA} (缩进 ${(xA - xBase).toFixed(1)}pt, 期望≈32)  `
  + `10.5pt 段 x=${xB} (缩进 ${(xB - xBase).toFixed(1)}pt, 期望≈21)`);
console.log(`缩进比 ${( (xA - xBase) / (xB - xBase)).toFixed(3)} vs 字号比 ${(16 / 10.5).toFixed(3)}`);

// ── C: 禁则 ──
const lines = execFileSync('pdftotext', ['-layout', res.pdf, '-']).toString().split('\n');
const bad = [];
let section = '';
for (const ln of lines) {
  const t = ln.trimStart();
  if (t.startsWith('二、')) section = 'on';
  else if (t.startsWith('三、')) section = 'off';
  else if (t && /^[。，、；：！？]/.test(t)) bad.push([section, t.slice(0, 12)]);
}
console.log('== 禁则 ==');
console.log('行首标点出现位置:', JSON.stringify(bad));
console.log(bad.some(([s]) => s === 'off') && !bad.some(([s]) => s === 'on')
  ? 'PASS: 开=无行首标点, 关=有 (机制已证)'
  : bad.length === 0 ? 'INCONCLUSIVE: 对照组也没触发（换更极端文本）' : 'CHECK MANUALLY');
console.log('\nscratch:', res.scratch);
