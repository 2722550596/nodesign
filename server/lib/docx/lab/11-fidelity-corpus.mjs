/**
 * 11-fidelity-corpus.mjs — 保真解析器全语料闸门测试：
 * 对每个 fixture 的**每个 XML part** 跑 parseXml（内含 serialize==input 自检）。
 * 任何一个 part 过不了闸门 = 那份文件我们会拒绝手术（fail-closed），
 * 这里统计闸门通过率，回答「这个自检策略在真实世界能用吗」。
 * 跑法: node lab/11-fidelity-corpus.mjs <dir> [dir2...]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readZip, entryData } from '../rawzip.js';
import { parseXml } from '../xml.js';

let files = 0; let parts = 0; let passed = 0;
const failures = [];
for (const dir of process.argv.slice(2)) {
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (!name.endsWith('.docx') || !statSync(f).isFile()) continue;
    files += 1;
    let zip;
    try { zip = readZip(readFileSync(f)); } catch (e) { failures.push([name, '(zip)', e.message.slice(0, 60)]); continue; }
    for (const entry of zip.order) {
      if (!/\.(xml|rels)$/.test(entry)) continue;
      parts += 1;
      try {
        let s = entryData(zip, entry).toString();
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // UTF-8 BOM
        parseXml(s);
        passed += 1;
      } catch (e) {
        failures.push([name, entry, e.message.slice(0, 80)]);
      }
    }
  }
}
console.log(`files=${files} xmlParts=${parts} fidelityGatePassed=${passed} failed=${failures.length}`);
for (const [f, p, m] of failures.slice(0, 10)) console.log(`  FAIL ${f} :: ${p} :: ${m}`);
