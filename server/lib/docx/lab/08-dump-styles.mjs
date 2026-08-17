/**
 * 08-dump-styles.mjs — 外来 styles.xml 反解成 token JSON，三个序列化家族：
 *   Mac Word（用户上传）/ OpenAI 模板（含主题字体引用）/ LO 转存（先造）。
 * 输出：每份的覆盖率统计 + token JSON 落盘。
 * 跑法: node lab/08-dump-styles.mjs <fixturesdir> <outdir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpStyles } from '../dump-styles.js';
import { FONTCONF } from '../render.js';

const fixtures = process.argv[2];
const outdir = process.argv[3];
mkdirSync(outdir, { recursive: true });

// 造 LO 转存变体（第三个序列化家族）
const loVariant = join(fixtures, 'lo-resaved-ode.docx');
if (!existsSync(loVariant)) {
  const scratch = mkdtempSync(join(tmpdir(), 'loconv-'));
  mkdirSync(join(scratch, 'src'), { recursive: true });
  execFileSync('cp', [join(fixtures, 'macword-ode.docx'), join(scratch, 'src', 'in.docx')]);
  execFileSync('soffice', [`-env:UserInstallation=file://${scratch}/p`, '--headless',
    '--convert-to', 'docx', '--outdir', scratch, join(scratch, 'src', 'in.docx')],
  { env: { ...process.env, HOME: scratch, FONTCONFIG_FILE: FONTCONF }, timeout: 120000 });
  execFileSync('cp', [join(scratch, 'in.docx'), loVariant]);
}

for (const name of ['macword-ode.docx', 'oa-legal.docx', 'oa-design.docx', 'lo-resaved-ode.docx']) {
  const f = join(fixtures, name);
  if (!existsSync(f)) { console.log(`${name}: MISSING`); continue; }
  try {
    const { tokens, stat } = dumpStyles(readFileSync(f));
    const out = join(outdir, name.replace('.docx', '.tokens.json'));
    writeFileSync(out, JSON.stringify(tokens, null, 1));
    const nExtra = Object.values(tokens.styles).filter((s) => s.extraXml?.length).length;
    console.log(`${name}: styles=${stat.styles} rawStyles=${stat.raw} extraFragments=${stat.extraFragments} (在 ${nExtra} 个 style 里)`);
    console.log(`  base: font=${JSON.stringify(tokens.fonts?.body)} sizePt=${tokens.base?.sizePt} lang=${JSON.stringify(tokens.lang)}`);
    console.log(`  page: ${JSON.stringify(tokens.page)}`);
    const sample = Object.entries(tokens.styles).find(([id]) => /^(Heading1|heading1|Ttulo1|1)$/i.test(id))
      ?? Object.entries(tokens.styles)[1];
    if (sample) console.log(`  样例 style ${sample[0]}: ${JSON.stringify(sample[1]).slice(0, 300)}`);
  } catch (e) {
    console.log(`${name}: FAILED ${e.message.slice(0, 120)}`);
  }
}
