/**
 * rawzip.js — 面向 docx 的最小 ZIP 读写器，核心卖点是「保真」：
 * 没被替换的 entry，local header + 压缩数据 + data descriptor 原样字节拷贝；
 * 只有被替换/新增的 entry 走 zlib deflateRaw 重压。
 *
 * 覆盖范围 = OOXML 容器实际会遇到的:
 *   - 方法 0 (store) / 8 (deflate)
 *   - bit3 data descriptor（流式写出的 zip）
 *   - 不支持 zip64 / 加密 / 分卷（docx 不会用；遇到即抛错，调用方退回只读）
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * @param {Buffer} buf
 * @returns {{ entries: Map<string, Entry>, order: string[] }}
 * Entry = { name, method, crc, csize, usize, flags, cenExtra..., locRaw:Buffer|null, replaced:Buffer|null }
 */
export function readZip(buf) {
  // 找 EOCD（从尾部回扫，容忍 comment）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found (not a zip)');
  const count = buf.readUInt16LE(eocd + 10);
  const cenOfs = buf.readUInt32LE(eocd + 16);
  if (cenOfs === 0xffffffff) throw new Error('zip64 not supported');

  const entries = new Map();
  const order = [];
  let p = cenOfs;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`bad central dir at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const mtime = buf.readUInt16LE(p + 12);
    const mdate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const locOfs = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if ((flags & 0x1) !== 0) throw new Error('encrypted zip not supported');
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip64 not supported');

    // local header：算出这个 entry 的完整原始片段 [local header + data (+ descriptor)]
    if (buf.readUInt32LE(locOfs) !== LOC_SIG) throw new Error(`bad local header for ${name}`);
    const locNameLen = buf.readUInt16LE(locOfs + 26);
    const locExtraLen = buf.readUInt16LE(locOfs + 28);
    const dataStart = locOfs + 30 + locNameLen + locExtraLen;
    let rawEnd = dataStart + csize;
    if (flags & 0x8) {
      // data descriptor: 可带可不带签名 0x08074b50
      if (buf.readUInt32LE(rawEnd) === 0x08074b50) rawEnd += 16; else rawEnd += 12;
    }
    const entry = {
      name, flags, method, mtime, mdate, crc, csize, usize, attrs,
      cenExtra: Buffer.from(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)),
      comment: Buffer.from(buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)),
      locRaw: Buffer.from(buf.subarray(locOfs, rawEnd)),
      dataOfs: dataStart - locOfs,
      replaced: null,
    };
    entries.set(name, entry);
    order.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, order };
}

export function entryData(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  if (e.replaced) return e.replaced;
  const raw = e.locRaw.subarray(e.dataOfs, e.dataOfs + e.csize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported method ${e.method} for ${name}`);
}

export function replaceEntry(zip, name, content) {
  const e = zip.entries.get(name);
  if (!e) throw new Error(`no such entry: ${name}`);
  e.replaced = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

export function addEntry(zip, name, content) {
  if (zip.entries.has(name)) return replaceEntry(zip, name, content);
  const e = {
    name, flags: 0x800 /* utf8 name */, method: 8, mtime: 0, mdate: 0x2100 /* 1996-08-00 stable */,
    crc: 0, csize: 0, usize: 0, attrs: 0,
    cenExtra: Buffer.alloc(0), comment: Buffer.alloc(0),
    locRaw: null, dataOfs: 0,
    replaced: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
  };
  zip.entries.set(name, e);
  zip.order.push(name);
}

export function writeZip(zip) {
  const chunks = [];
  const cen = [];
  let offset = 0;
  for (const name of zip.order) {
    const e = zip.entries.get(name);
    let locBuf; let crc; let csize; let usize; let method; let flags;
    if (e.replaced == null) {
      locBuf = e.locRaw;                       // 原样拷贝（保真核心）
      crc = e.crc; csize = e.csize; usize = e.usize; method = e.method; flags = e.flags;
    } else {
      const data = e.replaced;
      const packed = deflateRawSync(data, { level: 9 });
      method = packed.length < data.length ? 8 : 0;
      const body = method === 8 ? packed : data;
      crc = crc32(data) >>> 0;
      csize = body.length; usize = data.length;
      flags = 0x800; // utf8 filename，不用 descriptor
      const nameBuf = Buffer.from(name, 'utf8');
      const head = Buffer.alloc(30);
      head.writeUInt32LE(LOC_SIG, 0);
      head.writeUInt16LE(20, 4);       // version needed
      head.writeUInt16LE(flags, 6);
      head.writeUInt16LE(method, 8);
      head.writeUInt16LE(e.mtime, 10);
      head.writeUInt16LE(e.mdate, 12);
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(csize, 18);
      head.writeUInt32LE(usize, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(0, 28);
      locBuf = Buffer.concat([head, nameBuf, body]);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CEN_SIG, 0);
    c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(e.mtime, 12); c.writeUInt16LE(e.mdate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20); c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(e.cenExtra.length, 30);
    c.writeUInt16LE(e.comment.length, 32);
    c.writeUInt32LE(e.attrs, 38);
    c.writeUInt32LE(offset, 42);
    cen.push(Buffer.concat([c, nameBuf, e.cenExtra, e.comment]));
    chunks.push(locBuf);
    offset += locBuf.length;
  }
  const cenStart = offset;
  let cenSize = 0;
  for (const c of cen) { chunks.push(c); cenSize += c.length; }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(zip.order.length, 8);
  eocd.writeUInt16LE(zip.order.length, 10);
  eocd.writeUInt32LE(cenSize, 12);
  eocd.writeUInt32LE(cenStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}
