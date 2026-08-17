/**
 * build-from-source.js — 「token 源文件 → .docx」这一步。
 *
 * ⭐**token JSON 是真相源，.docx 是构建产物。** 所以 agent 改的永远是那份
 * JSON，不是 docx —— 直接改产物等于让源和产物各说各话，下一次构建就把手改
 * 的东西抹掉了（这条是 [[nodesign-truth-sources]] 那笔债的预防）。
 *
 * 源文件形状：
 * {
 *   "preset":  "公文",             // 词典条目名。风格**名字层开放**：这是起点不是牢笼
 *   "tokens":  { ... },            // 在 preset 之上覆写；不给 preset 时它就是全部
 *   "content": [ {t:'p', ...} ],   // 正文块
 *   "header":  "页眉文字",          // 可选
 *   "footer":  "页脚文字"           // 可选
 * }
 *
 * schema 是**闭合**的：`validateTokens` 见到没登记过的键直接报错。闭合的是
 * 「哪些问题必须回答」，不是「答案是什么」—— 这跟「不预设范式」不打架。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PRESETS, validateTokens } from './tokens.js';
import { buildDocx } from './build.js';

/** 深合并：对象递归，其余（含数组）整体替换 —— 数组是有序整体，逐项合并只会得到怪东西 */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}

export class DocxSourceError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

/**
 * 解析源对象 → { tokens, content, opts }。不碰文件系统，方便单测。
 */
export function resolveSource(src) {
  if (!src || typeof src !== 'object') {
    throw new DocxSourceError('源文件不是一个 JSON 对象');
  }
  let tokens;
  if (src.preset) {
    const make = PRESETS[src.preset];
    if (!make) {
      throw new DocxSourceError(
        `没有叫「${src.preset}」的词典条目`,
        `现有：${Object.keys(PRESETS).join(' / ')}。要别的风格就不写 preset，直接给完整 tokens。`,
      );
    }
    tokens = merge(make(), src.tokens);
  } else {
    tokens = src.tokens;
    if (!tokens) throw new DocxSourceError('既没给 preset 也没给 tokens，不知道按什么排版');
  }

  const errs = validateTokens(tokens);
  if (errs.length) {
    throw new DocxSourceError('token 没过校验', errs.slice(0, 12).join('\n'));
  }

  const content = src.content;
  if (!Array.isArray(content) || !content.length) {
    throw new DocxSourceError('content 是空的，构建出来会是一份白纸');
  }
  // 早点把块类型的错说清楚 —— 让它掉进 buildBody 里报 `unknown block: undefined`
  // 对 agent 是没有信息量的
  const bad = content.findIndex(b => !b || !['p', 'table', 'pageBreak'].includes(b.t));
  if (bad >= 0) {
    throw new DocxSourceError(
      `content[${bad}] 的 t 认不出：${JSON.stringify(content[bad]?.t)}`,
      "块类型只有三种：{t:'p'} 段落、{t:'table'} 表格、{t:'pageBreak'} 分页。",
    );
  }

  return { tokens, content, opts: { header: hdrFtr(src.header), footer: hdrFtr(src.footer) } };
}

/**
 * 页眉页脚两种写法都收：
 *   "第一页"                     → 一行纯文字（最常见，别逼人写块数组）
 *   [{t:'p', runs:[..., {fld:'PAGE'}]}]  → 完整块，页码域这类要靠它
 *
 * ⚠️ 页码是**域**（`{fld:'PAGE'}`），不是你手写的那个数字 —— 写死 "1" 的页脚
 * 在第二页还是 1。要真页码就得用块写法。
 */
function hdrFtr(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v;
  return [{ t: 'p', style: 'Normal', text: String(v) }];
}

/**
 * 读源文件、构建、写产物。
 * @returns {Promise<{outPath:string, bytes:number, blocks:number, styles:number, preset:string|null}>}
 */
export async function buildFromSource(sourceAbsPath, outAbsPath) {
  let raw;
  try {
    raw = await fs.readFile(sourceAbsPath, 'utf8');
  } catch {
    throw new DocxSourceError(`读不到源文件：${path.basename(sourceAbsPath)}`);
  }
  let src;
  try {
    src = JSON.parse(raw);
  } catch (err) {
    throw new DocxSourceError('源文件不是合法 JSON', err.message);
  }

  const { tokens, content, opts } = resolveSource(src);
  const buf = await buildDocx(tokens, content, opts);
  await fs.writeFile(outAbsPath, buf);
  return {
    outPath: outAbsPath,
    bytes: buf.length,
    blocks: content.length,
    styles: Object.keys(tokens.styles ?? {}).length,
    preset: src.preset ?? null,
  };
}
