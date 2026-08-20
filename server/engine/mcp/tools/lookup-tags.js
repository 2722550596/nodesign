/**
 * mcp/tools/lookup-tags.js — lookup_tags MCP tool（2026-08-20）
 *
 * danbooru 系模型（noobai / noobai-eps / pony）的标签写错不报错、只静默失效。
 * 08-18 起 paint_still **画完之后**会体检；这个工具把查的动作挪到**画之前**，
 * 配手册里的起手纪律：先从用户的话里理解要画什么 → 把每个概念想成候选标签 →
 * 一次 lookup_tags 拿真实收录量和候选替换 → 再 paint_still。
 *
 * 薄壳：逻辑全在 lib/danbooru-tags.js（和体检共用一份，别分叉）。
 * fail-open：danbooru 查不到就明说查不到，不挡出图。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { lookupTags, formatLookup } from '../../../lib/danbooru-tags.js';

export function makeLookupTagsTool() {
  return tool(
    'lookup_tags',
    `Check danbooru tags BEFORE painting with noobai / noobai-eps / pony
(paint_still). These models only understand danbooru tags; a misspelled or
unused tag fails SILENTLY — the model receives nothing and you burn a whole
batch before anyone notices.

Workflow: read what the user wants → list the concepts (subject, look,
clothing, pose/expression, scene, lighting) → for each, write the danbooru
tags you BELIEVE exist → call this ONCE with all of them in "tags" → keep the
ones with post_count >= 1000, swap weak ones for the suggested candidates,
then paint. Re-rolls of the same scene do not need another lookup.

- tags:    exact names to verify (spaces or underscores both fine). Weak or
           missing ones come back with real candidates ranked by post_count.
- search:  free words when you do not know the tag at all ("makeup", "lick")
           → matching tags ranked by post_count.
- explain: tag names whose meaning you want (first lines of the danbooru wiki)
           — useful to pick between near-synonyms.

post_count < 1000 means WEAK, not forbidden: for mainstream needs pick the
stronger candidate; when the user's taste is itself niche, use the weak tag and
reinforce it with a related stronger one. Artist names always need checking.
Results are hints — the prompt wording stays your call.`,
    {
      tags: z.array(z.string().min(1).max(80)).max(60).optional()
        .describe('tag names to verify, e.g. ["long hair", "smeared lipstick", "artist:dairi"]'),
      search: z.array(z.string().min(2).max(40)).max(10).optional()
        .describe('free words to search tags by, e.g. ["makeup", "lick"]'),
      explain: z.array(z.string().min(1).max(80)).max(8).optional()
        .describe('tag names to get the wiki meaning of'),
    },
    async ({ tags = [], search = [], explain = [] }) => {
      try {
        const r = await lookupTags({ tags, search, explain });
        return { content: [{ type: 'text', text: formatLookup(r) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `lookup_tags 失败（不挡出图，照手册词表写）：${err.message}` }], isError: true };
      }
    },
  );
}
