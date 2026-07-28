/**
 * artifact-target.js — 产物寻址（2026-07-28，由 canvas-target.js 泛化而来）
 *
 * 原来这层叫 canvas-target，它只认一种产物：deck = `tasks/<任务>/canvas.html`。
 * 加站点（site = `tasks/<任务>/index.html` + 子页 + style.css）时如果只在调用方
 * 打补丁，会重演任务模型上线时那批静默失败 —— 工具不报错，只是把站点当成
 * "没有分页的 deck"，返回空结果，agent 换招绕过去，用户永远不知道感知层瞎了。
 *
 * 所以这里定死两件事：
 *
 * **① 任务有形态（kind），文件就是真相。**
 *    目录里有 canvas.html → deck；否则有 index.html → site；都没有就看 marker；
 *    还没有就是"未定"（刚 mkdir 完还没写东西）。marker（`.nd-task.json`）只在
 *    文件判不出来时兜底 —— 文件会被用户和 agent 直接改，marker 不会，让不会变的
 *    那个当兜底而不是当权威。
 *
 * **② 寻址永远带着 kind 一起返回。**
 *    调用方（截图 / 分页 / 导出 / fit 注入）必须能看见"这是 deck 还是 site"，
 *    才可能给出对的行为。返回值里没有 kind 的话，下游只能靠文件名猜，猜错了
 *    还是静默的。
 *
 * 寻址顺序（越靠前越明确，跟老版本一致）：
 *   ① 调用方显式给的 path
 *   ② 本会话的"当前产物"——写过 / 截过 / 预览过哪份就是哪份
 *   ③ 绑在本会话名下那个任务的入口文件（tasks/<任务>/.nd-task.json 认领）
 *   ④ cwd/canvas.html（旧式单 deck 会话）
 *   ⑤ 整个 workspace 只有一份产物就是它；多份就报错列出来让调用方指定
 *
 * ③ 很关键：tasks/ 是项目共享目录的软链，每个会话都看得见项目里所有任务，
 * "唯一一份"这种兜底只在单任务项目里成立。任务=会话一对一，认 marker 最准。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export const KIND_DECK = 'deck';
export const KIND_SITE = 'site';

/** 每种形态的入口文件名。改这里等于改全平台约定 */
export const ENTRY_FILE = Object.freeze({
  [KIND_DECK]: 'canvas.html',
  [KIND_SITE]: 'index.html',
});

/** 站点目录里最多往下扫几层（子页 / pages/ / posts/ 够用，别把 node_modules 之类拖进来） */
const SITE_SCAN_DEPTH = 3;

/** sessionId → { path, kind }。会话结束不清也无妨（两个短字符串） */
const activeArtifact = new Map();

/**
 * 记住这个会话正在做哪份产物（写文件 / 截图 / 预览时调）。
 *
 * kind 不传就按路径推断；推断不出来（任务里的非入口 .html）就跟随任务形态。
 */
export function setActiveArtifact(sessionId, relPath, kind) {
  if (!sessionId || typeof relPath !== 'string') return;
  const p = normalizeRel(relPath);
  if (!p.endsWith('.html')) return;
  if (p.endsWith('canvas.template.html') || p.endsWith('site.template.html')) return;  // 模板不是产物
  activeArtifact.set(sessionId, { path: p, kind: kind || null });
}

export function getActiveArtifact(sessionId) {
  return (sessionId && activeArtifact.get(sessionId)) || null;
}

export function clearActiveArtifact(sessionId) {
  activeArtifact.delete(sessionId);
}

function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** workspace 内才算数（tasks/ assets/ 是 workspace 下的软链，resolve 不出根） */
function insideWorkspace(workspaceRoot, absPath) {
  const root = path.resolve(workspaceRoot);
  return absPath === root || absPath.startsWith(root + path.sep);
}

