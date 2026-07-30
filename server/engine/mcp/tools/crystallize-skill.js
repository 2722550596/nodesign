/**
 * mcp/tools/crystallize-skill.js — crystallize_skill MCP tool
 *
 * 把一次真实探索的**结论**固化成用户自己的 skill，并把作品收进个人橱窗。
 *
 * 为什么不是"存模板"：模板是把成品存下来，换个主题就崩——真正能复用的是判断依据
 * （为什么这个字号阶梯、为什么这个场合压住动效、哪些默认做法在这个气质里必须反掉）。
 * 所以这个工具收的是方法论，不是 HTML。产物写进用户级 plugin 根
 * （~/.nodesign/plugins/<userId>/<name>/），下次开新会话在**这个用户的所有项目**里
 * 都能用（plugin 发现是 startup-time，当前会话不生效）。
 *
 * 跟 record_decision 的分工：决策贴是**这一件作品**的过程档案，随任务走；
 * 这里是跨项目复用的方法论，随用户走。一个是日志，一个是沉淀。
 *
 * 归属：写到**项目 owner** 的目录，不是"当前请求者"——同一个项目谁跑都该产出同一
 * 套资产。owner 查不到就报错，不往共享根写（那是刚修掉的跨用户污染路径）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProject } from '../../../projects/store.js';
import { getUserPluginsRoot } from '../../agent/plugin-loader.js';
import { installPluginToRoot } from '../../../lib/plugin-install.js';
import { upsertEntry } from '../../../lib/showcase-store.js';
import { taskNameOf, getActiveArtifact } from '../../../lib/artifact-target.js';
import { Events } from '../../agent/events.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

function composeSkillMd({ name, title, description, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n+/g, ' ').trim()}`,
    'version: 0.1.0',
    '---',
    '',
    `# ${title.trim()}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeCrystallizeSkillTool({ projectId, sessionId, ctx }) {
  return tool(
    'crystallize_skill',
    `Distill a style/approach the user and you worked out together into a REUSABLE
SKILL owned by this user, and put the finished work in their personal showcase.

Call this ONLY when the user asks to keep a style, or explicitly confirms they
want this approach reusable. Never call it unprompted — a skill the user did not
ask for is clutter in every future session.

What belongs in \`body\` is the METHODOLOGY, not the artifact:
- The reasoning behind the choices (why this type scale, why this palette works
  for this kind of room, why motion was held back here)
- What the user rejected along the way and why — the negative space is the most
  reusable part
- The anti-default list for this style: what the obvious move would have been,
  and why it was wrong here
- Where this style BREAKS DOWN — occasions it does not suit. A skill that cannot
  state its own boundary is a template wearing a methodology costume, and it will
  produce bad work the first time it is applied off-target.

Do NOT paste HTML/CSS of the finished piece. Concrete values (a specific hex, a
specific scale) belong in only as illustrations of the reasoning.

The skill lands in the user's personal plugin dir and becomes available in NEW
sessions across all their projects (plugin discovery happens at session start,
so it does not apply to the current session).`,
    {
      name: z.string()
        .describe('Skill id, kebab-case, 3-40 chars (e.g. "quiet-editorial-deck"). Becomes the plugin/skill name.'),
      title: z.string().min(2).max(80)
        .describe('Human-readable name of the style (e.g. "安静的编辑气质 · 长文型 deck")'),
      description: z.string().min(20).max(600)
        .describe('Frontmatter description — the routing signal. MUST say when to use it AND when not to.'),
      body: z.string().min(200)
        .describe('The methodology in markdown: reasoning, rejected alternatives, anti-default list, and where the style breaks down.'),
      showcaseTitle: z.string().max(80).optional()
        .describe('Title for the showcase card. Defaults to the style title.'),
      showcaseNote: z.string().max(400).optional()
        .describe('One line for the showcase card: what occasion this piece was for.'),
      artifactPath: z.string().optional()
        .describe('Work to show on the card, relative to workspace (e.g. "tasks/<task>/canvas.html"). Defaults to the active artifact.'),
      overwrite: z.boolean().optional()
        .describe('Replace an existing skill of the same name. Ask the user before setting this.'),
    },
    async ({ name, title, description, body, showcaseTitle, showcaseNote, artifactPath, overwrite }) => {
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      try {
        if (!NAME_RE.test(String(name || ''))) {
          return fail(`Invalid skill name "${name}" — use kebab-case, 3-40 chars, e.g. "quiet-editorial-deck".`);
        }
        if (!projectId) return fail('No project bound; cannot resolve who owns this skill.');
        const ownerId = getProject(projectId)?.ownerId || null;
        const root = getUserPluginsRoot(ownerId);
        if (!root) {
          return fail('This project has no owner on record, so there is no personal skill library to write to.');
        }

        const md = composeSkillMd({ name, title, description, body });
        const result = await installPluginToRoot(Buffer.from(md, 'utf8'), root, { force: !!overwrite });
        if (result.status === 409) {
          return fail(`A skill named "${name}" already exists in this user's library `
            + `(${result.body.existing?.description || 'no description'}). `
            + 'Ask the user whether to replace it, then call again with overwrite: true.');
        }
        if (result.status >= 400) {
          const errs = (result.body.errors || []).join('; ') || result.body.error;
          return fail(`Skill rejected by validator: ${errs}`);
        }

        // 橱窗条目：作品 + 它沉淀出来的 skill
        const rel = String(artifactPath || getActiveArtifact(sessionId)?.path || '').replace(/\\/g, '/');
        const artifactRel = rel.startsWith('tasks/') ? rel : null;
        let entry = null;
        try {
          entry = upsertEntry({
            userId: ownerId,
            projectId,
            taskId: artifactRel ? taskNameOf(artifactRel) : null,
            artifactRel,
            skillName: name,
            title: (showcaseTitle || title).trim(),
            note: showcaseNote?.trim() || null,
          });
        } catch (err) {
          console.warn('[crystallize_skill] showcase entry failed:', err.message);
        }

        try {
          ctx?.emit?.({
            type: 'run.skill_crystallized',
            skillName: name,
            title: title.trim(),
            showcaseId: entry?.id || null,
          });
        } catch { /* emit fail-safe */ }

        const warn = (result.body.warnings || []).length
          ? ` Warnings: ${result.body.warnings.join('; ')}.` : '';
        return {
          content: [{
            type: 'text',
            text: `Skill "${name}" saved to the user's personal library`
              + `${artifactRel ? ` and the work added to their showcase` : ''}.`
              + ` It becomes available in NEW sessions (not this one).${warn}`
              + ` Tell the user plainly what you captured and what boundary you wrote,`
              + ` so they can correct it while it is fresh.`,
          }],
        };
      } catch (err) {
        return fail(`crystallize_skill failed: ${err?.message || String(err)}`);
      }
    },
  );
}
