/**
 * lib/doc-extract.js —— 把 Office 文档变成 agent 读得懂的文本。
 *
 * 起因：用户往上下文托盘里拖一份 .docx（"照这份需求做一版海报"），agent 拿
 * Read 一读得到的是二进制乱码 —— **而且它不会报错**，只会当成一份读不懂的
 * 文件继续往下干，最后交出一个跟需求无关的东西。PDF 不在此列：SDK 的 Read
 * 原生支持，2026-08-07 真跑验过（暗号字符串原样读回来了）。
 *
 * ## 为什么 docx 用库、xlsx/pptx 自己拆
 *
 * docx 的正文结构真的复杂（编号、表格、脚注、样式继承），mammoth 是这块
 * 做得最正的库，没必要重写。
 *
 * xlsx 和 pptx 这边，npm 上要么是已经不在公共源上维护的（SheetJS），要么
 * 拖着 OCR 引擎和整个 pdf.js（officeparser 带 tesseract.js）—— 这台机器
 * 是 3.8G 的 Spot，底座内存已经按 MB 记着账。而这两种格式要的东西恰好是
 * OOXML 里最简单的一角：zip 里几个 XML，取 `<t>` 节点的文字。所以这两种
 * 自己拆，用 fflate（零依赖）解 zip。
 *
 * ## 出的是什么
 *
 * 纯文本 + 结构记号（工作表名 / 幻灯页号 / 表格行用 tab 分列）。**不做排版
 * 还原** —— agent 要的是"这份文件说了什么"，版式它自己会重新设计，那本来
 * 就是它的活。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 认得的扩展名 → 人话名字 */
export const DOC_KINDS = {
  '.docx': 'Word 文档',
  '.xlsx': 'Excel 表格',
  '.pptx': 'PowerPoint 演示文稿',
};

/** 单份文件最多抽这么多字符 —— 一本书全塞进上下文没有意义 */
export const MAX_CHARS = 60_000;

export function isExtractable(p) {
  return Object.hasOwn(DOC_KINDS, path.extname(String(p || '')).toLowerCase());
}

/** XML 里取某个标签的全部文字（`<a:t>` / `<w:t>` / `<t>`），按出现顺序 */
function textsOf(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(unescapeXml(m[1]));
  return out;
}

function unescapeXml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')            // 内嵌标签（<w:tab/> 之类）先去掉
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');            // & 必须最后还原，否则 &amp;lt; 会被解两次
}

async function unzip(absPath) {
  const { unzipSync } = await import('fflate');
  const buf = await fs.readFile(absPath);
  const files = unzipSync(new Uint8Array(buf));
  const dec = new TextDecoder('utf-8');
  return {
    names: Object.keys(files),
    read: (name) => (files[name] ? dec.decode(files[name]) : null),
  };
}

/** docx —— 交给 mammoth，它把编号、表格、标题都翻对 */
async function extractDocx(absPath) {
  const mammoth = (await import('mammoth')).default || (await import('mammoth'));
  const { value, messages } = await mammoth.extractRawText({ path: absPath });
  const warn = (messages || []).filter(m => m.type === 'warning').length;
  return { text: value || '', note: warn ? `${warn} 处格式没能完全还原（不影响正文）` : null };
}

/**
 * xlsx —— 共享字符串表 + 每张表的单元格。
 *
 * `<c>` 的 `t="s"` 表示值是**共享字符串表的下标**不是字面量，这是 xlsx 里
 * 最容易搞错的一处：不查表的话整张表会读成一列数字。
 */
async function extractXlsx(absPath) {
  const zip = await unzip(absPath);
  const shared = textsOf(zip.read('xl/sharedStrings.xml') || '', 'si')
    .map(s => s.trim());

  // 工作表显示名在 workbook.xml 里，文件名是 sheet1.xml —— 两者顺序对应
  const wb = zip.read('xl/workbook.xml') || '';
  const names = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]*)"/g)].map(m => unescapeXml(m[1]));

  const sheetFiles = zip.names
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));

  const parts = [];
  sheetFiles.forEach((file, i) => {
    const xml = zip.read(file) || '';
    const rows = [];
    for (const rowXml of xml.split(/<\/(?:\w+:)?row>/)) {
      const cells = [];
      const re = /<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g;
      let m;
      while ((m = re.exec(rowXml))) {
        const isShared = /\bt="s"/.test(m[1]);
        const raw = textsOf(m[2], 'v')[0] ?? textsOf(m[2], 't')[0] ?? '';
        cells.push(isShared ? (shared[Number(raw)] ?? '') : raw);
      }
      if (cells.some(c => c !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) parts.push(`## 工作表：${names[i] || `sheet${i + 1}`}\n${rows.join('\n')}`);
  });
  return { text: parts.join('\n\n'), note: parts.length ? null : '表格是空的' };
}

/** pptx —— 每页一节，取文本框里的文字 */
async function extractPptx(absPath) {
  const zip = await unzip(absPath);
  const slides = zip.names
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));

  const parts = slides.map((file, i) => {
    const lines = textsOf(zip.read(file) || '', 't').map(s => s.trim()).filter(Boolean);
    return `## 第 ${i + 1} 页\n${lines.join('\n') || '(这一页没有文字)'}`;
  });
  return { text: parts.join('\n\n'), note: parts.length ? null : '没找到幻灯页' };
}

/**
 * 抽一份文档的文本。
 * @returns {Promise<{ kind, text, chars, truncated, note }>}
 * @throws 扩展名不认识 / 文件坏了
 */
export async function extractDocument(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const kind = DOC_KINDS[ext];
  if (!kind) {
    throw Object.assign(new Error(`不支持的格式：${ext || '(无扩展名)'}`), { code: 'UNSUPPORTED' });
  }
  const fn = ext === '.docx' ? extractDocx : ext === '.xlsx' ? extractXlsx : extractPptx;
  const { text, note } = await fn(absPath);
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = clean.length > MAX_CHARS;
  return {
    kind,
    text: truncated ? clean.slice(0, MAX_CHARS) : clean,
    chars: clean.length,
    truncated,
    note,
  };
}
