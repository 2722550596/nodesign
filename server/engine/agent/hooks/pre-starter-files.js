/**
 * skill 起手文件拷贝族（2026-08-14 可维护性行动：从 hooks.js 原样迁出）。
 * 2026-07-27 工作台升级起，starter 拷贝从 session-loop init 挪到 hook：
 * session 不再默认等于 deck 任务，非 deck 会话的 cwd 不再预置 deck 模板。
 */
import { ensureSkillStarterFiles, listSkillIds, listSkillStarterFiles } from '../skill.js';

/**
 * PreToolUse(Skill) — agent 加载 deskskill-engine-mini 时把 skill 起手文件
 * （canvas.template.html 等）拷进 session cwd。
 *
 * ensureSkillStarterFiles 幂等 + fail-soft。
 */
export function makePreToolUseSkillStarterFilesCopier({ workspaceRoot }) {
  const done = new Set();
  return async (input, _toolUseId, _options) => {
    if (!workspaceRoot) return {};
    try {
      // 认哪个 skill 从入参里读，不再硬编码 'deskskill-engine-mini' ——
      // 硬编码的后果是新 skill（站点）的模板永远拷不出来，而且静默。
      const raw = JSON.stringify(input?.tool_input || {});
      for (const id of await listSkillIds()) {
        if (done.has(id) || !raw.includes(id)) continue;
        done.add(id);
        const r = await ensureSkillStarterFiles(workspaceRoot, id);
        if (r.copied.length > 0) {
          console.log(`[hooks] starter files copied on Skill load (${id}): ${r.copied.join(', ')}`);
        }
      }
    } catch (err) {
      console.warn('[hooks] starter files copy on Skill load failed:', err.message);
    }
    return {};
  };
}

/**
 * PreToolUse(Bash) 兜底 —— agent 没走 Skill 加载、直接按 prelude 的
 * "起手 cp canvas.template.html" 动手时，命令里出现模板名就现场补拷，
 * 避免 cp 报 No such file。
 */
export function makePreToolUseBashStarterFilesFallback({ workspaceRoot }) {
  const done = new Set();
  return async (input, _toolUseId, _options) => {
    if (!workspaceRoot) return {};
    const command = String(input?.tool_input?.command || '');
    if (!command.includes('.template.')) return {};   // 快速排除绝大多数命令
    try {
      for (const id of await listSkillIds()) {
        if (done.has(id)) continue;
        const names = await listSkillStarterFiles(id);
        if (!names.some(n => command.includes(n))) continue;
        done.add(id);
        await ensureSkillStarterFiles(workspaceRoot, id);
      }
    } catch (err) {
      console.warn('[hooks] starter files fallback copy failed:', err.message);
    }
    return {};
  };
}
