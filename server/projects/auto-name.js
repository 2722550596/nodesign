/**
 * server/projects/auto-name.js — 用会话摘要给项目起名（2026-07-28）
 *
 * 首页那个大输入框以前建的是"闪聊"（kind=quick），名字硬切用户第一句话前 30 字，
 * 而且不算正经项目。现在它直接建真项目，名字先用那句话垫着（auto_named=1），
 * 第一轮跑完就用 **SDK helper 写的会话摘要** 改一次名 —— 那是它本来就在写的东西
 * （incrementally 落进 jsonl，我们列会话时读的就是它），不额外花一次模型调用。
 *
 * 只改一次：改完清 auto_named。用户自己改过名的项目（updateProject 带 name 会
 * 自动清零）永远不动。
 */

import path from 'node:path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { getProject, updateProject } from './store.js';
import { getProjectWorkspace } from './workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { platform } from '../runtime/platform.js';

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

  const sessionRoot = path.join(getProjectWorkspace(projectId), 'sessions', sessionId);
  let info;
  try {
    info = await withConfigDir(platform.claudeConfigDir, () =>
      getSessionInfo(sessionId, { dir: sessionRoot }),
    );
  } catch {
    return null;   // 读不到就下轮再说，auto_named 还留着
  }

  const summary = String(info?.customTitle || info?.summary || '').trim();
  if (!summary) return null;
  const name = summary.length > MAX_NAME ? summary.slice(0, MAX_NAME) + '…' : summary;
  if (name === project.name) {
    updateProject(projectId, { autoNamed: false });   // 同名也算定了，别每轮再问
    return null;
  }

  updateProject(projectId, { name, autoNamed: false });
  return name;
}
