/**
 * mcp/tools/publish-site.js — publish_site MCP tool（2026-08-02）
 *
 * agent 版的「一键上线」：把任务里的目录站点发到 Cloudflare Pages 公网。
 * 与站点窗的上线按钮共用 lib/site-publish.js 的全部闸门 —— 额度和权限按
 * **项目 owner** 算（试用号不能发、正式号每人 2 个），不是"谁触发算谁"。
 *
 * 发到公网是外发动作：工具描述里写死"用户明确要求才调"。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { getPublished } from '../../../lib/publish-store.js';
import { publishSite, unpublishSite } from '../../../lib/site-publish.js';

/**
 * @param {object} deps
 * @param {string} [deps.projectId]
 */
export function makePublishSiteTool({ projectId }) {
  return tool(
    'publish_site',
    `Publish a site task to the public web (Cloudflare Pages), update an already
published site, or take it offline.

Call this ONLY when the user explicitly asks to put the site online / update the
live version / take it down. Never publish unprompted — going public is the
user's call, not yours.

action:
- "publish": deploy the current files. First publish returns the permanent URL
  (a brand-new domain may take a minute or two to start resolving); republishing
  keeps the same URL.
- "unpublish": delete the deployment; the public URL dies immediately.
- "status": just report whether this task is published and at which URL.

The user's publish quota and permissions apply (trial accounts cannot publish;
regular accounts have a per-user site limit). If the tool returns a quota or
permission error, relay it as-is — do not retry.`,
    {
      task: z.string().describe('任务目录名（站点所在的任务）'),
      action: z.enum(['publish', 'unpublish', 'status']).default('publish'),
    },
    async ({ task, action }) => {
      const asText = (text) => ({ content: [{ type: 'text', text }] });
      try {
        const project = getProject(projectId);
        if (!project) return asText('错误：项目不存在');
        const owner = project.ownerId ? getUserById(project.ownerId) : null;
        if (!owner) return asText('错误：找不到项目归属用户，不能发布');

        if (action === 'status') {
          const site = getPublished(projectId, task);
          return asText(site
            ? `已发布：${site.url}（最近发布 ${site.lastPublishedAt}）`
            : '未发布');
        }
        if (action === 'unpublish') {
          const removed = await unpublishSite({ projectId, task });
          return asText(removed ? '已下线，公网地址即刻失效。' : '本来就没有发布。');
        }
        const { site, warning } = await publishSite({ projectId, task, user: owner });
        return asText([
          `已上线：${site.url}`,
          '重新发布地址不变；新域名生效可能要等一两分钟。',
          warning ? `注意：${warning}` : null,
        ].filter(Boolean).join('\n'));
      } catch (err) {
        return asText(`发布操作失败：${err.message}`);
      }
    },
  );
}
