/**
 * kinds/index.js — 产物形态注册表（2026-07-29）
 *
 * 一种形态 = 一份注册条目。加第三种形态（比如视频：shots/ 镜头集 + output/
 * 成片）应该只需要在这里挂一个新模块 + 前端加一个对应的窗组件 ——
 * 寻址层、刷新链路、桌面派生、导出守卫都从注册表读，不再各写各的 if。
 *
 * 形态契约（每个 kind 模块导出的字段）：
 *   id             'deck' | 'site' | …
 *   entryFile      入口文件名（文件即真相的判定证据之一）
 *   view           前端窗组件提示（'deck' → DeckWindow，'site' → SiteWindow）
 *   injectFit      导出 / 独立打开时是否注入整屏翻页 fit script
 *   exportFormats  这个形态可用的导出格式 id 列表（前端导出菜单按它渲染）
 *   referenceDoc   首次写这种产物时注入的技术参考 { file, title }
 *   detect(taskDir, marker)        → bool     文件证据判形态
 *   artifactRoot(taskDir, marker)  → string   产物根（相对任务根，'' = 任务根）
 *   manifest(taskDir, marker)      → { root, entry, entryRel, pages, drafts }
 *   describe(taskDir, manifest)    → string   每轮注入清单里的一行说明
 *
 * 判定次序 = KIND_ORDER。文件优先、marker 兜底：文件会被用户和 agent 直接改，
 * marker 不会，让不会变的那个当兜底而不是当权威。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import deck from './deck.js';
import site from './site.js';

export const KINDS = Object.freeze({ [deck.id]: deck, [site.id]: site });

/** 判定优先级：canvas.html 在 index.html 之前（一个任务只做一种形态） */
const KIND_ORDER = [deck.id, site.id];

export function kindDef(kind) {
  return KINDS[kind] || null;
}

/** 读任务标记（`.nd-task.json`）。没有 / 读不动 → null */
export async function readTaskMarker(taskDir) {
  try {
    const raw = await fs.readFile(path.join(taskDir, '.nd-task.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch { return null; }
}

/**
 * 判定任务形态。**文件即真相，marker 兜底。**
 *
 * 次序：canvas.html → deck；站点证据（index.html 在任务根 / 声明的产物根 /
 * 约定构建目录）→ site；只有散装 .html（proto-暖调.html 这类探索期试作，
 * 主 deck 还没铺）→ deck；都没有 → marker.kind → null。
 *
 * @returns {Promise<string|null>} null = 还判不出来（空目录 / 只有素材）
 */
export async function detectTaskKind(taskDir, marker) {
  const m = marker === undefined ? await readTaskMarker(taskDir) : marker;
  for (const id of KIND_ORDER) {
    if (await KINDS[id].detect(taskDir, m)) return id;
  }
  if (await hasLooseHtml(taskDir)) return deck.id;
  const k = m?.kind;
  return KINDS[k] ? k : null;
}

/** 任务根顶层有没有散装 .html（探索期：试作先行，主 deck 未铺） */
async function hasLooseHtml(taskDir) {
  try {
    const entries = await fs.readdir(taskDir, { withFileTypes: true });
    return entries.some(e => e.isFile() && /\.html?$/i.test(e.name) && !e.name.startsWith('.'));
  } catch { return false; }
}

/**
 * 任务的完整 manifest —— 服务端唯一的解析器，前端、感知工具、导出都吃这份。
 *
 * 多产物平权（2026-07-29）：一个任务目录可以装多个平等产物，`artifacts` 是
 * 权威清单，没有主/试作等级。每条 = { kind, view, exportFormats, root, srcRoot,
 * entry, entryRel, file, pages, single, title }。
 * 顶层的 kind/root/entry/entryRel/pages 是**兼容字段**（= artifacts[0]），给
 * 只需要"一个默认目标"的老消费方；新代码一律读 artifacts。
 *
 * @returns {Promise<null | { kind, artifacts, root, entry, entryRel, pages,
 *                            exportFormats, view, sessionId }>}
 */
export async function taskManifest(taskDir) {
  const marker = await readTaskMarker(taskDir);

  const siteInsts = await site.discoverInstances(taskDir, marker);
  const rootSite = siteInsts.find(i => !i.single && !i.srcRoot);
  const deckInsts = await deck.discoverInstances(taskDir, marker, { rootSiteExists: !!rootSite });

  const decorate = (def) => (m) => ({
    ...m,
    view: def.view,
    // 单页产物没有"整站 zip"可言（zip 会把整个任务根都卷进去）
    exportFormats: m.single ? def.exportFormats.filter(f => f !== 'site') : def.exportFormats,
  });
  const artifacts = [];
  // 顺序 = 无更好信号时的默认偏好：deck（canvas.html 排头，兼容旧判定链
  // deck 先于 site）→ 目录站点 → 单页
  for (const i of deckInsts) {
    artifacts.push(decorate(deck)(await deck.instanceManifest(taskDir, marker, i)));
  }
  for (const i of siteInsts.filter(x => !x.single)) {
    artifacts.push(decorate(site)(await site.instanceManifest(taskDir, marker, i)));
  }
  for (const i of siteInsts.filter(x => x.single)) {
    artifacts.push(decorate(site)(await site.instanceManifest(taskDir, marker, i)));
  }

  const kind = artifacts[0]?.kind || (KINDS[marker?.kind] ? marker.kind : null);
  if (!kind) return null;
  const def = KINDS[kind];
  const primary = artifacts[0] || null;
  return {
    kind,
    artifacts,
    // ── 兼容字段（= artifacts[0]；产物还没写出来时给形态的入口约定）──
    root: primary?.root || '',
    entry: primary?.entry || def.entryFile,
    entryRel: primary?.entryRel || def.entryFile,
    pages: primary?.pages || [],
    exportFormats: def.exportFormats,
    view: def.view,
    sessionId: typeof marker?.sessionId === 'string' ? marker.sessionId : null,
  };
}

/**
 * 路径 → 所属产物。specificity 从高到低：单文件产物（deck / 单页）精确命中 →
 * 目录站点按 root 前缀（长的优先）→ 根站（root='' 的站是整任务的兜底，源文件
 * 和构建产物都归它）。找不到返回 null（调用方自己兜底）。
 *
 * @param {object} manifest  taskManifest 的返回
 * @param {string} relInTask 相对任务根的路径
 */
export function artifactOfPath(manifest, relInTask) {
  const rel = String(relInTask || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!manifest?.artifacts?.length) return null;
  const files = manifest.artifacts.filter(a => a.file);
  const hit = files.find(a => a.file === rel);
  if (hit) return hit;
  const dirs = manifest.artifacts
    .filter(a => !a.file && a.kind === 'site')
    // 子目录站（srcRoot 非空）优先精确匹配，根站（srcRoot=''）最后兜底
    .sort((a, b) => (b.srcRoot?.length || 0) - (a.srcRoot?.length || 0));
  for (const a of dirs) {
    if (!a.srcRoot) return a;   // 根站兜底整任务（源和构建产物都归它，root='dist' 也一样）
    if (rel === a.srcRoot || rel.startsWith(`${a.srcRoot}/`)
      || rel === a.root || rel.startsWith(`${a.root}/`)) return a;
  }
  return null;
}

/** 这个形态允不允许某种导出格式（导出路由的守卫从这里查，不再各自 if kind） */
export function formatAllowed(kind, format) {
  const def = KINDS[kind];
  return def ? def.exportFormats.includes(format) : format !== 'site';
}
