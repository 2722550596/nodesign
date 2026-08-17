/**
 * 04-validate-order.mjs — 元素顺序真跑证明。
 *
 * 1) 三个 preset 各造一份带表格/页眉页脚/着重号/边框的 docx，
 *    过 OpenXmlValidator (Office2019) 必须 0 错——证明规范序列化器正确。
 * 2) 负对照：把一份好文档的 pPr 里 w:jc 挪到 w:spacing 前面（顺序犯规），
 *    SDK 验证器必须报错，我们自己的 checkOrder() 也必须抓到同一处——
 *    证明量具有效 + 我们的顺序表和 SDK 一致。
 * 3) 全部文档 LO 都能打开渲染（顺带证明 LO 宽容 ≠ 能当顺序量具）。
 *
 * 跑法: node lab/04-validate-order.mjs <outdir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildDocx } from '../build.js';
import { PRESETS } from '../tokens.js';
import { renderDocx, cleanupRender } from '../render.js';
import { readZip, entryData, replaceEntry, writeZip } from '../rawzip.js';
import { parseXml, serialize } from '../xml.js';
import { checkOrder } from '../order.js';

const outdir = process.argv[2] ?? '/tmp/order-lab';
mkdirSync(outdir, { recursive: true });
const OXML = '/tmp/claude-1000/-home-wangang-dev/ea3429e6-4aa0-448e-8d17-6b15f9149b67/scratchpad/docxlab2/oxmlcheck/bin/Release/net8.0/oxmlcheck.dll';
const DOTNET = '/home/wangang-dev/.dotnet/dotnet';

const validate = (f) => {
  try {
    return execFileSync(DOTNET, [OXML, f], { timeout: 60000 }).toString().trim().split('\n').pop();
  } catch (e) {
    return (e.stdout?.toString() ?? '').trim().split('\n').slice(-3).join(' | ') || `exit ${e.status}`;
  }
};

const content = (name) => [
  { t: 'p', style: 'Title', text: `${name} 全要素样张` },
  { t: 'p', style: 'Heading1', text: '一、正文与表格' },
  { t: 'p', text: '正文段落，首行缩进两字符，中西文混排 test 123。' },
  {
    t: 'table', widthsTwip: [2500, 3500, 2500],
    rows: [
      [{ text: '列一', shading: 'EEEEEE' }, { text: '列二', shading: 'EEEEEE' }, { text: '列三', shading: 'EEEEEE' }],
      ['数据甲', '数据乙', '数据丙'],
    ],
  },
  { t: 'p', style: 'Heading2' in PRESETS ? 'Heading2' : 'Heading1', text: '二、修饰' },
  { t: 'p', runs: ['带', { text: '着重号', em: 'dot' }, '与', { text: '下划线', underline: true }, '和', { text: '红字', color: 'CC0000' }, '。'] },
  { t: 'p', style: 'Quote', text: '引文段：楷体或本体族的引用样式。' },
  { t: 'pageBreak' },
  { t: 'p', text: '第二页，验证页脚页码。' },
];

let fail = 0;
const made = [];
for (const [name, mk] of Object.entries(PRESETS)) {
  const tokens = mk();
  const has = (s) => tokens.styles[s] ? s : 'Normal';
  const c = content(name).map((b) => b.style && !tokens.styles[b.style] ? { ...b, style: has('Heading1') } : b);
  const buf = await buildDocx(tokens, c, {
    footer: [{ t: 'p', style: has('Footer'), runs: [{ text: '- ' }, { fld: 'PAGE' }, { text: ' -' }] }],
    header: [{ t: 'p', style: has('Header'), text: `Nodesign ${name}` }],
  });
  const f = join(outdir, `${name}.docx`);
  writeFileSync(f, buf);
  const v = validate(f);
  const ok = v.includes('VALID (0');
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${v}`);
  made.push(f);
}

// ── 负对照：顺序犯规 ──
const zip = readZip(await import('node:fs').then((m) => m.promises.readFile(made[0])));
const docXml = entryData(zip, 'word/styles.xml').toString();
// 把某个风格 pPr 里的 <w:jc/> 挪到 <w:spacing/> 前面（犯规：jc 排在 spacing 之后才合法）
const broken = docXml.replace(
  /(<w:spacing [^/]*\/>)((?:<w:ind [^/]*\/>)?)(<w:jc w:val="center"\/>)/,
  '$3$1$2',
);
if (broken === docXml) { console.log('SKIP: 没找到可挪的 w:jc'); process.exit(1); }
replaceEntry(zip, 'word/styles.xml', broken);
const badFile = join(outdir, 'broken-order.docx');
writeFileSync(badFile, writeZip(zip));
const vBad = validate(badFile);
const sdkCaught = !vBad.includes('VALID (0');
console.log(`${sdkCaught ? 'PASS' : 'FAIL'} 负对照(SDK): ${vBad}`);

// 我们自己的 checkOrder 也要抓到
const doc = parseXml(broken);
const viol = checkOrder(doc.root);
console.log(`${viol.length ? 'PASS' : 'FAIL'} 负对照(checkOrder): ${viol.length} 处违规`, viol.slice(0, 2));

// 好文档 checkOrder 必须干净
const good = parseXml(docXml);
const violGood = checkOrder(good.root);
console.log(`${violGood.length === 0 ? 'PASS' : 'FAIL'} 好文档(checkOrder): ${violGood.length} 处违规`, violGood.slice(0, 3));

// ── LO 全部能开（宽容性对照） ──
for (const f of [...made, badFile]) {
  try {
    const r = renderDocx(f);
    console.log(`LO opens ${f.split('/').pop()} (${r.ms}ms)`);
    cleanupRender(r);
  } catch (e) { console.log(`LO FAILED on ${f}: ${e.message}`); fail += 1; }
}
process.exit(fail);
