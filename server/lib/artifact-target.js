/**
 * artifact-target.js — 产物寻址（2026-07-28 由 canvas-target.js 泛化；
 * 2026-07-29 形态判定与解析下沉到 kinds/ 注册表，本文件只管「寻址」）
 *
 * 定死三件事：
 *
 * **① 任务有形态（kind），文件就是真相。** 判定规则在 kinds/ 注册表：
 *    canvas.html → deck；index.html（任务根 / 声明的产物根 / 约定构建目录）→ site；
 *    都没有才看 `.nd-task.json` 的 kind 兜底。
 *
 * **② 寻址永远带着 kind 一起返回。** 下游（截图 / 分页 / 导出 / fit 注入）必须
 *    能看见"这是 deck 还是 site"，才可能给出对的行为。kind 每次 resolve 按任务
 *    现状重算，不缓存。
 *
 * **③ 源和产物可以分开。** 构建型站点的源在任务根、产物在 dist/ 之类的产物根。
 *    resolve 返回 taskDir（源，agent 的地盘）和 artifactDir（被预览 / 导出 / 发布
 *    的根），deck 和手写站点两者相同。消费方要"看"产物就用 artifactDir，别再
 *    自己 dirname(entryPath)。
 *
 * 寻址顺序（越靠前越明确）：
 *   ① 调用方显式给的 path
 *   ② 本会话的"当前产物"——最近写过 / 截过 / 预览过哪份就是哪份；
 *      写的是任务里的非 html（样式表 / 素材 / 构建脚本）时跟随该任务的入口
 *   ③ 绑在本会话名下那个任务的入口文件（tasks/<任务>/.nd-task.json 认领）
 *   ④ cwd/canvas.html（旧式单 deck 会话）
 *   ⑤ 整个 workspace 只有一份产物就是它；多份就报错列出来让调用方指定
 *
 * ③ 很关键：tasks/ 是项目共享目录的软链，每个会话都看得见项目里所有任务，
 * "唯一一份"这种兜底只在单任务项目里成立。任务=会话一对一，认 marker 最准。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  KINDS, kindDef, detectTaskKind, readTaskMarker, taskManifest, artifactOfPath,
} from './kinds/index.js';

export const KIND_DECK = 'deck';
export const KIND_SITE = 'site';

/** 每种形态的入口文件名（从注册表派生；改形态契约去 kinds/） */
export const ENTRY_FILE = Object.freeze(
  Object.fromEntries(Object.values(KINDS).map(k => [k.id, k.entryFile])),
);

// 形态判定与解析的权威在 kinds/，这里转发老名字（消费方 import 不用改两次）
export { detectTaskKind, readTaskMarker, taskManifest, kindDef, artifactOfPath };
export { formatAllowed } from './kinds/index.js';

/** sessionId → { path, task }。会话结束不清也无妨（几个短字符串） */
const activeArtifact = new Map();

/**
 * 记住这个会话正在做哪份产物（写文件 / 截图 / 预览时调）。
 *
 * 不再只认 .html（2026-07-29）：任务里的任何写入都说明 agent 在这个任务上干活。
 * html → 记具体文件（试作 / 子页迭代时工具默认打它）；
 * 任务内非 html（样式表 / 素材 / 构建产物）→ 记任务，resolve 时走任务入口 ——
 * 但**不覆盖**已记下的同任务 html（改一次 style.css 不该把"正在做 proto-B"忘掉）。
 * 任务外的非 html（agent-memory / spec.json）跟产物无关，不动 active。
 */
