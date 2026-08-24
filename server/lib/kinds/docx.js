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

/* ── 源文件配对（2026-08-19 自动纠偏） ─────────────────────────
 *
 * 约定是源和产物同 stem（文档.json → 文档.docx），但 agent 真会写出
 * `刘万钢-简历-v3.docx` + `文档-v3.json` 这种组合（生产实锤）——按老判据
 * sourceFile 关联不上，窗里「看源码」消失、banner 误标「外来文档」，下一个
 * 会话就真把它当外来文档改。所以 stem 对不上时做两级兜底，宁缺勿错：
 * 配错源比配不上更坏（agent 会去改一份别的文档的 JSON 然后 build 覆盖）。
 */

/** 这份 json 长得像不像 docx 的 token 源（content 数组 + preset/tokens 至少一样） */
async function isDocxSourceShape(absPath) {
  try {
    const stat = await fs.stat(absPath);
    if (stat.size > 2 * 1024 * 1024) return false;   // 源文件不会大到哪去，超了就不是
    const j = JSON.parse(await fs.readFile(absPath, 'utf8'));
    return !!j && Array.isArray(j.content)
      && (typeof j.preset === 'string' || (j.tokens && typeof j.tokens === 'object' && !Array.isArray(j.tokens)));
  } catch { return false; }
}

const stemOf = (n) => n.replace(/\.(docx|json)$/i, '');
/** 末尾的版本记号（要带分隔符：`-v3` / `_2` 算，`报告2024` 不算 —— 裸尾数太容易撞） */
const verOf = (n) => (stemOf(n).match(/[-_][vV]?(\d+)$/) || [])[1] ?? null;

/**
 * docx 名单 × 源候选名单 → Map(docx 名 → 源名)。纯函数，好测。
 * 三级：同 stem 精确 → 版本记号唯一对唯一 → 双方各剩一个。
 * 剩下的一律不配（多对一/一对多是歧义，配错的代价见上）。
 */
export function pairDocxSources(docxNames, jsonNames) {
  const res = new Map();
  const freeJson = new Set(jsonNames);
  for (const d of docxNames) {
    const want = `${stemOf(d)}.json`;
    if (freeJson.has(want)) { res.set(d, want); freeJson.delete(want); }
  }
  const freeDocx = docxNames.filter(d => !res.has(d));
  // 版本记号：两边都唯一才配（v2/v3 各一份的多版本文件夹就是这形状）
  const byVer = (names) => {
    const m = new Map();
    for (const n of names) {
      const v = verOf(n);
      if (v == null) continue;
      m.set(v, m.has(v) ? null : n);   // 同版本出现两次 = 歧义，记 null
    }
    return m;
  };
  const dv = byVer(freeDocx);
  const jv = byVer([...freeJson]);
  for (const [v, d] of dv) {
    const j = jv.get(v);
    if (d && j) { res.set(d, j); freeJson.delete(j); }
  }
  const left = docxNames.filter(d => !res.has(d));
  if (left.length === 1 && freeJson.size === 1) res.set(left[0], [...freeJson][0]);
  return res;
}

/**
 * 目录顶层的源配对结果 Map(docx 名 → 源名)。
 * 同 stem 直接认（命名约定本身就是信号，不读文件 —— pending 半写状态的源也认，
 * 跟老判据一致）；只有剩下配不上的才读 json 做形状校验再进模糊配对 —— 目录里
 * 躺着的 data.json / 配置文件不能被当成源认走。命名规矩的目录一个文件都不读。
 */
async function resolveSources(dirAbs, docxNames) {
  let entries = [];
  try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { /* */ }
  const jsons = entries
    .filter(e => e.isFile() && /\.json$/i.test(e.name) && !e.name.startsWith('.') && !isReservedFile(e.name))
    .map(e => e.name);
  const res = new Map();
  const claimed = new Set();
  for (const d of docxNames) {
    const want = `${stemOf(d)}.json`;
    if (jsons.includes(want) && !claimed.has(want)) { res.set(d, want); claimed.add(want); }
  }
  const freeDocx = docxNames.filter(d => !res.has(d));
  if (!freeDocx.length) return res;
  const fuzzy = [];
  for (const n of jsons) {
    if (!claimed.has(n) && await isDocxSourceShape(path.join(dirAbs, n))) fuzzy.push(n);
  }
  for (const [d, j] of pairDocxSources(freeDocx, fuzzy)) res.set(d, j);
  return res;
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
      const pairs = await resolveSources(path.join(taskDir, inst.dir), inst.files);
      const members = [];
      for (const f of inst.files) {
        const stem = f.replace(/\.docx$/i, '');
        const src = pairs.get(f);
        members.push({
          file: `${inst.dir}/${f}`,
          title: stem === '文档' ? inst.dir : stem,
          sourceFile: src ? `${inst.dir}/${src}` : null,
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
    // 配对要看根层**全部** docx（唯一候选那级的语义是"整个目录里就这一对"）；
    // pending 实例的 docx 还没落盘，不在 topLevelDocx 里，补进去让同 stem 那级认
    const roots = await topLevelDocx(taskDir);
    if (!roots.includes(inst.file)) roots.push(inst.file);
    const pairs = await resolveSources(taskDir, roots);
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
      sourceFile: pairs.get(inst.file) ?? null,
    };
  },

  /** 每轮注入的产物清单里，这份文档的一行说明 */
  async describe(taskDir, artifact) {
    const label = `word ${artifact.entryRel}`;
    const src = artifact.sourceFile;
    // 文件夹里的**全部**成员都要点名（08-19 案：目录里 v3/v4 两份，清单只报
    // 默认那份，agent 对着过时的 v3 干了一整轮 —— 注入的清单让人默认它是全的，
    // 半份状态比没状态更误导）
    const others = (artifact.members || [])
      .map(m => m.file)
      .filter(f => f && f !== artifact.entryRel);
    const memberNote = others.length ? ` · 同夹还有：${others.join(' / ')}` : '';
    try {
      const stat = await fs.stat(path.join(taskDir, artifact.entryRel));
      const kb = (stat.size / 1024).toFixed(0);
      return src
        ? `${label} · ${kb}KB · 源 ${src}（改源重建，别直接改 .docx）${memberNote}`
        : `${label} · ${kb}KB · 外来文档，没有 token 源${memberNote}`;
    } catch {
      return src
        ? `${label} · 还没构建（源 ${src} 已就位）${memberNote}`
        : `${label} · 入口读不到${memberNote}`;
    }
  },

  // 给别处复用，别再各写各的字符串 / 排序
  SOURCE,
  sortDocxNames,
};
