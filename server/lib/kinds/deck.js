/**
 * kinds/deck.js — deck 形态（演示 / 长图 / 单页报告）
 *
 * 形态契约见 kinds/index.js。deck 是「源即产物」的退化形态：
 * canvas.html 既是工作对象也是被导出的东西，产物根永远是任务根。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

const ENTRY = 'canvas.html';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export default {
  id: 'deck',
  entryFile: ENTRY,
  view: 'deck',
  injectFit: true,          // 导出 / 独立打开时注入整屏翻页 fit script
  capabilities: ['browsable'],   // 入口是 html，能塞进 iframe / playwright
  exportFormats: ['html', 'pdf', 'pptx', 'handoff'],
  referenceDoc: { file: 'hybrid-reference', title: 'Hybrid deck 技术参考' },

  detect: (taskDir) => exists(path.join(taskDir, ENTRY)),

  // deck 没有构建这回事，产物根 = 任务根
  artifactRoot: async () => '',

  /**
   * deck 实例发现（2026-07-29 多产物平权）：任务根顶层每个 .html 各是一份
   * **平等的** deck，没有主次。canvas.html 只是常用名（判定证据 + 无提示时
   * 的排序偏好），不再有"主 deck / 试作"等级。
   *
   * @param {boolean} [opts.rootSiteExists]  任务根是一个站点时，顶层散装
   *        .html 是站点页面不是 deck —— 只有 canvas.html（范式保留名）除外
   */
  async discoverInstances(taskDir, _marker, opts = {}) {
    let entries = [];
    try { entries = await fs.readdir(taskDir, { withFileTypes: true }); } catch { /* */ }
    return entries
      .filter(e => e.isFile() && /\.html?$/i.test(e.name) && !e.name.startsWith('.'))
      .map(e => e.name)
      .filter(f => !opts.rootSiteExists || f === ENTRY)
      .sort((a, b) => (b === ENTRY) - (a === ENTRY) || a.localeCompare(b))
      .map(f => ({ file: f }));
  },

  async instanceManifest(taskDir, _marker, inst) {
    return {
      kind: 'deck',
      root: '',
      srcRoot: '',
      entry: inst.file,
      entryRel: inst.file,
      file: inst.file,
      pages: null,
      single: false,
      title: inst.file === ENTRY ? null : inst.file.replace(/\.html?$/i, ''),
    };
  },

  /** 每轮注入的产物清单里，这份 deck 的一行说明 */
  async describe(taskDir, artifact) {
    const entryAbs = path.join(taskDir, artifact.entryRel);
    const label = `deck ${artifact.entryRel}`;
    try {
      const stat = await fs.stat(entryAbs);
      if (stat.size > 512 * 1024) return `${label} · ${(stat.size / 1024).toFixed(0)}KB，Read 时配 limit 分段读`;
      const raw = await fs.readFile(entryAbs, 'utf8');
      const n = (raw.match(/<section\b[^>]*\bdata-page=/g) || []).length;
      return n > 0 ? `${label} · ${n} 页` : `${label} · 还没有 <section data-page=> 分页结构`;
    } catch { return `${label} · 入口读不到`; }
  },
};
