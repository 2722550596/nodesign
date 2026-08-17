/**
 * dump-styles.js — 外来 docx 的 styles.xml/theme/sectPr → token JSON（尽力而为）。
 *
 * 覆盖规则（字段闭合原则的读端）：
 *   - 一个 pPr/rPr 子元素要么**完整**映射进 token 字段，要么**整条**进
 *     extraXml 透传（绝不半吊子拆一半，防止重建时双重应用）；
 *   - 整条 w:style 装不进模型（表格样式等）→ rawStyles 原文透传；
 *   - 主题字体引用（w:asciiTheme 等）就地解析成实际字体名。
 *
 * 另附 applyStyleEdit：对外来文档做「定点样式手术」——只改目标 style 的
 * 目标属性，其他字节不动（编辑外来 docx 的推荐路线）。
 */

import { readFileSync } from 'node:fs';
import { parseXml, serialize, serializeNode, elem } from './xml.js';
import { sortChildren } from './order.js';
import { readZip, entryData, replaceEntry, writeZip } from './rawzip.js';
import { buildRPr } from './build.js';

/* ── theme ── */
function parseTheme(zip) {
  const buf = entryData(zip, 'word/theme/theme1.xml');
  if (!buf) return null;
  const doc = parseXml(buf.toString());
  const out = { major: {}, minor: {} };
  for (const [key, tag] of [['major', 'a:majorFont'], ['minor', 'a:minorFont']]) {
    const font = doc.root.find(tag)[0];
    if (!font) continue;
    out[key].latin = font.firstChild('a:latin')?.attr('typeface') || null;
    out[key].ea = font.firstChild('a:ea')?.attr('typeface') || null;
    out[key].cs = font.firstChild('a:cs')?.attr('typeface') || null;
  }
  return out;
}

function resolveThemeFont(theme, ref) {
  if (!theme || !ref) return null;
  const m = { majorHAnsi: theme.major.latin, majorAscii: theme.major.latin, majorEastAsia: theme.major.ea, majorBidi: theme.major.cs,
    minorHAnsi: theme.minor.latin, minorAscii: theme.minor.latin, minorEastAsia: theme.minor.ea, minorBidi: theme.minor.cs };
  return m[ref] ?? null;
}

/* ── rPr → run ── */
function dumpRPr(rPr, theme) {
  const run = {};
  const extra = [];
  if (!rPr) return { run, extra };
  for (const c of rPr.childElems()) {
    const v = c.attr('w:val');
    switch (c.name) {
      case 'w:rFonts': {
        const f = {};
        const ascii = c.attr('w:ascii') ?? resolveThemeFont(theme, c.attr('w:asciiTheme'));
        const hAnsi = c.attr('w:hAnsi') ?? resolveThemeFont(theme, c.attr('w:hAnsiTheme'));
        const ea = c.attr('w:eastAsia') ?? resolveThemeFont(theme, c.attr('w:eastAsiaTheme'));
        const cs = c.attr('w:cs') ?? resolveThemeFont(theme, c.attr('w:cstheme'));
        if (ascii) f.ascii = ascii;
        if (hAnsi) f.hAnsi = hAnsi;
        if (ea) f.eastAsia = ea;
        if (cs) f.cs = cs;
        const known = ['w:ascii', 'w:hAnsi', 'w:eastAsia', 'w:cs', 'w:asciiTheme', 'w:hAnsiTheme', 'w:eastAsiaTheme', 'w:cstheme', 'w:hint'];
        if (c.attrs.every(([k]) => known.includes(k))) run.font = f; else extra.push(serializeNode(c));
        break;
      }
      case 'w:b': run.bold = v !== '0' && v !== 'false'; break;
      case 'w:i': run.italic = v !== '0' && v !== 'false'; break;
      case 'w:caps': run.caps = v !== '0' && v !== 'false'; break;
      case 'w:smallCaps': run.smallCaps = v !== '0' && v !== 'false'; break;
      case 'w:strike': run.strike = v !== '0' && v !== 'false'; break;
      case 'w:color':
        if (c.attrs.length === 1 && v && v !== 'auto') run.color = v;
        else if (v === 'auto' && c.attrs.length === 1) { /* auto = 继承，丢弃等价 */ }
        else extra.push(serializeNode(c));
        break;
      case 'w:sz': run.sizePt = Number(v) / 2; break;
      case 'w:szCs': break;   // 由 build 端从 sizePt 再生
      case 'w:u': run.underline = v; break;
      case 'w:vertAlign': run.vertAlign = v; break;
      case 'w:em': run.em = v; break;
      case 'w:kern': run.kernPt = Number(v) / 2; break;
      case 'w:spacing': run.spacingTwip = Number(v); break;
      case 'w:highlight': run.highlight = v; break;
      case 'w:bCs': case 'w:iCs': break;  // build 端跟随 b/i 语义，可再生；不单独建模
      default: extra.push(serializeNode(c));
    }
  }
  return { run, extra };
}

