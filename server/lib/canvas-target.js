/**
 * canvas-target.js — 画布类工具的统一寻址（2026-07-28）
 *
 * 起因：任务模型把 deck 搬到了 `tasks/<任务>/canvas.html`，但感知层工具
 * （list_pages / read_page / query_elements / get_computed_styles / expose_tweaks /
 * export_handoff）还硬编码着 `cwd/canvas.html` —— 在任务里做的 deck，这些工具
 * 一律报 "canvas.html not found in workspace"。vision-checker 子代理整条链都靠
 * list_pages + screenshot，于是整个视觉自检形同虚设（真机 case：子代理拿到
 * tasks/… 路径也没用，list_pages 不收路径，Glob 又不跟 tasks/ 那条软链，
 * 它翻遍 workspace 只看到 .git，只好回话说"这里没有画布"）。
 *
 * 寻址顺序（越靠前越明确）：
 *   ① 调用方显式给的 path
 *   ② 本会话的"当前 deck"——写过 / 截过 / 预览过哪份就是哪份
 *   ③ 绑在本会话名下的那个任务的 deck（tasks/<任务>/.nd-task.json 认领）
 *   ④ cwd/canvas.html（旧式单 deck 会话）
 *   ⑤ 整个 workspace 只有一份 deck 就是它；有多份就报错列出来让调用方指定
 *
 * ③ 很关键：tasks/ 是项目共享目录的软链，每个会话都看得见项目里所有任务，
 * "唯一一份"这种兜底只在单任务项目里成立。任务=会话一对一，认 marker 最准。
 *
 * 这样子代理直接 `list_pages {}` 也能落到对的那份，不必知道任务目录长什么样。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/** sessionId → workspace 相对路径。会话结束不清也无妨（一条 string） */
const activeDeck = new Map();

/** 记住这个会话正在做哪份 deck（写文件 / 截图 / 预览时调） */
export function setActiveDeck(sessionId, relPath) {
  if (!sessionId || typeof relPath !== 'string') return;
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p.endsWith('.html')) return;
  if (p.endsWith('canvas.template.html')) return;   // 模板不是 deck
  activeDeck.set(sessionId, p);
}

export function getActiveDeck(sessionId) {
  return (sessionId && activeDeck.get(sessionId)) || null;
}

export function clearActiveDeck(sessionId) {
  activeDeck.delete(sessionId);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** workspace 内才算数（tasks/ assets/ 是 workspace 下的软链，resolve 不出根） */
function insideWorkspace(workspaceRoot, absPath) {
  const root = path.resolve(workspaceRoot);
  return absPath === root || absPath.startsWith(root + path.sep);
}

/** tasks/ 下所有 canvas.html（软链目录要显式 readdir，Glob 不跟软链） */
async function scanTaskDecks(workspaceRoot) {
  const out = [];
  try {
    const names = await fs.readdir(path.join(workspaceRoot, 'tasks'), { withFileTypes: true });
    for (const d of names) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const rel = `tasks/${d.name}/canvas.html`;
      if (await exists(path.join(workspaceRoot, rel))) out.push(rel);
    }
  } catch { /* 没有 tasks/ 就是旧式会话 */ }
  return out;
}

/** 认领在本会话名下的那个任务的 deck（任务=会话一对一的 marker） */
async function deckOfBoundTask(workspaceRoot, sessionId) {
  if (!sessionId) return null;
  for (const rel of await scanTaskDecks(workspaceRoot)) {
    const marker = path.join(workspaceRoot, path.dirname(rel), '.nd-task.json');
    try {
      const j = JSON.parse(await fs.readFile(marker, 'utf8'));
      if (j?.sessionId === sessionId) return rel;
    } catch { /* 没 marker / 读不动就跳过 */ }
  }
  return null;
}

/** 这个 workspace 里现有的 deck（cwd 那份 + tasks/ 下每个任务一份） */
export async function listWorkspaceDecks(workspaceRoot) {
  const out = [];
  if (await exists(path.join(workspaceRoot, 'canvas.html'))) out.push('canvas.html');
  out.push(...await scanTaskDecks(workspaceRoot));
  return out;
}

/**
 * 解析画布目标。
 *
 * @returns {Promise<{ ok: true, absPath: string, relPath: string }
 *                  | { ok: false, message: string }>}
 */
export async function resolveCanvasTarget(workspaceRoot, relPath, sessionId) {
  const tryPath = async (rel) => {
    if (!rel) return null;
    const abs = path.resolve(workspaceRoot, rel);
    if (!insideWorkspace(workspaceRoot, abs)) return null;
    return (await exists(abs)) ? { ok: true, absPath: abs, relPath: rel } : null;
  };

  if (relPath) {
    const hit = await tryPath(relPath);
    if (hit) { setActiveDeck(sessionId, relPath); return hit; }
    const abs = path.resolve(workspaceRoot, relPath);
    return {
      ok: false,
      message: insideWorkspace(workspaceRoot, abs)
        ? `${relPath} not found. Write it first, or check the path.`
        : 'path escapes workspace',
    };
  }

  const active = await tryPath(getActiveDeck(sessionId));
  if (active) return active;

  const bound = await tryPath(await deckOfBoundTask(workspaceRoot, sessionId));
  if (bound) { setActiveDeck(sessionId, bound.relPath); return bound; }

  const legacy = await tryPath('canvas.html');
  if (legacy) return legacy;

  const decks = await scanTaskDecks(workspaceRoot);
  if (decks.length === 1) { setActiveDeck(sessionId, decks[0]); return { ok: true, absPath: path.resolve(workspaceRoot, decks[0]), relPath: decks[0] }; }
  if (decks.length > 1) {
    return {
      ok: false,
      message: `Multiple decks in this workspace — pass path explicitly:\n${decks.map(d => `- ${d}`).join('\n')}`,
    };
  }
  return {
    ok: false,
    message: 'No canvas found. Task decks live at tasks/<task>/canvas.html — '
      + 'write one first, or pass path explicitly.',
  };
}

/** 给各工具复用的 path 参数描述（保持措辞一致） */
export const CANVAS_PATH_DESC =
  'Relative path of the deck html (e.g. "tasks/<task>/canvas.html"). '
  + 'Omit to use the deck you are currently working on (falls back to cwd canvas.html).';
