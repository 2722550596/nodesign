/**
 * xml.js — OOXML 专用的「保真 DOM」：parse / serialize / 增删改。
 *
 * 设计目标（与通用 XML 库刚好相反）：
 *   1. 没碰过的节点，serialize 时逐字节还原输入（保真编辑的地基）。
 *      做法：每个节点保留原始片段（openRaw/closeRaw/raw），只有被
 *      标脏（dirty）或新建的节点才走规范化序列化。
 *   2. 自检闸门：parse 完立刻 serialize 一遍，若与输入不等，说明这份
 *      XML 用了我们没覆盖的语法（DTD/CDATA/PI 等），parseXml 直接抛错，
 *      调用方退回「不编辑」而不是带病手术。
 *
 * 覆盖的语法子集 = Word/LibreOffice/我们自己产出的 OOXML 实际用到的：
 *   声明、元素（含自闭合）、属性、文本、注释、CDATA（原样保留）。
 *   不支持 DTD / 外部实体（OOXML 不用，遇到即拒——顺带挡住 XXE）。
 */

const NAME_RE = /^[^\s"'<>/=]+/;

export class XmlNode {
  constructor(type) {
    this.type = type;        // 'elem' | 'text' | 'comment' | 'cdata' | 'decl'
    this.name = '';
    this.attrs = [];         // [ [name, value(decoded)] ... ] 保序
    this.children = [];
    this.parent = null;
    this.selfClosing = false;
    // 保真用的原始片段（parse 时填；一旦 dirty 就失效）
    this.openRaw = null;     // '<w:p w:x="1">' 或自闭合的整个 tag
    this.closeRaw = null;    // '</w:p>'
    this.raw = null;         // text/comment/cdata/decl 的原文
    this.dirty = false;
  }

  markDirty() {
    let n = this;
    while (n && !n.dirty) { n.dirty = true; n = n.parent; }
  }

  attr(name) {
    const hit = this.attrs.find(([k]) => k === name);
    return hit ? hit[1] : null;
  }

  setAttr(name, value) {
    const hit = this.attrs.find(([k]) => k === name);
    if (hit) hit[1] = value; else this.attrs.push([name, value]);
    this.markDirty();
  }

  removeAttr(name) {
    const i = this.attrs.findIndex(([k]) => k === name);
    if (i >= 0) { this.attrs.splice(i, 1); this.markDirty(); }
  }

  /** 直属子元素（跳过 text/comment） */
  childElems(name) {
    const out = [];
    for (const c of this.children) {
      if (c.type === 'elem' && (!name || c.name === name)) out.push(c);
    }
    return out;
  }

  firstChild(name) {
    for (const c of this.children) {
      if (c.type === 'elem' && c.name === name) return c;
    }
    return null;
  }

  /** 深度优先找所有指定名字的后代元素 */
  find(name, out = []) {
    for (const c of this.children) {
      if (c.type !== 'elem') continue;
      if (c.name === name) out.push(c);
      c.find(name, out);
    }
    return out;
  }

  /** 元素的全部文本内容（w:t 语义下已解码） */
  text() {
    if (this.type === 'text') return decodeEntities(this.raw ?? '');
    let s = '';
    for (const c of this.children) s += c.text();
    return s;
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
    this.markDirty();
    return child;
  }

  insertBefore(child, ref) {
    const i = this.children.indexOf(ref);
    child.parent = this;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    this.markDirty();
    return child;
  }

  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); this.markDirty(); }
  }

  replaceChildren(list) {
    for (const c of list) c.parent = this;
    this.children = list;
    this.markDirty();
  }
}

export function elem(name, attrs = [], children = []) {
  const n = new XmlNode('elem');
  n.name = name;
  n.attrs = attrs.map(([k, v]) => [k, String(v)]);
  for (const c of children) { c.parent = n; n.children.push(c); }
  n.dirty = true;
  return n;
}

export function textNode(s) {
  const n = new XmlNode('text');
  n.raw = encodeText(String(s));
  n.dirty = true;
  return n;
}

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body] ?? m;
  });
}