/* ── pPr → para ── */
const CJK_MAP = { 'w:kinsoku': 'kinsoku', 'w:wordWrap': 'wordWrap', 'w:overflowPunct': 'overflowPunct',
  'w:autoSpaceDE': 'autoSpaceDE', 'w:autoSpaceDN': 'autoSpaceDN', 'w:adjustRightInd': 'adjustRightInd',
  'w:snapToGrid': 'snapToGrid' };

function dumpPPr(pPr, theme) {
  const para = {};
  const extra = [];
  let runFromParaMark = null;
  if (!pPr) return { para, extra, runFromParaMark };
  for (const c of pPr.childElems()) {
    const v = c.attr('w:val');
    const on = v !== '0' && v !== 'false';
    switch (c.name) {
      case 'w:jc': para.align = v; break;
      case 'w:outlineLvl': para.outlineLevel = Number(v); break;
      case 'w:keepNext': para.keepNext = on; break;
      case 'w:keepLines': para.keepLines = on; break;
      case 'w:pageBreakBefore': para.pageBreakBefore = on; break;
      case 'w:widowControl': para.widowControl = on; break;
      case 'w:contextualSpacing': para.contextualSpacing = on; break;
      case 'w:ind': {
        const i = {};
        const map = { 'w:left': 'leftTwip', 'w:start': 'leftTwip', 'w:leftChars': 'leftChars',
          'w:right': 'rightTwip', 'w:end': 'rightTwip', 'w:rightChars': 'rightChars',
          'w:hanging': 'hangingTwip', 'w:hangingChars': 'hangingChars',
          'w:firstLine': 'firstLineTwip', 'w:firstLineChars': 'firstLineChars' };
        let ok = true;
        for (const [k, val] of c.attrs) {
          if (map[k]) i[map[k]] = Number(val); else ok = false;
        }
        if (ok) para.indent = i; else extra.push(serializeNode(c));
        break;
      }
      case 'w:spacing': {
        const s = {};
        let ok = true;
        for (const [k, val] of c.attrs) {
          if (k === 'w:before') s.beforePt = Number(val) / 20;
          else if (k === 'w:after') s.afterPt = Number(val) / 20;
          else if (k === 'w:beforeLines') s.beforeLines = Number(val);
          else if (k === 'w:afterLines') s.afterLines = Number(val);
          else if (k === 'w:line') s._line = Number(val);
          else if (k === 'w:lineRule') s._rule = val;
          else if (k === 'w:beforeAutospacing' || k === 'w:afterAutospacing') { if (val !== '0' && val !== 'false') ok = false; }
          else ok = false;
        }
        if (ok) {
          if (s._line != null) {
            const rule = s._rule ?? 'auto';
            if (rule === 'auto') { s.line = s._line / 240; s.lineRule = 'multiple'; }
            else { s.line = s._line / 20; s.lineRule = rule; }
          }
          delete s._line; delete s._rule;
          para.spacing = s;
        } else extra.push(serializeNode(c));
        break;
      }
      case 'w:shd':
        if (c.attr('w:val') === 'clear' && c.attr('w:fill') && c.attr('w:fill') !== 'auto') para.shading = c.attr('w:fill');
        else extra.push(serializeNode(c));
        break;
      case 'w:rPr': {   // 段落标记的 run 属性：作为该风格 run 的一部分
        runFromParaMark = c;
        break;
      }
      default:
        if (CJK_MAP[c.name]) { para.cjk = para.cjk ?? {}; para.cjk[CJK_MAP[c.name]] = on; }
        else extra.push(serializeNode(c));
    }
  }
  return { para, extra, runFromParaMark };
}

/**
 * @param {Buffer|string} input docx buffer 或路径
 * @returns token JSON（provenance:'imported'）+ 覆盖率统计
 */
