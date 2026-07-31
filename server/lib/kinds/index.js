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
import world from './world.js';

export const KINDS = Object.freeze({ [deck.id]: deck, [site.id]: site, [world.id]: world });

/**
 * 判定优先级：world 最前，然后 canvas.html 在 index.html 之前
 * （一个任务只做一种形态）。
 *
 * world 排最前不是偏好，是必须（2026-08-01）：world 任务里迟早会出现 .html
 * ——导出的仿书、agent 写的预览页、试作。deck 认任务根顶层任意 .html，site 认
 * index.html 和 dist/ 之类构建目录，两个都会把一个世界抢走判成自己。world 的
 * 判定证据（世界.md / marker.kind）比它们强且不会误伤别的形态，所以放最前
 * 短路掉后面的判定最安全。
 */
const KIND_ORDER = [world.id, deck.id, site.id];

export function kindDef(kind) {
  return KINDS[kind] || null;
}

/**
 * 这个形态有没有某项能力。
 *
 * 加这层是因为代码里反复在问的其实不是「这是不是站点」，而是「这东西能不能
 * 用浏览器打开」。deck 和 site 都能，world 不能（入口是 markdown，内容是文件夹
 * 树）。以前没有 world 时两个问题的答案恰好一样，所以到处写 `kind === KIND_SITE`
 * 也没出事；world 一进来就露馅了 —— screenshot / read_page / query_elements /
 * list_pages / get_computed_styles 全都会拿一份 .md 去喂 playwright。
 *
 * 只声明**当前真的有人查**的能力，不预先铺一张能力表。
 *
 * @param {string} kind
 * @param {string} cap  目前只有 'browsable'
 */
export function can(kind, cap) {
  return !!KINDS[kind]?.capabilities?.includes(cap);
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

  // world 先判且**命中即独占**（2026-08-01）：世界是一个整体，`世界/` 里的地点和
  // 角色是它的内部结构，不是并列产物。不独占的话，世界里任何一个 .html（导出的
  // 仿书、预览页、试作）都会让 manifest 里凭空多出 deck / site 卡，画布上就是
  // 世界旁边挂着几张来路不明的卡片。detectTaskKind 是首个命中即返回所以本来就
  // 安全，这里的多产物循环是并列跑的，得显式短路。
  const worldInsts = await world.discoverInstances(taskDir, marker);
  const siteInsts = worldInsts.length ? [] : await site.discoverInstances(taskDir, marker);
  const rootSite = siteInsts.find(i => !i.single && !i.srcRoot);
  const deckInsts = worldInsts.length
    ? []
    : await deck.discoverInstances(taskDir, marker, { rootSiteExists: !!rootSite });

  const decorate = (def) => (m) => ({
    ...m,
    view: def.view,
    // 单页产物没有"整站 zip"可言（zip 会把整个任务根都卷进去）
    exportFormats: m.single ? def.exportFormats.filter(f => f !== 'site') : def.exportFormats,
  });
  const artifacts = [];
  // 顺序 = 无更好信号时的默认偏好：world（独占，命中时后两者为空）→ deck
  // （canvas.html 排头，兼容旧判定链 deck 先于 site）→ 目录站点 → 单页
  for (const i of worldInsts) {
    artifacts.push(decorate(world)(await world.instanceManifest(taskDir, marker, i)));
  }
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
  // 目录型产物（site 的目录站、world 的世界）。判据用「没有 file 字段」而不是
  // 写死 kind —— 注册表的意义就是别在寻址层再列一遍形态名（2026-08-01 加 world
  // 时改的；改前只认 site，world 任务的路径寻址会全部落空）。
  const dirs = manifest.artifacts
    .filter(a => !a.file)
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
