/**
 * 07-phrase-findability.mjs — 「眼睛看得见、XML 搜不到」→ merge 后搜得到。
 * 对指定 docx：列出所有因打碎而搜不到的可见段落文本，merge 后复测。
 * 跑法: node lab/07-phrase-findability.mjs <docx>
 */
import { readFileSync } from 'node:fs';
import { readZip, entryData } from '../rawzip.js';
import { parseXml, serialize } from '../xml.js';
import { mergeRuns } from '../merge-runs.js';

const src = process.argv[2];
const zip = readZip(readFileSync(src));
const xml = entryData(zip, 'word/document.xml').toString();
const doc = parseXml(xml);

const visible = [];
for (const p of doc.root.find('w:p')) {
  const t = p.find('w:t').map((t) => t.text()).join('');
  if (t.length >= 6) visible.push(t);
}
const lost = visible.filter((t) => !xml.includes(t));
console.log(`可见段 ${visible.length}，原 XML 搜不到的 ${lost.length}`);
for (const t of lost.slice(0, 5)) console.log('  搜不到:', JSON.stringify(t.slice(0, 60)));

const stats = mergeRuns(doc.root);
const merged = serialize(doc);
const still = lost.filter((t) => !merged.includes(t));
console.log(`mergeRuns: merged=${stats.merged} proofErr=${stats.dropped}`);
console.log(`merge 后仍搜不到: ${still.length}/${lost.length}`);
for (const t of still.slice(0, 5)) console.log('  仍搜不到:', JSON.stringify(t.slice(0, 60)));
