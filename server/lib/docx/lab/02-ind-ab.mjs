/**
 * 02-ind-ab.mjs — w:firstLineChars 的 LO 兼容 A/B。
 * A: 只有 firstLineChars（Word 语义正确，LO 25.2 疑似无视）
 * B: firstLineChars + 计算出的 firstLine 兜底（Word 里 chars 优先，LO 用 twip）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildDocx } from '../build.js';
import { presetAcademic } from '../tokens.js';
import { renderDocx, cleanupRender } from '../render.js';

const outdir = process.argv[2] ?? '/tmp/ind-ab';
mkdirSync(outdir, { recursive: true });
const tokens = presetAcademic();
tokens.styles.Normal.para.indent = {};   // 关掉 Normal 的缩进，隔离变量

const mk = async (name, indent) => {
  const buf = await buildDocx(tokens, [
    { t: 'p', text: '基准行顶格从页边开始往右写足够长足够长足够长。', indent: {} },
    { t: 'p', runs: [{ text: '丙探针十六磅段落的首行看这里。', sizePt: 16 }], indent },
  ]);
  const f = join(outdir, name);
  writeFileSync(f, buf);
  const res = renderDocx(f);
  const bbox = execFileSync('pdftotext', ['-bbox', res.pdf, '-']).toString();
  const x = (m) => parseFloat((bbox.match(new RegExp(`<word xMin="([\\d.]+)"[^>]*>[^<]*${m}`)) ?? [])[1]);
  console.log(`${name}: 基准x=${x('基准行')}  探针x=${x('丙探针')}  缩进=${(x('丙探针') - x('基准行')).toFixed(1)}pt (期望 32)`);
  cleanupRender(res);
};

await mk('a-chars-only.docx', { firstLineChars: 200 });
await mk('b-chars-plus-twip.docx', { firstLineChars: 200, firstLineTwip: 640 });  // 2×16pt=32pt=640twip
