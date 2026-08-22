/**
 * server/runtime/capabilities.js — 本机能力位：外部二进制 / 外部服务钥匙 / 本地产线，启动时探一遍，
 * 工具注册与界面都问它（一份表，两个读者）。
 *
 * 为什么需要它（08-22 盘点）：仓库里同一件事有三种写法——ffmpeg 有 hasFfmpeg() 探针并降级、rembg 有
 * isAvailable() 返回可操作的装法、playwright 20 个调用点里只有 2 个接住了「Executable doesn't exist」，
 * 其余是 500 或一条裸的工具错误。本地分发版装在别人的机器上，缺依赖是常态不是事故：
 *   - 工具层：engine/mcp/capability-gate.js 按这里的结果给工具描述加「⛔ 不可用 + 装法」、调用期直接拦
 *   - 界面层：GET /api/local/status 带 capabilities，配置页画成一张表
 *   - 日志层：platform.dump 之后打一行汇总
 *
 * 探测只在启动做一次（二进制装好了要重启；配置页的「重启」按钮就是干这个的）。
 * 探不到 ≠ 不存在：whichBinary 按 PATH + 几个已知安装位置找，找不到就如实说 detail，别替用户猜。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAvailable as rembgAvailable } from '../engine/mcp/tools/helpers/rembg.js';

const isWin = process.platform === 'win32';

/** 跨平台 which：PATH（Windows 连 PATHEXT）+ 调用方给的额外目录。找不到返回 null */
export function whichBinary(name, extraDirs = []) {
  if (!name) return null;
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs];
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWin && !name.toLowerCase().endsWith(ext) ? name + ext : name);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

const home = os.homedir();
const LO_DIRS = isWin
  ? ['C:\\Program Files\\LibreOffice\\program', 'C:\\Program Files (x86)\\LibreOffice\\program']
  : process.platform === 'darwin'
    ? ['/Applications/LibreOffice.app/Contents/MacOS', path.join(home, 'Applications/LibreOffice.app/Contents/MacOS')]
    : ['/usr/lib/libreoffice/program', '/opt/libreoffice/program', '/snap/bin'];
const BREW_DIRS = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];

/**
 * 能力表。kind：binary | key | service。level：'required'（没有就跑不起来）| 'feature'（少一块功能）。
 * fix 写给人看：装法一句话。probe 返回 { available, detail, path? }。
 */
export const CAPABILITY_DEFS = Object.freeze([
  { id: 'git', kind: 'binary', level: 'required', label: 'git', uses: '项目工作区的版本历史（建项目就要用）',
    fix: isWin ? '装 Git for Windows（git-scm.com），装完重开终端' : 'apt/brew install git',
    probe: () => bin('git') },
  { id: 'chromium', kind: 'binary', level: 'feature', label: 'Chromium（playwright）', uses: '截图自检 / 页面感知 / 浏览器工具 / PDF·PPTX 导出 / 封面',
    fix: 'npx playwright install chromium',
    probe: async () => {
      let pw;
      try { pw = await import('playwright'); } catch (err) { return { available: false, detail: `playwright 包加载失败：${err.message}` }; }
      let p = null;
      try { p = pw.chromium.executablePath(); } catch (err) { return { available: false, detail: `executablePath: ${err.message}` }; }
      return p && fs.existsSync(p) ? { available: true, detail: p, path: p } : { available: false, detail: `浏览器未下载（期望在 ${p || '?'}）` };
    } },
  { id: 'libreoffice', kind: 'binary', level: 'feature', label: 'LibreOffice（soffice）', uses: 'Word/docx 形态：渲页图、缩略图、导出 PDF、build_docx 的页图体检',
    fix: isWin ? '官网装 LibreOffice（默认装到 C:\\Program Files\\LibreOffice）' : process.platform === 'darwin' ? 'brew install --cask libreoffice' : 'apt install libreoffice',
    probe: () => bin('soffice', LO_DIRS) },
  { id: 'poppler', kind: 'binary', level: 'feature', label: 'poppler（pdftoppm）', uses: 'docx 页图（PDF → PNG）',
    fix: isWin ? '装 poppler for Windows 并把 bin 目录加进 PATH' : process.platform === 'darwin' ? 'brew install poppler' : 'apt install poppler-utils',
    probe: () => bin('pdftoppm', BREW_DIRS) },
  { id: 'ffmpeg', kind: 'binary', level: 'feature', label: 'ffmpeg', uses: '视频转码（没有就发原片）',
    fix: isWin ? '装 ffmpeg 并加进 PATH' : process.platform === 'darwin' ? 'brew install ffmpeg' : 'apt install ffmpeg',
    probe: () => bin('ffmpeg', BREW_DIRS) },
  { id: 'rembg', kind: 'service', level: 'feature', label: 'rembg 抠图环境', uses: 'remove_background',
    fix: 'python3 -m venv server/.venv-rembg && server/.venv-rembg/bin/pip install rembg onnxruntime（见 server/services/rembg-launcher.js）',
    probe: async () => { const r = await rembgAvailable(); return { available: r.available, detail: r.available ? `mode=${r.mode}` : r.reason }; } },
  { id: 'imageGen', kind: 'service', level: 'feature', label: '生图通道', uses: 'generate_image',
    fix: '默认走 codex CLI：npm i -g @openai/codex && codex login；或 NODESIGN_IMAGE_PROVIDER=gateway + NODESIGN_GATEWAY_KEY',
    probe: () => {
      const provider = (process.env.NODESIGN_IMAGE_PROVIDER || 'codex').toLowerCase();
      if (provider === 'gateway') return { available: !!process.env.NODESIGN_GATEWAY_KEY, detail: process.env.NODESIGN_GATEWAY_KEY ? 'gateway（NODESIGN_GATEWAY_KEY 已配）' : 'NODESIGN_GATEWAY_KEY 为空' };
      const r = bin(process.env.NODESIGN_CODEX_BIN || 'codex');
      return { ...r, detail: r.available ? `codex：${r.detail}（是否已 codex login 这里探不到）` : `codex CLI 不在 PATH（${r.detail}）` };
    } },
  { id: 'webSearch', kind: 'key', level: 'feature', label: '联网搜索钥匙', uses: 'web_search',
    fix: '.env 里配 NODESIGN_TAVILY_KEY / NODESIGN_EXA_KEY / NODESIGN_BAIDU_QIANFAN_KEY / NODESIGN_ZHIPU_KEY 任一',
    probe: () => anyEnv(['NODESIGN_TAVILY_KEY', 'NODESIGN_EXA_KEY', 'NODESIGN_BAIDU_QIANFAN_KEY', 'NODESIGN_ZHIPU_KEY']) },
  { id: 'publish', kind: 'key', level: 'feature', label: 'Cloudflare Pages 发布', uses: 'publish_site（一键上线四级域名）',
    fix: '.env 里配 CLOUDFLARE_API_TOKEN + NODESIGN_PUBLISH_DOMAIN（+ NODESIGN_CF_ACCOUNT_ID），并装 wrangler（npm i -g wrangler）',
    probe: () => {
      const missing = ['CLOUDFLARE_API_TOKEN', 'NODESIGN_PUBLISH_DOMAIN'].filter((k) => !process.env[k]);
      if (missing.length) return { available: false, detail: `${missing.join(', ')} 为空` };
      const w = bin('wrangler', [path.dirname(process.execPath)]);
      return w.available ? { available: true, detail: `wrangler：${w.detail}`, path: w.path } : { available: false, detail: 'wrangler 不在 PATH 也不在 node 同目录' };
    } },
  { id: 'localBox', kind: 'service', level: 'feature', label: '本地 GPU 盒子（paint_still / roll_film）', uses: '自部署生图 / 文生视频',
    fix: 'NODESIGN_LOCAL_BOX=on + NODESIGN_H3BOX_SSH（站主自己的 5090 盒子；一般用户用不上）',
    probe: () => (process.env.NODESIGN_LOCAL_BOX === 'on' && process.env.NODESIGN_H3BOX_SSH
      ? { available: true, detail: process.env.NODESIGN_H3BOX_SSH } : { available: false, detail: process.env.NODESIGN_LOCAL_BOX === 'on' ? 'NODESIGN_H3BOX_SSH 为空' : 'NODESIGN_LOCAL_BOX 未开' }) },
]);

