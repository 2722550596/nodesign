/**
 * kinds/docx.js — word 形态（.docx 正式文档）
 *
 * 形态契约见 kinds/index.js。docx 跟前两种形态有一处**结构性差异**：
 * 它是第一个 `browsable: false` 的形态 —— 入口是二进制包，塞不进 iframe，
 * playwright 也打不开。感知层为此新增 `renderable` 能力位：能力位说的是
 * 「这东西怎么才能被看见」，screenshot 按能力分流（renderable → LibreOffice
 * 渲成页图），agent 那边动词不变，还是「做完看一眼」。
 *
 * 源与产物：
 *   文档.json  —— token + 内容的**真相源**（我们自己造的文档走这条）
 *   *.docx     —— 构建产物；也可能是用户上传的外来文档（那时没有 json 源）
 *
 * detect 两者都认，是因为「外来 docx 也是 word 任务」这件事从第一天就成立，
 * 等接编辑那一段再改判据 = 到时候要动寻址、导出、前端三处。
 *
 * ⚠️ 判定次序：docx 排在 deck / site **之后**（见 index.js 的 KIND_ORDER）。
 * 任务里同时有 canvas.html / index.html 和一个 .docx 时，那个 docx 是素材不是
 * 产物，不能把整个任务判成 word。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { isReservedFile } from '../task-scan.js';

/** token + 内容的源文件名。产物 .docx 与它同级同名 */
const SOURCE = '文档.json';

/** 无更好信号时的默认产物名（跟源同名，`文档.json` → `文档.docx`） */
const ENTRY = '文档.docx';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 任务根顶层的 .docx（排掉保留文件和临时文件） */
async function topLevelDocx(taskDir) {
  let entries = [];
  try { entries = await fs.readdir(taskDir, { withFileTypes: true }); } catch { /* */ }
  return entries
    .filter(e => e.isFile() && /\.docx$/i.test(e.name))
    // Word 自己开着文件时会留 `~$xxx.docx` 锁文件，那不是产物
    .filter(e => !e.name.startsWith('.') && !e.name.startsWith('~$'))
    .filter(e => !isReservedFile(e.name))
    .map(e => e.name)
    .sort((a, b) => (b === ENTRY) - (a === ENTRY) || a.localeCompare(b, 'zh'));
}

export default {
  id: 'docx',
  entryFile: ENTRY,
  view: 'docx',
  injectFit: false,
  // ⭐第一个不可浏览的形态。'renderable' = 要先渲染成页图才能被看见
  capabilities: ['renderable'],
  // raw 排头：.docx 本身就是交付物，这跟 deck/site「导出是二次加工」不一样
  exportFormats: ['raw', 'pdf'],

  /** 有 token 源、或者有现成 .docx（含用户上传的外来文档），都算 word 任务 */
  async detect(taskDir) {
    if (await exists(path.join(taskDir, SOURCE))) return true;
    return (await topLevelDocx(taskDir)).length > 0;
  },

  // 源和产物同住任务根，没有构建目录这回事
  artifactRoot: async () => '',

  /**
   * 实例发现：顶层每个 .docx 各是一份平等产物（跟 deck 顶层每个 .html 同构）。
   *
   * 特例：有 `文档.json` 但还没构建出 .docx 时，也要报一份 —— 这是 site.js
   * 「声明即意图」那条的同款处理（agent 刚写完源还没 build 的窗口期，寻址该
   * 指向将要出现的地方，而不是让整个任务在那几秒里没有形态）。
   */
  async discoverInstances(taskDir) {
    const files = await topLevelDocx(taskDir);
    if (files.length) return files.map(f => ({ file: f }));
    if (await exists(path.join(taskDir, SOURCE))) return [{ file: ENTRY, pending: true }];
    return [];
  },

  async instanceManifest(taskDir, _marker, inst) {
    const stem = inst.file.replace(/\.docx$/i, '');
    return {
      kind: 'docx',
      root: '',
      srcRoot: '',
      entry: inst.file,
      entryRel: inst.file,
      file: inst.file,
      // 页数只有渲染过才知道，而 manifest 每轮都要算 —— 不能为了一个数去跑
      // LibreOffice。页数由 screenshot 返回时才给。
      pages: null,
      single: false,
      title: stem === '文档' ? null : stem,
      // 有没有 token 源，决定了「改它」走重建还是走手术（见 dump-styles.js）
      sourceFile: (await exists(path.join(taskDir, `${stem}.json`))) ? `${stem}.json` : null,
    };
  },

  /** 每轮注入的产物清单里，这份文档的一行说明 */
  async describe(taskDir, artifact) {
    const label = `word ${artifact.entryRel}`;
    const src = artifact.sourceFile;
    try {
      const stat = await fs.stat(path.join(taskDir, artifact.entryRel));
      const kb = (stat.size / 1024).toFixed(0);
      return src
        ? `${label} · ${kb}KB · 源 ${src}（改源重建，别直接改 .docx）`
        : `${label} · ${kb}KB · 外来文档，没有 token 源`;
    } catch {
      return src
        ? `${label} · 还没构建（源 ${src} 已就位）`
        : `${label} · 入口读不到`;
    }
  },

  // 给别处复用，别再各写各的字符串
  SOURCE,
};
