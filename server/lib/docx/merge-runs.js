/**
 * merge-runs.js — 把 Word 打碎的相邻同格式 run 合回去，让「眼睛看得见的短语」
 * 在 XML 里重新成为连续字符串（编辑外来 docx 的第一道工序）。
 *
 * Word 打碎 run 的三大来源：rsid（修订会话指纹）、proofErr（拼写检查标记）、
 * 格式微差。合并规则（保守优先，宁可少合不可错合）：
 *   - 只在同一父元素下合并**相邻**的、只含 w:t 的 run；
 *   - 中间夹 w:proofErr 视为透明并把标记丢弃（Word 会自己重算拼写）；
 *   - 夹 bookmark/comment/ins/del/任何别的东西 = 硬边界，不越过；
 *   - 含 br/tab/drawing/fldChar 等非纯文本的 run = 硬边界；
 *   - 格式签名 = rPr 规范化（剥 rsid 系属性、按元素名排序后序列化）逐字节相等；
 *   - 合并结果 w:t 首尾有空白时补 xml:space="preserve"。
 * 递归进 w:p / w:hyperlink / w:ins / w:del / w:sdtContent / w:smartTag / w:tc 等容器。
 *
 * 返回 {merged, dropped}：合并掉的 run 数 / 丢弃的 proofErr 数。
 */

import { serializeNode, textNode } from './xml.js';

const RSID_ATTR = /^w:rsid/;
const CONTAINERS = new Set(['w:body', 'w:p', 'w:hyperlink', 'w:ins', 'w:del', 'w:sdt',
  'w:sdtContent', 'w:smartTag', 'w:tc', 'w:tr', 'w:tbl', 'w:hdr', 'w:ftr',
  'w:footnote', 'w:endnote', 'w:comment', 'w:fldSimple']);

/** run 是否为「纯文本 run」（只含 rPr 和 w:t） */
function isTextOnlyRun(r) {
  if (r.name !== 'w:r') return false;
  for (const c of r.children) {
    if (c.type !== 'elem') continue;
    if (c.name === 'w:rPr' || c.name === 'w:t') continue;
    return false;
  }
  return true;
}

/** rPr 的格式签名：剥 rsid、子元素按名排序（同名保序）、规范序列化 */
function runSig(r) {
  const rPr = r.firstChild('w:rPr');
  if (!rPr) return '';
  const parts = [];
  for (const c of rPr.children) {
    if (c.type !== 'elem') continue;
    const attrs = c.attrs.filter(([k]) => !RSID_ATTR.test(k));
    parts.push(`${c.name}|${attrs.map(([k, v]) => `${k}=${v}`).sort().join(',')}`
      + (c.children.length ? `|${serializeNode(c)}` : ''));
  }
  return parts.sort().join(';');
}

function runText(r) {
  let s = '';
  for (const c of r.children) {
    if (c.type === 'elem' && c.name === 'w:t') s += c.text();
  }
  return s;
}

function setRunText(r, text) {
  const t = r.firstChild('w:t');
  if (!t) return;
  // 重建 w:t（脏节点走规范序列化）
  const tn = textNode(text);
  tn.parent = t;
  t.children = [tn];
  if (/^\s|\s$/.test(text)) {
    if (!t.attr('xml:space')) t.attrs.push(['xml:space', 'preserve']);
  } else {
    const i = t.attrs.findIndex(([k]) => k === 'xml:space');
    if (i >= 0) t.attrs.splice(i, 1);
  }
  t.markDirty();
}

export function mergeRuns(root) {
  const stats = { merged: 0, dropped: 0 };
  walk(root, stats);
  return stats;
}

function walk(node, stats) {
  if (node.type !== 'elem') return;
  if (CONTAINERS.has(node.name)) mergeInContainer(node, stats);
  for (const c of node.children) walk(c, stats);
}

function mergeInContainer(parent, stats) {
  const kids = parent.children;
  let changed = false;
  let i = 0;
  while (i < kids.length) {
    const a = kids[i];
    if (!(a.type === 'elem' && isTextOnlyRun(a))) { i += 1; continue; }
    const sigA = runSig(a);
    let acc = null;   // 合并累积文本（惰性启动）
    let j = i + 1;
    const absorbed = [];   // 将被移除的节点（run 与 proofErr）
    while (j < kids.length) {
      const b = kids[j];
      if (b.type === 'elem' && b.name === 'w:proofErr') {
        absorbed.push(b); j += 1; continue;      // 透明，越过并丢弃
      }
      if (b.type === 'elem' && isTextOnlyRun(b) && runSig(b) === sigA) {
        if (acc == null) acc = runText(a);
        acc += runText(b);
        absorbed.push(b);
        stats.merged += 1;
        j += 1;
        continue;
      }
      break;
    }
    if (acc != null) {
      setRunText(a, acc);
      for (const n of absorbed) {
        const k = kids.indexOf(n);
        if (n.name === 'w:proofErr') stats.dropped += 1;
        kids.splice(k, 1);
      }
      parent.markDirty();
      changed = true;
      // a 现在是合并后的 run；从 a 之后继续（可能还有下一簇）
      i = kids.indexOf(a) + 1;
    } else {
      // 没合成任何东西：被 absorb 的 proofErr 留在原位（不动干净区域）
      i += 1;
    }
  }
  return changed;
}
