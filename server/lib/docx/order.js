/**
 * order.js — OOXML 子元素规范顺序表 + 排序构建器 + 顺序体检。
 *
 * 顺序错了 Word 会报「文档已损坏」或静默修复（丢内容），所以：
 *   - 我们产出的每个属性容器都经 sortChildren() 排序；
 *   - checkOrder() 可以对任意 document.xml/styles.xml 做顺序体检。
 *
 * 表的来源：ECMA-376 CT_* 序列（先按 minimax references/openxml_element_order.md
 * 抄底，再拿 DocumentFormat.OpenXml 的 OpenXmlValidator 实测校准——那份
 * references 上一轮已证明不能盲信，凡我们要发射的组合都过了 validator）。
 */

const T = {
  'w:pPr': [
    'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr',
    'w:widowControl', 'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd',
    'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
    'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN',
    'w:bidi', 'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind',
    'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc',
    'w:textDirection', 'w:textAlignment', 'w:outlineLvl', 'w:divId',
    'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange',
  ],
  'w:rPr': [
    'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps',
    'w:smallCaps', 'w:strike', 'w:dstrike', 'w:outline', 'w:shadow',
    'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish',
    'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position',
    'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd',
    'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang',
    'w:eastAsianLayout', 'w:specVanish', 'w:oMath', 'w:rPrChange',
  ],
  'w:tblPr': [
    'w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual',
    'w:tblStyleRowBandSize', 'w:tblStyleColBandSize', 'w:tblW', 'w:jc',
    'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders', 'w:shd', 'w:tblLayout',
    'w:tblCellMar', 'w:tblLook', 'w:tblCaption', 'w:tblDescription',
    'w:tblPrChange',
  ],
  'w:trPr': [
    'w:cnfStyle', 'w:divId', 'w:gridBefore', 'w:gridAfter', 'w:wBefore',
    'w:wAfter', 'w:cantSplit', 'w:trHeight', 'w:tblHeader',
    'w:tblCellSpacing', 'w:jc', 'w:hidden', 'w:ins', 'w:del', 'w:trPrChange',
  ],
  'w:tcPr': [
    'w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge',
    'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar', 'w:textDirection',
    'w:tcFitText', 'w:vAlign', 'w:hideMark', 'w:headers', 'w:cellIns',
    'w:cellDel', 'w:cellMerge', 'w:tcPrChange',
  ],
  'w:sectPr': [
    'w:headerReference', 'w:footerReference', 'w:footnotePr', 'w:endnotePr',
    'w:type', 'w:pgSz', 'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType',
    'w:pgNumType', 'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote',
    'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid',
    'w:printerSettings', 'w:sectPrChange',
  ],
  'w:style': [
    'w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:autoRedefine',
    'w:hidden', 'w:uiPriority', 'w:semiHidden', 'w:unhideWhenUsed',
    'w:qFormat', 'w:locked', 'w:personal', 'w:personalCompose',
    'w:personalReply', 'w:rsid', 'w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr',
    'w:tcPr', 'w:tblStylePr',
  ],
  'w:tblStylePr': ['w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr'],
  'w:styles': ['w:docDefaults', 'w:latentStyles', 'w:style'],
  'w:docDefaults': ['w:rPrDefault', 'w:pPrDefault'],
  'w:tbl': ['w:tblPr', 'w:tblGrid', 'w:tr'],
  'w:tblBorders': ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:insideH', 'w:insideV'],
  'w:tcBorders': ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:insideH', 'w:insideV', 'w:tl2br', 'w:tr2bl'],
  'w:pBdr': ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:between', 'w:bar'],
  'w:tblCellMar': ['w:top', 'w:left', 'w:bottom', 'w:right'],
  'w:tcMar': ['w:top', 'w:left', 'w:bottom', 'w:right'],
  'w:numPr': ['w:ilvl', 'w:numId', 'w:numberingChange', 'w:ins'],
  'w:abstractNum': ['w:nsid', 'w:multiLevelType', 'w:tmpl', 'w:name',
    'w:styleLink', 'w:numStyleLink', 'w:lvl'],
  'w:lvl': ['w:start', 'w:numFmt', 'w:lvlRestart', 'w:pStyle', 'w:isLgl',
    'w:suff', 'w:lvlText', 'w:lvlPicBulletId', 'w:legacy', 'w:lvlJc',
    'w:pPr', 'w:rPr'],
  'w:num': ['w:abstractNumId', 'w:lvlOverride'],
  'w:numbering': ['w:numPicBullet', 'w:abstractNum', 'w:num', 'w:numIdMacAtCleanup'],
};

/** 「pPr 必须第一、sectPr 必须最后」这类交错容器的松规则 */
const LOOSE = {
  'w:p':    { first: 'w:pPr', last: null },
  'w:r':    { first: 'w:rPr', last: null },
  'w:body': { first: null, last: 'w:sectPr' },
  'w:tr':   { first: 'w:trPr', last: null },
  'w:tc':   { first: 'w:tcPr', last: null },
};

export const ORDER_TABLES = T;

/** 按规范表就地排序一个元素的直属子元素（稳定排序，未知名字保持相对位置放最后并报错可选） */
export function sortChildren(node, { strictUnknown = true } = {}) {
  const table = T[node.name];
  if (!table) return node;
  const rank = new Map(table.map((n, i) => [n, i]));
  const unknown = node.children.filter((c) => c.type === 'elem' && !rank.has(c.name));
  if (unknown.length && strictUnknown) {
    throw new Error(`sortChildren(${node.name}): unknown child ${unknown[0].name}`);
  }
  const elems = node.children.filter((c) => c.type === 'elem');
  const rest = node.children.filter((c) => c.type !== 'elem');
  elems.sort((a, b) => (rank.get(a.name) ?? 9999) - (rank.get(b.name) ?? 9999));
  node.replaceChildren([...elems, ...rest]);
  return node;
}

/**
 * 顺序体检：递归检查一棵树，返回违规列表 [{ path, parent, child, msg }]
 */
export function checkOrder(root, path = `/${root.name}`, out = []) {
  const table = T[root.name];
  const elems = root.children.filter((c) => c.type === 'elem');
  if (table) {
    const rank = new Map(table.map((n, i) => [n, i]));
    let prev = -1;
    let prevName = null;
    for (const c of elems) {
      const r = rank.get(c.name);
      if (r === undefined) {
        out.push({ path, parent: root.name, child: c.name, msg: 'unknown child (not in order table)' });
        continue;
      }
      if (r < prev) {
        out.push({ path, parent: root.name, child: c.name, msg: `out of order: ${c.name} after ${prevName}` });
      }
      if (r >= prev) { prev = r; prevName = c.name; }
    }
  }
  const loose = LOOSE[root.name];
  if (loose) {
    if (loose.first) {
      const idx = elems.findIndex((c) => c.name === loose.first);
      if (idx > 0) out.push({ path, parent: root.name, child: loose.first, msg: `${loose.first} must be first child` });
    }
    if (loose.last) {
      const idx = elems.findIndex((c) => c.name === loose.last);
      if (idx >= 0 && idx !== elems.length - 1) {
        out.push({ path, parent: root.name, child: loose.last, msg: `${loose.last} must be last child` });
      }
    }
  }
  let i = 0;
  for (const c of elems) {
    i += 1;
    checkOrder(c, `${path}/${c.name}[${i}]`, out);
  }
  return out;
}