export function encodeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function encodeAttr(s) {
  return encodeText(s).replace(/"/g, '&quot;')
    // 属性值里的换行/Tab 若不转义，解析器会按空格归一（丢信息）
    .replace(/\n/g, '&#10;').replace(/\t/g, '&#9;').replace(/\r/g, '&#13;');
}

/**
 * @param {string} input
 * @returns {{ decl: string|null, root: XmlNode, trailing: string }}
 */
export function parseXml(input) {
  let pos = 0;
  const len = input.length;
  let decl = null;

  if (input.startsWith('﻿')) throw new Error('BOM-prefixed XML not supported (strip first)');
  if (input.startsWith('<?xml')) {
    const end = input.indexOf('?>');
    if (end < 0) throw new Error('unterminated XML declaration');
    decl = input.slice(0, end + 2);
    pos = end + 2;
  }

  const rootWrap = new XmlNode('elem'); // 假根，容纳声明后的空白+根元素
  const stack = [rootWrap];

  while (pos < len) {
    const top = stack[stack.length - 1];
    if (input[pos] === '<') {
      if (input.startsWith('<!--', pos)) {
        const end = input.indexOf('-->', pos);
        if (end < 0) throw new Error('unterminated comment');
        const n = new XmlNode('comment');
        n.raw = input.slice(pos, end + 3);
        n.parent = top; top.children.push(n);
        pos = end + 3;
      } else if (input.startsWith('<![CDATA[', pos)) {
        const end = input.indexOf(']]>', pos);
        if (end < 0) throw new Error('unterminated CDATA');
        const n = new XmlNode('cdata');
        n.raw = input.slice(pos, end + 3);
        n.parent = top; top.children.push(n);
        pos = end + 3;
      } else if (input.startsWith('<!', pos) || input.startsWith('<?', pos)) {
        throw new Error(`unsupported markup at ${pos}: ${input.slice(pos, pos + 24)}`);
      } else if (input.startsWith('</', pos)) {
        const end = input.indexOf('>', pos);
        if (end < 0) throw new Error('unterminated close tag');
        const name = input.slice(pos + 2, end).trim();
        if (top === rootWrap || top.name !== name) {
          throw new Error(`close tag mismatch: </${name}> vs <${top.name}>`);
        }
        top.closeRaw = input.slice(pos, end + 1);
        stack.pop();
        pos = end + 1;
      } else {
        // open tag / self-closing tag
        const start = pos;
        pos++;
        const m = NAME_RE.exec(input.slice(pos));
        if (!m) throw new Error(`bad tag name at ${pos}`);
        const node = new XmlNode('elem');
        node.name = m[0];
        pos += m[0].length;
        // attributes
        for (;;) {
          while (pos < len && /\s/.test(input[pos])) pos++;
          if (input[pos] === '>') { pos++; break; }
          if (input[pos] === '/' && input[pos + 1] === '>') { node.selfClosing = true; pos += 2; break; }
          const am = NAME_RE.exec(input.slice(pos));
          if (!am) throw new Error(`bad attribute at ${pos}: ${input.slice(pos, pos + 20)}`);
          const aname = am[0];
          pos += aname.length;
          while (pos < len && /\s/.test(input[pos])) pos++;
          if (input[pos] !== '=') throw new Error(`attribute without value at ${pos}`);
          pos++;
          while (pos < len && /\s/.test(input[pos])) pos++;
          const q = input[pos];
          if (q !== '"' && q !== "'") throw new Error(`unquoted attribute at ${pos}`);
          const vEnd = input.indexOf(q, pos + 1);
          if (vEnd < 0) throw new Error('unterminated attribute value');
          node.attrs.push([aname, decodeEntities(input.slice(pos + 1, vEnd))]);
          pos = vEnd + 1;
        }
        node.openRaw = input.slice(start, pos);
        node.parent = top;
        top.children.push(node);
        if (!node.selfClosing) stack.push(node);
      }
    } else {
      const next = input.indexOf('<', pos);
      const end = next < 0 ? len : next;
      const n = new XmlNode('text');
      n.raw = input.slice(pos, end);
      n.parent = top; top.children.push(n);
      pos = end;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${stack[stack.length - 1].name}>`);
  const rootElems = rootWrap.children.filter((c) => c.type === 'elem');
  if (rootElems.length !== 1) throw new Error('expected exactly one root element');

  const doc = { decl, root: rootElems[0], wrap: rootWrap };

  // 自检闸门：序列化必须逐字节还原输入
  const echo = serialize(doc);
  if (echo !== input) {
    const at = firstDiff(echo, input);
    throw new Error(`fidelity self-check failed at byte ${at}: `
      + JSON.stringify(input.slice(Math.max(0, at - 40), at + 40)));
  }
  return doc;
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

export function serialize(doc) {
  let out = doc.decl ?? '';
  for (const c of doc.wrap.children) out += serializeNode(c);
  return out;
}

export function serializeNode(node) {
  if (node.type === 'text' || node.type === 'comment' || node.type === 'cdata' || node.type === 'decl') {
    return node.raw ?? '';
  }
  // 干净节点：原始片段直出
  if (!node.dirty && node.openRaw != null) {
    if (node.selfClosing) return node.openRaw;
    let out = node.openRaw;
    for (const c of node.children) out += serializeNode(c);
    return out + node.closeRaw;
  }
  // 脏/新建节点：规范化输出
  let tag = `<${node.name}`;
  for (const [k, v] of node.attrs) tag += ` ${k}="${encodeAttr(v)}"`;
  if (node.children.length === 0) return `${tag}/>`;
  let out = `${tag}>`;
  for (const c of node.children) out += serializeNode(c);
  return `${out}</${node.name}>`;
}