/** 从 workspace 相对路径里抠出任务名；不在 tasks/ 下返回 null */
export function taskNameOf(relPath) {
  const m = normalizeRel(relPath).match(/(?:^|\/)tasks\/([^/]+)\//);
  return m ? m[1] : null;
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
 * @returns {Promise<'deck'|'site'|null>} null = 还判不出来（空目录 / 只有素材）
 */
export async function detectTaskKind(taskDir) {
  if (await exists(path.join(taskDir, ENTRY_FILE[KIND_DECK]))) return KIND_DECK;
  if (await exists(path.join(taskDir, ENTRY_FILE[KIND_SITE]))) return KIND_SITE;
  const marker = await readTaskMarker(taskDir);
  const k = marker?.kind;
  return (k === KIND_DECK || k === KIND_SITE) ? k : null;
}

/**
 * 列 workspace 里的所有任务（含形态与归属）。
 *
 * tasks/ 是软链目录，Glob 不跟软链，必须显式 readdir。
 *
 * @returns {Promise<Array<{name, dir, rel, kind, entry, entryRel, sessionId}>>}
 *          kind=null 的任务还没写出产物；entry/entryRel 此时也是 null
 */
export async function listTasks(workspaceRoot) {
  const out = [];
  let names;
  try {
    names = await fs.readdir(path.join(workspaceRoot, 'tasks'), { withFileTypes: true });
  } catch { return out; }   // 没有 tasks/ 就是旧式会话

  for (const d of names) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (d.name.startsWith('.')) continue;
    const dir = path.join(workspaceRoot, 'tasks', d.name);
    const kind = await detectTaskKind(dir);
    const marker = await readTaskMarker(dir);
    const entry = kind ? ENTRY_FILE[kind] : null;
    out.push({
      name: d.name,
      dir,
      rel: `tasks/${d.name}`,
      kind,
      entry,
      entryRel: entry ? `tasks/${d.name}/${entry}` : null,
      sessionId: typeof marker?.sessionId === 'string' ? marker.sessionId : null,
    });
  }
  return out;
}

/**
 * 站点任务里的页面清单（相对任务目录，含子目录，深度 SITE_SCAN_DEPTH）。
 * index.html 排第一，其余按路径排序。
 */
export async function listSitePages(taskDir) {
  const pages = [];
  const walk = async (dir, prefix, depth) => {
    if (depth > SITE_SCAN_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel, depth + 1);
      else if (/\.html?$/i.test(e.name)) pages.push(rel);
    }
  };
  await walk(taskDir, '', 1);
  pages.sort((a, b) => {
    if (a === ENTRY_FILE[KIND_SITE]) return -1;
    if (b === ENTRY_FILE[KIND_SITE]) return 1;
    return a.localeCompare(b);
  });
  return pages;
}

/**
 * 推断某个 html 路径的产物形态。
 *
 * 任务里的非入口 .html：deck 任务下是试作（proto-暖调.html），site 任务下是子页
 * （about.html）—— 同样的文件名形态，含义完全相反，所以必须问任务而不是猜文件名。
 */
export async function kindOfPath(workspaceRoot, relPath) {
  const p = normalizeRel(relPath);
  const base = path.posix.basename(p);
  const task = taskNameOf(p);
  if (task) {
    const taskKind = await detectTaskKind(path.join(workspaceRoot, 'tasks', task));
    if (taskKind) return taskKind;
  }
  if (base === ENTRY_FILE[KIND_DECK]) return KIND_DECK;
  if (base === ENTRY_FILE[KIND_SITE]) return KIND_SITE;
  return KIND_DECK;   // 旧式会话 cwd 里的散装 .html 一律按 deck
}

/** 这个 workspace 里现有的产物入口（cwd 那份 + 每个任务一份） */
export async function listWorkspaceArtifacts(workspaceRoot) {
  const out = [];
  if (await exists(path.join(workspaceRoot, ENTRY_FILE[KIND_DECK]))) {
    out.push({ rel: ENTRY_FILE[KIND_DECK], kind: KIND_DECK, task: null });
  }
  for (const t of await listTasks(workspaceRoot)) {
    if (t.entryRel) out.push({ rel: t.entryRel, kind: t.kind, task: t.name });
  }
  return out;
}

