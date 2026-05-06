/**
 * mcp/tools/request-image-approval.js — request_image_approval MCP tool
 *
 * Phase Image-2：让 main agent 在**关键节点**（cover anchor / 第一个 portrait /
 * logo 嵌入 / 多变体并排选）主动 gate 用户决策。区别于 generate_image 完成后
 * 自动浮的 ImageApprovalBanner（覆盖通用单图场景），这个工具用于 agent 想
 * **明确请用户在多张候选里选**或**强调"这张要当 anchor，必须你点头"**。
 *
 * 流程：
 *   1. agent 调 mcp__nodesign__request_image_approval({ paths, intent, role, isAnchor })
 *   2. handler emit 'run.image_approval_requested' 给前端
 *   3. 前端 ImageApprovalBanner 升级模式（多张并排 + intent 文字）
 *   4. 用户 OK / regenerate w/ feedback / dismiss → POST /image-approval endpoint
 *   5. 后端 pushUserMessage 注 system reminder 喂回 agent 当前 session
 *   6. agent 下一 turn 收到反馈，按 conversational editing 流程继续
 *
 * 不阻塞：emit 完立即 return，agent 当前 turn 继续。下一 turn 通过 system
 * reminder 自然感知用户决策（同 request_plan_mode 模式）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ASSET_ROLES = [
  'hero', 'cover', 'bg', 'frame', 'icon', 'decoration',
  'portrait', 'illustration', 'quote-backdrop', 'section-divider', 'pattern',
];

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeRequestImageApprovalTool({ ctx } = {}) {
  return tool(
    'request_image_approval',
    `Request user approval for one or more candidate images at a high-cost decision
node. Use this when the image will be reused as a referenceImages anchor for
subsequent generations (cross-deck visual consistency depends on it), or when
you generated multiple candidates and want the user to pick.

WHEN TO USE (must-gate scenarios):
  - First cover/hero image (will seed referenceImages for ALL subsequent
    image generations in the deck — getting it wrong = entire deck rework)
  - First portrait of a recurring character (cross-page consistency anchor)
  - User-uploaded logo embedded in a product mockup (effect can't be predicted
    from prompt alone)
  - You generated 2-5 variants in a single prompt and want user to pick the best

WHEN NOT TO USE:
  - Single one-off decoration / icon / section-divider (single image; if user
    doesn't like, regenerating one image is cheap)
  - Conversational in-painting tweaks (use generate_image directly with
    referenceImages = current image; the auto-banner covers user feedback)

EFFECT:
  Emits a 'run.image_approval_requested' event. The user sees the candidates
  side-by-side in a banner with intent + 3 buttons (OK / regenerate w/
  feedback / dismiss). On approval / regenerate the host injects a
  system-reminder into your next turn telling you the user's decision. On
  dismiss no notice arrives — assume implicit accept.

This tool returns immediately. Continue your work; if user wants regenerate,
you'll see "用户希望重生 ..." reminder and should use conversational editing
(referenceImages = current path + "Keep composition, [feedback]" prompt).`,
    {
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(5)
        .describe('Workspace-relative paths to candidate images (1-5). Typically assets/generated/<name>.jpg.'),
      intent: z
        .string()
        .min(8)
        .max(300)
        .describe('What decision you want the user to gate. E.g., "This will be the cover anchor — every subsequent hero/section-divider will use it as referenceImages seed. Please pick or ask me to refine."'),
      role: z
        .enum(ASSET_ROLES)
        .optional()
        .describe('Semantic assetRole (cover/portrait/etc). Helps the banner UI labelize.'),
      isAnchor: z
        .boolean()
        .optional()
        .describe('True if this image will be reused as referenceImages seed for subsequent generations (high-cost decision). Default false.'),
    },
    async ({ paths, intent, role, isAnchor }) => {
      try {
        ctx?.emit?.({
          type: 'run.image_approval_requested',
          paths,
          intent,
          role: role || null,
          isAnchor: isAnchor === true,
        });
      } catch { /* fail-safe */ }

      return {
        content: [{
          type: 'text',
          text:
            `Image approval request emitted to user (${paths.length} candidate${paths.length > 1 ? 's' : ''}). `
          + `Continue your work. On the next turn you'll see one of:\n`
          + `  - "用户已 approve [...]" → reuse the path(s) as referenceImages going forward\n`
          + `  - "用户希望重生 [...]" → use conversational editing: referenceImages=[current], `
          + `prompt="Keep composition, [user feedback]"\n`
          + `  - (no message after a turn or two) → user dismissed; proceed assuming implicit accept`,
        }],
      };
    },
  );
}
