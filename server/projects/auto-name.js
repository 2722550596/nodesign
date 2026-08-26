/**
 * server/projects/auto-name.js — 用会话摘要给项目起名（2026-07-28）
 *
 * 首页那个大输入框以前建的是"闪聊"（kind=quick），名字硬切用户第一句话前 30 字，
 * 而且不算正经项目。现在它直接建真项目，名字先用那句话垫着（auto_named=1），
 * 第一轮跑完就用 **pi 会话信息** 改一次名 —— pi-jsonl 读转录头里的
 * customTitle / summary（没有就退到用户第一句 prompt），不额外花一次模型调用。
 *
 * M1 换源：SDK 的 getSessionInfo（~/.claude/projects/）换成 readPiSessionInfo
 * （<PROJECTS_DATA_ROOT>/pi-sessions/<sid>/，与 lifecycle --session-dir 同公式）。
 *
 * 只改一次：改完清 auto_named。用户自己改过名的项目（updateProject 带 name 会
 * 自动清零）永远不动。
 */

import { getProject, updateProject } from './store.js';
import { PROJECTS_DATA_ROOT } from './workspace.js';
import { piSessionDir, readPiSessionInfo } from '../engine/pi/pi-jsonl.js';

const MAX_NAME = 40;

/**
 * @param {string} projectId
 * @param {string} sessionId
 * @returns {Promise<string|null>} 改成了什么名字；没改返 null
 */
export async function autoNameProjectFromSession(projectId, sessionId) {
  if (!projectId || !sessionId) return null;
  let project;
  try { project = getProject(projectId); } catch { return null; }
  if (!project || !project.autoNamed) return null;

  let info;
  try {
    info = await readPiSessionInfo(piSessionDir(PROJECTS_DATA_ROOT, sessionId));
  } catch {
    return null;   // 读不到就下轮再说，auto_named 还留着
  }
  if (!info) return null;

  const summary = String(info.customTitle || info.summary || info.firstPrompt || '').trim();
  if (!summary) return null;
  const name = summary.length > MAX_NAME ? summary.slice(0, MAX_NAME) + '…' : summary;
  if (name === project.name) {
    updateProject(projectId, { autoNamed: false });   // 同名也算定了，别每轮再问
    return null;
  }

  updateProject(projectId, { name, autoNamed: false });
  return name;
}