/** 兼容旧名：只要 deck 那些 */
export async function listWorkspaceDecks(workspaceRoot) {
  return (await listWorkspaceArtifacts(workspaceRoot))
    .filter(a => a.kind === KIND_DECK)
    .map(a => a.rel);
}

/** 认领在本会话名下那个任务的入口（任务=会话一对一的 marker） */
async function artifactOfBoundTask(workspaceRoot, sessionId) {
  if (!sessionId) return null;
  for (const t of await listTasks(workspaceRoot)) {
    if (t.sessionId === sessionId && t.entryRel) return t;
  }
  return null;
}

/**
 * 解析产物目标。
 *
 * @param {string} workspaceRoot
 * @param {string|null} relPath   调用方显式给的路径（优先级最高）
 * @param {string|null} sessionId
 * @returns {Promise<{ ok: true, absPath: string, relPath: string, kind: 'deck'|'site',
 *                     task: string|null, taskDir: string|null }
 *                  | { ok: false, message: string }>}
 */
export async function resolveArtifactTarget(workspaceRoot, relPath, sessionId) {
  const decorate = async (rel) => {
    const p = normalizeRel(rel);
    const task = taskNameOf(p);
    return {
      ok: true,
      absPath: path.resolve(workspaceRoot, p),
      relPath: p,
      kind: await kindOfPath(workspaceRoot, p),
      task,
      taskDir: task ? path.join(workspaceRoot, 'tasks', task) : null,
    };
  };

  const tryPath = async (rel) => {
    if (!rel) return null;
    const abs = path.resolve(workspaceRoot, rel);
    if (!insideWorkspace(workspaceRoot, abs)) return null;
    return (await exists(abs)) ? decorate(rel) : null;
  };

  if (relPath) {
    const hit = await tryPath(relPath);
    if (hit) { setActiveArtifact(sessionId, hit.relPath, hit.kind); return hit; }
    const abs = path.resolve(workspaceRoot, relPath);
    return {
      ok: false,
      message: insideWorkspace(workspaceRoot, abs)
        ? `${relPath} not found. Write it first, or check the path.`
        : 'path escapes workspace',
    };
  }

  const active = getActiveArtifact(sessionId);
  const activeHit = await tryPath(active?.path);
  if (activeHit) return activeHit;

  const bound = await artifactOfBoundTask(workspaceRoot, sessionId);
  const boundHit = await tryPath(bound?.entryRel);
  if (boundHit) { setActiveArtifact(sessionId, boundHit.relPath, boundHit.kind); return boundHit; }

  const legacy = await tryPath(ENTRY_FILE[KIND_DECK]);
  if (legacy) return legacy;

  const all = await listWorkspaceArtifacts(workspaceRoot);
  if (all.length === 1) {
    setActiveArtifact(sessionId, all[0].rel, all[0].kind);
    return decorate(all[0].rel);
  }
  if (all.length > 1) {
    return {
      ok: false,
      message: 'Multiple artifacts in this workspace — pass path explicitly:\n'
        + all.map(a => `- ${a.rel}  (${a.kind})`).join('\n'),
    };
  }
  return {
    ok: false,
    message: 'No artifact found. Deck = tasks/<task>/canvas.html, site = tasks/<task>/index.html — '
      + 'write one first, or pass path explicitly.',
  };
}

/** 给各工具复用的 path 参数描述（保持措辞一致） */
export const ARTIFACT_PATH_DESC =
  'Relative path of the html file (deck: "tasks/<task>/canvas.html", site: "tasks/<task>/index.html"). '
  + 'Omit to use the artifact you are currently working on.';

// ── 兼容层：老名字继续可用，内部全部走上面的实现 ────────────────────────────
export const CANVAS_PATH_DESC = ARTIFACT_PATH_DESC;
export const resolveCanvasTarget = resolveArtifactTarget;
export const setActiveDeck = (sessionId, relPath) => setActiveArtifact(sessionId, relPath);
export const getActiveDeck = (sessionId) => getActiveArtifact(sessionId)?.path || null;
export const clearActiveDeck = clearActiveArtifact;