function bin(name, extra = []) {
  const p = whichBinary(name, extra);
  return p ? { available: true, detail: p, path: p } : { available: false, detail: `${name} 不在 PATH${extra.length ? '（也不在常见安装位置）' : ''}` };
}
function anyEnv(names) {
  const hit = names.find((n) => !!process.env[n]);
  return hit ? { available: true, detail: `${hit} 已配` } : { available: false, detail: `${names.join(' / ')} 都为空` };
}

/** id → { id, kind, level, label, uses, fix, available, detail, path? }。probeCapabilities 之前是空的 */
const state = new Map();
let probed = null;

export async function probeCapabilities({ force = false } = {}) {
  if (probed && !force) return probed;
  probed = (async () => {
    for (const def of CAPABILITY_DEFS) {
      let r;
      try { r = await def.probe(); } catch (err) { r = { available: false, detail: `探测出错：${err.message}` }; }
      const { probe: _p, ...meta } = def;
      state.set(def.id, Object.freeze({ ...meta, available: !!r.available, detail: r.detail || '', ...(r.path ? { path: r.path } : {}) }));
    }
    return capabilitySnapshot();
  })();
  return probed;
}

export function capabilitySnapshot() {
  return CAPABILITY_DEFS.map((d) => state.get(d.id)).filter(Boolean);
}

/** 没探过（单测 / 脚本直接 import 工具）→ null，调用方当「不知道」= 不拦 */
export function capabilityState(id) {
  return state.get(id) || null;
}

/** 给 spawn 用的可执行路径：探到了就用绝对路径（Mac/Win 的 LibreOffice 不在 PATH），没探或没探到就原名（让 ENOENT 原样报） */
export function resolveBinary(capId, fallbackName) {
  const s = state.get(capId);
  return s?.available && s.path ? s.path : fallbackName;
}

/** 启动日志一行汇总 */
export function summarizeCapabilities() {
  const snap = capabilitySnapshot();
  const ok = snap.filter((c) => c.available).map((c) => c.id);
  const missing = snap.filter((c) => !c.available);
  const lines = [`[capabilities] 可用 ${ok.length}/${snap.length}：${ok.join(' ') || '(无)'}`];
  for (const c of missing) lines.push(`  ${c.level === 'required' ? '⛔' : '○'} ${c.id}（${c.label}）：${c.detail} → ${c.fix}`);
  return lines.join('\n');
}