export function setActiveArtifact(sessionId, relPath, kind) {
  if (!sessionId || typeof relPath !== 'string') return;
  const p = normalizeRel(relPath);
  if (/\.template\.(html?|css)$/i.test(p)) return;   // 模板不是产物
  const task = taskNameOf(p);
  const isHtml = /\.html?$/i.test(p);
  if (isHtml) {
    activeArtifact.set(sessionId, { path: p, task, kind: kind || null });
    return;
  }
  if (!task) return;
  const prev = activeArtifact.get(sessionId);
  if (prev?.task === task && prev.path) return;
  activeArtifact.set(sessionId, { path: null, task, kind: null });
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

/**
 * 列 workspace 里的所有任务（含形态、产物根与归属）。
 *
 * tasks/ 是软链目录，Glob 不跟软链，必须显式 readdir。
 *
 * @returns {Promise<Array<{name, dir, rel, kind, root, entry, entryRel, sessionId, manifest}>>}
 *          kind=null 的任务还没写出产物；entry/entryRel/manifest 此时是 null
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
    const manifest = await taskManifest(dir);
    const marker = manifest ? null : await readTaskMarker(dir);   // manifest 已含 sessionId
    out.push({
      name: d.name,
      dir,
      rel: `tasks/${d.name}`,
      kind: manifest?.kind || null,
      root: manifest?.root || '',
      entry: manifest?.entry || null,
      entryRel: manifest ? `tasks/${d.name}/${manifest.entryRel}` : null,
      sessionId: manifest?.sessionId
        ?? (typeof marker?.sessionId === 'string' ? marker.sessionId : null),
      manifest,
    });
  }
  return out;
}

/**
 * 站点任务的页面清单（相对产物根）。兼容旧签名：传任务目录，返回 pages 数组。
 */
export async function listSitePages(taskDir) {
  const m = await KINDS[KIND_SITE].manifest(taskDir, await readTaskMarker(taskDir));
  return m.pages;
}

/**
 * 推断某个 html 路径的产物形态。
 *
 * 多产物平权后按**所属产物**判：canvas.html 在站点任务里也是 deck、about.html
 * 在同一任务里是站点页面 —— 同名文件形态可以不同，问 artifacts 清单而不是猜
 * 文件名。任务里找不到所属产物（还没写出来）才退回文件名约定。
 */
export async function kindOfPath(workspaceRoot, relPath) {
  const p = normalizeRel(relPath);
  const base = path.posix.basename(p);
  const task = taskNameOf(p);
  if (task) {
    const m = await taskManifest(path.join(workspaceRoot, 'tasks', task));
    if (m) {
      const relInTask = p.replace(/^tasks\/[^/]+\//, '');
      const art = artifactOfPath(m, relInTask);
      if (art) return art.kind;
      if (m.kind) return m.kind;
    }
  }
  if (base === ENTRY_FILE[KIND_DECK]) return KIND_DECK;
  if (base === ENTRY_FILE[KIND_SITE]) return KIND_SITE;
  return KIND_DECK;   // 旧式会话 cwd 里的散装 .html 一律按 deck
}

/** 这个 workspace 里现有的产物入口（cwd 那份 + 每个任务的每个产物，平权） */
export async function listWorkspaceArtifacts(workspaceRoot) {
  const out = [];
  if (await exists(path.join(workspaceRoot, ENTRY_FILE[KIND_DECK]))) {
    out.push({ rel: ENTRY_FILE[KIND_DECK], kind: KIND_DECK, task: null });
  }
  for (const t of await listTasks(workspaceRoot)) {
    for (const a of (t.manifest?.artifacts || [])) {
      out.push({ rel: `tasks/${t.name}/${a.entryRel}`, kind: a.kind, task: t.name });
    }
  }
  return out;
}

/** 兼容旧名：只要 deck 那些 */
export async function listWorkspaceDecks(workspaceRoot) {
  return (await listWorkspaceArtifacts(workspaceRoot))
    .filter(a => a.kind === KIND_DECK)
    .map(a => a.rel);
}

/** 认领在本会话名下那个任务（任务=会话一对一的 marker） */
async function taskBoundTo(workspaceRoot, sessionId) {
  if (!sessionId) return null;
  for (const t of await listTasks(workspaceRoot)) {
    if (t.sessionId === sessionId) return t;
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
 *                     task: string|null, taskDir: string|null,
 *                     artifactDir: string|null, artifactRel: string|null }
 *                  | { ok: false, message: string }>}
 *   taskDir      源（任务根，agent 的地盘）
 *   artifactDir  产物根（被预览 / 导出 / 发布的目录）；deck 和手写站点 = taskDir
 */
export async function resolveArtifactTarget(workspaceRoot, relPath, sessionId) {
  const decorate = async (rel) => {
    const p = normalizeRel(rel);
    const task = taskNameOf(p);
    const taskDir = task ? path.join(workspaceRoot, 'tasks', task) : null;
    // 按所属产物定 kind 和产物根（多产物平权：同任务里 canvas.html 是 deck、
    // v2/index.html 是另一个站，root 各归各）
    let kind = null;
    let root = '';
    let artifact = null;
    if (taskDir) {
      const m = await taskManifest(taskDir);
      if (m) {
        const relInTask = p.replace(/^tasks\/[^/]+\//, '');
        artifact = artifactOfPath(m, relInTask);
        if (artifact) { kind = artifact.kind; root = artifact.root || ''; }
        else if (m.kind) { kind = m.kind; root = m.root || ''; }
      }
    }
    if (!kind) kind = await kindOfPath(workspaceRoot, p);
    return {
      ok: true,
      absPath: path.resolve(workspaceRoot, p),
      relPath: p,
      kind,
      task,
      taskDir,
      artifact,   // 所属产物条目（manifest.artifacts 里那条；散文件 / 旧式会话为 null）
      artifactDir: taskDir ? (root ? path.join(taskDir, root) : taskDir) : null,
      artifactRel: task ? `tasks/${task}${root ? `/${root}` : ''}` : null,
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
  if (active?.path) {
    const activeHit = await tryPath(active.path);
    if (activeHit) return activeHit;
  } else if (active?.task) {
    // 只知道在哪个任务上干活（最近写的是样式表 / 素材）→ 走该任务的入口
    const m = await taskManifest(path.join(workspaceRoot, 'tasks', active.task));
    const hit = m ? await tryPath(`tasks/${active.task}/${m.entryRel}`) : null;
    if (hit) return hit;
  }

  const bound = await taskBoundTo(workspaceRoot, sessionId);
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
  'Relative path of the html file (deck: "tasks/<task>/canvas.html", site: "tasks/<task>/index.html" '
  + 'or its built output like "tasks/<task>/dist/index.html"). '
  + 'Omit to use the artifact you are currently working on.';

// ── 兼容层：老名字继续可用，内部全部走上面的实现 ────────────────────────────
export const CANVAS_PATH_DESC = ARTIFACT_PATH_DESC;
export const resolveCanvasTarget = resolveArtifactTarget;
export const setActiveDeck = (sessionId, relPath) => setActiveArtifact(sessionId, relPath);
export const getActiveDeck = (sessionId) => getActiveArtifact(sessionId)?.path || null;
export const clearActiveDeck = clearActiveArtifact;
