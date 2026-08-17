/**
 * 12-gongwen-sample.mjs — 公文体（GB/T 9704-2012）全须全尾样张 + 版式量测。
 *   - 红头/红线/发文字号/标题/主送/三级结构/附件/落款/版记
 *   - 量测：正文页行数（GB 要求 22 行/页，固定 28pt 行距）
 *   - pdffonts 确认黑体/楷体/仿宋（替身）都被分派到位
 * 跑法: node lab/12-gongwen-sample.mjs <outdir>
 */
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildDocx } from '../build.js';
import { presetGongwen } from '../tokens.js';
import { renderDocx, cleanupRender } from '../render.js';

const outdir = process.argv[2] ?? '/tmp/gongwen';
mkdirSync(outdir, { recursive: true });
const tokens = presetGongwen();

const body = (s) => ({ t: 'p', text: s });
const content = [
  { t: 'p', style: 'Hongtou', text: '虚构市人民政府办公室文件' },
  // 红线（段落下边框，2.25pt 红）
  { t: 'p', style: 'Fawenzihao', text: '', borders: { bottom: { style: 'single', sizePt8: 18, color: 'FF0000', spacePt: 1 } }, indent: { firstLineChars: 0 } },
  { t: 'p', style: 'Fawenzihao', text: '虚府办发〔2026〕12 号' },
  { t: 'p', style: 'GwTitle', text: '虚构市人民政府办公室关于推进政务文档数字化工作的通知' },
  { t: 'p', text: '各区县人民政府，市政府各部门：', indent: { firstLineChars: 0 } },
  body('为深入推进政务文档数字化建设，提升公文处理效率，经市政府同意，现将有关事项通知如下。'),
  { t: 'p', style: 'GwH1', text: '一、总体要求' },
  body('坚持统一规范、安全可控、注重实效的原则，推动全市政务文档格式标准化。各单位要充分认识文档数字化的重要意义，将其纳入年度重点工作安排，明确责任分工，确保各项任务落到实处，并于规定时限内完成系统对接与数据迁移，同时建立长效机制。'),
  { t: 'p', style: 'GwH2', text: '（一）统一格式标准' },
  body('全市各级机关公文一律执行 GB/T 9704-2012 标准版式，正文使用三号仿宋字，行距固定二十八磅，每页二十二行，版心之外不得随意书写内容。'),
  { t: 'p', style: 'GwH2', text: '（二）规范流转程序' },
  body('公文起草、审核、签发、归档各环节均应在数字化系统内完成，留痕可溯。各单位办公室负责本单位公文格式的一致性检查，重点核对字体、字号、行距与页边距四项硬指标，发现不符的一律退回重排，并将检查情况按季度汇总报送市政府办公室备案。'),
  { t: 'p', style: 'GwH1', text: '二、保障措施' },
  body('市财政局要保障专项经费，市大数据局负责平台运维。各区县要结合实际制定实施细则，于本通知印发之日起三十日内报市政府办公室备案。对工作推进不力、影响整体进度的单位，予以通报。'),
  body('本通知自印发之日起施行，有效期五年。'),
  { t: 'p', text: '附件：1. 政务文档格式检查要点', indent: { firstLineChars: 0 } },
  { t: 'p', text: '　　　2. 系统对接时间安排表', indent: { firstLineChars: 0 } },
  { t: 'p', text: '虚构市人民政府办公室', align: 'right', indent: { rightChars: 200, firstLineChars: 0 } },
  { t: 'p', text: '二〇二六年八月十七日', align: 'right', indent: { rightChars: 200, firstLineChars: 0 } },
  { t: 'p', style: 'Chaosong', text: '抄送：市委各部门，市人大常委会办公室，市政协办公室。', borders: { top: { style: 'single', sizePt8: 6, color: '000000' }, bottom: { style: 'single', sizePt8: 6, color: '000000' } } },
];

const buf = await buildDocx(tokens, content, {
  footer: [{ t: 'p', style: 'Footer', runs: [{ text: '— ' }, { fld: 'PAGE' }, { text: ' —' }] }],
});
const f = join(outdir, 'gongwen.docx');
writeFileSync(f, buf);
console.log('built', f);

const res = await renderDocx(f, { pngPages: true, dpi: 120 });
for (const p of res.pngs) copyFileSync(p, join(outdir, p.split('/').pop()));
copyFileSync(res.pdf, join(outdir, 'gongwen.pdf'));
console.log(execFileSync('pdffonts', [res.pdf]).toString());

// 行距量测：数正文页每页的文本行 y 坐标（bbox），行距应为 28pt，版心行数 ≤22
const bbox = execFileSync('pdftotext', ['-bbox', res.pdf, '-']).toString();
const ys = [...bbox.matchAll(/<word xMin="[\d.]+" yMin="([\d.]+)"/g)].map((m) => parseFloat(m[1]));
const uniq = [...new Set(ys.map((y) => Math.round(y)))].sort((a, b) => a - b);
const gaps = uniq.slice(1).map((y, i) => y - uniq[i]).filter((g) => g > 5);
const modeGap = gaps.sort((a, b) => gaps.filter((x) => x === b).length - gaps.filter((x) => x === a).length)[0];
console.log(`第一页文本行数=${uniq.length} 常见行距=${modeGap}pt (期望 28)`);
console.log('scratch:', res.scratch);
