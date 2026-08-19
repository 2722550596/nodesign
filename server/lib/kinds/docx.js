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
 * 实例发现两者都认，是因为「外来 docx 也是 word 任务」这件事从第一天就成立，
 * 等接编辑那一段再改判据 = 到时候要动寻址、导出、前端三处。
 *
 * ⚠️ 判定次序：docx 排在 deck / site **之后**（taskManifest 里 docx 实例最后 append）。
 * 任务里同时有 canvas.html / index.html 和一个 .docx 时，那个 docx 是素材不是
 * 产物，不能把整个任务判成 word。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { isReservedFile, RESERVED_DIRS } from '../task-scan.js';

/** token + 内容的源文件名。产物 .docx 与它同级同名 */
const SOURCE = '文档.json';

/** 无更好信号时的默认产物名（跟源同名，`文档.json` → `文档.docx`） */
const ENTRY = '文档.docx';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * 一堆文件名 → 排好序的产物 .docx 名单（排掉保留文件和临时文件）。
 * 导出收集器（export-collect）反解 `docx:<文件夹>` 卡时用同一份判据挑主成员，
 * 别在那边再抄一遍排序。
 */
function sortDocxNames(names) {
  return names
    .filter(n => /\.docx$/i.test(n))
    // Word 自己开着文件时会留 `~$xxx.docx` 锁文件，那不是产物
    .filter(n => !n.startsWith('.') && !n.startsWith('~$'))
    .filter(n => !isReservedFile(n))
    .sort((a, b) => (b === ENTRY) - (a === ENTRY) || a.localeCompare(b, 'zh'));
}

/** 目录顶层的 .docx */
async function topLevelDocx(dir) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { /* */ }
  return sortDocxNames(entries.filter(e => e.isFile()).map(e => e.name));
}

/**
 * word 文件夹（2026-08-18）：一级子目录顶层有 .docx（或 token 源）、且没有任何
 * 网页入口 → 整个文件夹是**一件**目录型 word 产物，里面的 .docx 是它的成员
 * （多版本并排放，窗里切换）。这跟 site 的「无根站时一级子目录各自为站」同构。
 *
 * 「没有网页入口」这条挡两种误伤：站点内部目录（posts/ 里全是 html）和
 * deck 文件夹 —— 它们各有自己的解析器，word 不去认领。
 */
async function wordDirs(taskDir) {
  const out = [];
  let entries = [];
  try { entries = await fs.readdir(taskDir, { withFileTypes: true }); } catch { /* */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (RESERVED_DIRS.has(e.name)) continue;
    let sub = [];
    try { sub = await fs.readdir(path.join(taskDir, e.name), { withFileTypes: true }); } catch { continue; }
    if (sub.some(x => x.isFile() && /\.html?$/i.test(x.name))) continue;
    const files = sortDocxNames(sub.filter(x => x.isFile()).map(x => x.name));
    if (files.length) out.push({ dir: e.name, files });
    else if (sub.some(x => x.isFile() && x.name === SOURCE)) {
      // 源已就位、还没 build 的窗口期：跟根层 pending 同款「声明即意图」
      out.push({ dir: e.name, files: [ENTRY], pending: true });
    }
  }
  return out;
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

  // 目录型实例判据（卡即文件夹）：word 文件夹带成员表；根层散放的单份 .docx
  // 是单文件产物。全仓只问 isDirArtifact（kinds/index.js），别在调用点自判
  directory: (a) => !!a.members,

  // 源和产物同住任务根，没有构建目录这回事
  artifactRoot: async () => '',

  /**
   * 实例发现，两种粒度：
   *   - **根层**每个 .docx 各是一份单文件产物（跟 deck 顶层每个 .html 同构）——
   *     桌面上并排躺着的文档未必互相有关，不硬捆成一组
   *   - **word 文件夹**（一级子目录）整个是一件目录型产物，里面的 .docx 全是
   *     它的成员（多版本并排，窗里的导航切换）—— 跟 site 的子目录站同构
   *
   * 特例：有 `文档.json` 但还没构建出 .docx 时，也要报一份 —— 这是 site.js
   * 「声明即意图」那条的同款处理（agent 刚写完源还没 build 的窗口期，寻址该
   * 指向将要出现的地方，而不是让整个任务在那几秒里没有形态）。
   */
  async discoverInstances(taskDir) {
    const out = [];
    const files = await topLevelDocx(taskDir);
    if (files.length) out.push(...files.map(f => ({ file: f })));
    else if (await exists(path.join(taskDir, SOURCE))) out.push({ file: ENTRY, pending: true });
    out.push(...await wordDirs(taskDir));
    return out;
  },

  async instanceManifest(taskDir, _marker, inst) {
    // ── word 文件夹：目录型实例，members 是它的版本清单 ──
    if (inst.dir) {
      const members = [];
      for (const f of inst.files) {
        const stem = f.replace(/\.docx$/i, '');
        members.push({
          file: `${inst.dir}/${f}`,
          title: stem === '文档' ? inst.dir : stem,
          sourceFile: (await exists(path.join(taskDir, inst.dir, `${stem}.json`)))
            ? `${inst.dir}/${stem}.json` : null,
        });
      }
      const primary = members[0];
      return {
        kind: 'docx',
        // root = 文件夹本身：前端卡 id（docx:<root>）和舞台寻址的认领范围都从它来
        root: inst.dir,
        srcRoot: inst.dir,
        entry: primary.file,
        entryRel: primary.file,
        // file 仍指主成员（不是 null）：单文件消费方（卡脸的第一页缩略图、
        // setActiveArtifact、导出兜底）拿它就能干活，不用都学会 members
        file: primary.file,
        members,
        pages: null,
        single: false,
        title: inst.dir,
        sourceFile: primary.sourceFile,
      };
    }
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

  // 给别处复用，别再各写各的字符串 / 排序
  SOURCE,
  sortDocxNames,
};