export function dumpStyles(input) {
  const buf = Buffer.isBuffer(input) ? input : readFileSync(input);
  const zip = readZip(buf);
  const theme = parseTheme(zip);
  const stylesXml = entryData(zip, 'word/styles.xml');
  if (!stylesXml) throw new Error('no styles.xml');
  const doc = parseXml(stylesXml.toString());

  const tokens = { v: 1, provenance: 'imported', styles: {}, rawStyles: [] };
  const stat = { styles: 0, raw: 0, extraFragments: 0 };

  // docDefaults
  const dd = doc.root.firstChild('w:docDefaults');
  if (dd) {
    const rDef = dd.firstChild('w:rPrDefault')?.firstChild('w:rPr');
    const { run, extra } = dumpRPr(rDef, theme);
    const pDef = dd.firstChild('w:pPrDefault')?.firstChild('w:pPr');
    const { para, extra: pExtra } = dumpPPr(pDef, theme);
    tokens.base = {};
    if (run.font) { tokens.fonts = { body: run.font }; tokens.base.font = 'body'; }
    if (run.sizePt != null) tokens.base.sizePt = run.sizePt;
    if (run.color) tokens.base.color = run.color;
    if (run.kernPt != null) tokens.base.kernPt = run.kernPt;
    if (para.spacing) tokens.base.spacing = para.spacing;
    if (para.cjk) tokens.base.cjk = para.cjk;
    // 语言
    const lang = rDef?.firstChild('w:lang');
    if (lang) tokens.lang = { latin: lang.attr('w:val') ?? 'en-US', eastAsia: lang.attr('w:eastAsia') ?? 'zh-CN' };
    const leftovers = [...extra, ...pExtra];
    if (leftovers.length) { tokens.base.extraXml = leftovers; stat.extraFragments += leftovers.length; }
  }

  // theme 快照（重建 theme part 或字体回填用）
  if (theme) tokens.theme = theme;

  for (const st of doc.root.childElems('w:style')) {
    const type = st.attr('w:type');
    const id = st.attr('w:styleId');
    if (!id) continue;
    if (type !== 'paragraph' && type !== 'character') {
      tokens.rawStyles.push(serializeNode(st));
      stat.raw += 1;
      continue;
    }
    const s = { type, name: st.firstChild('w:name')?.attr('w:val') ?? id };
    if (st.firstChild('w:basedOn')) s.basedOn = st.firstChild('w:basedOn').attr('w:val');
    if (st.firstChild('w:next')) s.next = st.firstChild('w:next').attr('w:val');
    if (st.firstChild('w:link')) s.link = st.firstChild('w:link').attr('w:val');
    if (st.firstChild('w:qFormat')) s.qFormat = true;
    if (st.firstChild('w:uiPriority')) s.uiPriority = Number(st.firstChild('w:uiPriority').attr('w:val'));
    const { run, extra: rExtra } = dumpRPr(st.firstChild('w:rPr'), theme);
    const { para, extra: pExtra, runFromParaMark } = dumpPPr(st.firstChild('w:pPr'), theme);
    if (Object.keys(run).length) s.run = run;
    if (Object.keys(para).length) s.para = para;
    const known = ['w:name', 'w:basedOn', 'w:next', 'w:link', 'w:qFormat', 'w:uiPriority', 'w:rPr', 'w:pPr',
      'w:semiHidden', 'w:unhideWhenUsed', 'w:rsid', 'w:autoRedefine', 'w:hidden', 'w:locked', 'w:aliases'];
    const otherKids = st.childElems().filter((c) => !known.includes(c.name)).map((c) => serializeNode(c));
    const leftovers = [...rExtra, ...pExtra, ...otherKids];
    if (runFromParaMark) leftovers.push(`<w:pPr-rPr>${serializeNode(runFromParaMark)}</w:pPr-rPr>`);
    if (leftovers.length) { s.extraXml = leftovers; stat.extraFragments += leftovers.length; }
    tokens.styles[id] = s;
    stat.styles += 1;
  }

  // sectPr（版面）
  const docPart = entryData(zip, 'word/document.xml');
  if (docPart) {
    const d = parseXml(docPart.toString());
    const sect = d.root.firstChild('w:body')?.childElems('w:sectPr')[0];
    if (sect) {
      const pgSz = sect.firstChild('w:pgSz');
      const pgMar = sect.firstChild('w:pgMar');
      const grid = sect.firstChild('w:docGrid');
      tokens.page = {};
      if (pgSz) tokens.page.size = { wTwip: Number(pgSz.attr('w:w')), hTwip: Number(pgSz.attr('w:h')) };
      if (pgSz?.attr('w:orient') === 'landscape') tokens.page.landscape = true;
      if (pgMar) {
        tokens.page.marginsTwip = Object.fromEntries(['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter']
          .map((k) => [k, Number(pgMar.attr(`w:${k}`))]).filter(([, v]) => Number.isFinite(v)));
      }
      if (grid) {
        tokens.page.docGrid = { type: grid.attr('w:type') ?? 'default', linePitchTwip: Number(grid.attr('w:linePitch')) };
        if (grid.attr('w:charSpace')) tokens.page.docGrid.charSpace = Number(grid.attr('w:charSpace'));
      }
    }
  }
  return { tokens, stat };
}

/**
 * 定点样式手术：只改一个 style 的 run 字段（sizePt/color/bold/font…），
 * styles.xml 其余部分与其他 entry 逐字节不动。
 * @returns {Buffer} 新 docx
 */
export function applyStyleEdit(docxBuf, styleId, patch) {
  const zip = readZip(docxBuf);
  const stylesXml = entryData(zip, 'word/styles.xml').toString();
  const doc = parseXml(stylesXml);
  const st = doc.root.childElems('w:style').find((s) => s.attr('w:styleId') === styleId);
  if (!st) throw new Error(`style not found: ${styleId}`);
  let rPr = st.firstChild('w:rPr');
  if (!rPr) {
    rPr = elem('w:rPr');
    st.append(rPr);            // 位置交给 sortChildren
    sortChildren(st, { strictUnknown: false });
  }
  if (patch.run) {
    // 用 build 端同一套逻辑生成要写入的元素，再逐个 upsert
    const fake = { fonts: {} };
    const built = buildRPr(fake, patch.run) ?? elem('w:rPr');
    for (const nel of built.childElems()) {
      const old = rPr.firstChild(nel.name);
      if (old) rPr.remove(old);
      rPr.append(nel);
    }
    sortChildren(rPr, { strictUnknown: false });
  }
  replaceEntry(zip, 'word/styles.xml', serialize(doc));
  return writeZip(zip);
}
