/**
 * PostToolUse 行为引导族 —— 工具跑完后注 additionalContext 引导 agent 下一步
 * （截图后自检 / 交付后告知 / 重生看门狗 / 风格锚落盘提醒）。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 *
 * makePostToolUseRecordDecisionHandler — 已移除（git 历史可查）。
 * 之前注 "继续做用户的当前任务" 跟 SDK preset 'claude_code' 教的内容重复，
 * 让 agent 行为像被牵着走。删除后 agent 记完决策自己判断下一步，更接近
 * SDK 默认行为。如未来观察到 agent 反复 record_decision 信号稀释，再考虑
 * 加回（那时改成更精准的 anti-loop 检测，不是无脑注引导）。
 */
import path from 'node:path';

/**
 * PostToolUse(ExitPlanMode) handler — 当前 noop（保留挂载点）。
 *
 * 历史：原版在这里 emit run.plan_for_approval 给前端弹卡，但 PostToolUse 不阻塞
 * agent 继续 next turn —— 实际表现是"agent 提交 plan 后自动批准，弹窗用户也没法关"。
 *
 * 重构（2026-05-08）：阻塞机制迁到 session-loop.js canUseTool 路径——SDK 在工具
 * 调用**之前**触发 canUseTool，await registerPendingPlanApproval 真阻塞 agent 等
 * 用户审批 PlanReviewCard。host 调 plan-approve / plan-reject 通过
 * providePlanApprovalDecision resolve Promise → canUseTool return allow/deny。
 *
 * 本 hook 现在只在 ExitPlanMode tool 真执行后触发（用户已 approve），是 future
 * extension point（比如未来想在 plan 真落档后做额外 emit / 统计）。当前 noop。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 */
export function makePostToolUseExitPlanModeHandler(_deps) {
  return async (_input, _toolUseId, _options) => {
    return {};
  };
}

/**
 * PostToolUse(screenshot_canvas) handler — agent 截图后引导它做视觉自检。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 *   - tool_name / tool_input / tool_response / tool_use_id / duration_ms?
 *
 * output: PostToolUseHookSpecificOutput (sdk.d.ts:1938)
 *   - additionalContext?: string         注入下一轮 prompt
 *   - updatedToolOutput?: unknown        替换 tool 输出（不用）
 *
 * 注意：tool_response 里包含 image content block（base64）。agent 收到这条
 * additionalContext 时已经能"看到"图（multimodal）—— 我们只是用文字提示
 * 它接下来该做什么，不替换 image。
 *
 * 截图后的引导（2026-07-28；硬上限已撤销）：
 * 实测一个真实会话 9-33 张截图，每张 0.6 倍光栅后 ≈1k vision tokens，且
 * **永久留在上下文里**（SDK 不能回改历史工具输出）。
 *
 * 曾经加过"整会话超 12 张就把图换成文字"的硬闸，撤掉了：那等于在 agent 检查
 * 自己作品的时候把它的眼睛蒙上，而且蒙得悄无声息 —— 它只会以为"看起来 OK"。
 * 省下来的几十 k 换不来这个代价。现在只报数、给建议，看不看由它自己判断；
 * 真正的省是 0.6 倍光栅（每张 1.85k→1.0k）和压缩阈值，不是拦着不让看。
 */
const SCREENSHOT_BUSY_HINT_AT = 6;   // 累到这个数开始提醒"大面积检查交给子代理"

export function makePostToolUseScreenshotHandler({ ctx }) {
  let takenInSession = 0;
  let takenInTurn = 0;
  let lastTurn = -1;
  // 不 emit run.screenshot_taken —— mcp/tools/screenshot.js:114 已经 emit
  // 完整字段（sizeBytes / viewport / fullPage）。hook 只负责注 additionalContext
  // 引导 agent 行为，业务事件由 MCP 工具内部负责。
  return async (input, _toolUseId, _options) => {
    const args = input?.tool_input || {};
    const wasFullPage = args.fullPage === true;
    const wasPerPage = typeof args.pageIndex === 'number';
    const turn = ctx?.counters?.turns ?? 0;
    if (turn !== lastTurn) { lastTurn = turn; takenInTurn = 0; }
    takenInTurn += 1;
    takenInSession += 1;

    // fullPage 截图体积是 viewport 的 N×（N=页数），且会留在 context 多 turn
    // 直到 autoCompact。push agent 下次整 deck 自检走 vision-checker subagent，
    // subagent context 是隔离的，主线只收文字 critique，几 K vs 几百 K 的差距。
    const hint = wasFullPage
      ? '\n\n**下次提示**：fullPage 截图体积是 viewport 的 N×（N=页数），留在 context 多 turn 烧 token。整 deck 自检请派 `vision-checker` subagent（Task 工具）—— subagent 自己跑 list_pages + fullPage + 循环 pageIndex，主线只收文字 critique（几 K）。单页针对性自检用 `pageIndex:N`。'
      : wasPerPage
        ? ''
        : '\n\n**下次提示**：当前是 viewport 截图（最便宜）。要看具体某页用 `pageIndex:N`；整 deck 自检请派 `vision-checker` subagent，别堆 fullPage。';

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '你刚才截图了。基于这张图，简短点出 3 个具体的视觉问题（对比度/留白/对齐/层级/字号节奏 任选），每条 1-2 句。'
          + '\n如果整体看起来 OK，就直接跟用户说"看起来 OK"，不要再重复截图。'
          + hint
          + (takenInSession >= SCREENSHOT_BUSY_HINT_AT
            ? `\n\n**上下文提示**：本轮 ${takenInTurn} 张、本会话累计 ${takenInSession} 张`
              + '（每张约 1k tokens，进了上下文不会释放）。没有额度上限，该看就看；'
              + '只是大面积逐页检查交给 `vision-checker` 子代理更划算——它的截图在隔离上下文里，主线只收文字。'
            : ''),
      },
    };
  };
}

/**
 * PostToolUse(export_handoff) handler — agent 打交付包后引导它告知用户路径。
 */
export function makePostToolUseExportHandler({ ctx: _ctx }) {
  // 不 emit run.export_built —— mcp/tools/export-handoff.js:83 已经 emit
  // 完整字段（format / path / sizeBytes / notes）。hook 从 tool_response 字符串
  // substring 拼出来的 path 反而不准。hook 只负责注 additionalContext。
  return async (_input, _toolUseId, _options) => {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '已生成交付包。简短告诉用户打包文件路径（让她从 UI 下载），然后收尾。'
          + '\n不要再重复调 export_handoff —— 同一个交付应只打包一次。',
      },
    };
  };
}

// ── Phase Image-4：generate_image 重生看门狗 ──
//
// agent 同 outputName 调 generate_image 第 3 次起，注 systemMessage 建议：
//   - 直接 chat 邀请用户在最近 2-3 张候选里选最好的（generate_image 已返 image
//     content block，前端 chat 自动渲染，用户能直接看到）
//   - 或 accept 当前最好的一版继续后续工作
// 防"agent 闷头改 5-10 次同 prompt 浪费 token + 用户也得不到更好版本"。
//
// 计数策略：
//   - in-memory Map（key: outputName 去 timestamp 的 base，value: count）
//   - 进程重启清；session 内累积；不区分 session（agent 进程同步 hook）
//   - 阈值固定 3，可后续 env 化
//
// outputName base 提取：
//   - "deck-cover-v1" → "deck-cover"（去掉 -v\d / -\d / -draft 等 suffix）
//   - 同 base 不同 suffix 仍计入同一组（避免 agent 改名绕过 watchdog）
export function makePostToolUseGenerateImageRegenWatchdog() {
  const REGEN_THRESHOLD = 3;
  const counts = new Map();

  function extractBase(outputName) {
    if (!outputName || typeof outputName !== 'string') return null;
    return outputName
      .replace(/-(?:v\d+|draft\d*|final|new|old|alt|\d+)$/i, '')
      .replace(/[-_]+/g, '-')
      .toLowerCase();
  }

  return async (input, _toolUseId, _options) => {
    try {
      const outputName = input?.tool_input?.outputName;
      const base = extractBase(outputName);
      if (!base) return {};

      const next = (counts.get(base) || 0) + 1;
      counts.set(base, next);

      // 第 1 次：邀请反馈 nudge（按 SKILL.md 高代价 / 低代价节点判断）
      if (next === 1) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext:
              `<system-reminder>\n[image-feedback-nudge] 这是本组（base="${base}"）第 1 张图。\n\n`
            + `如果是 cover / portrait / 跨页 anchor 这类高代价节点（会被当 referenceImages 种子用于全 deck），可以在 chat 里自然邀请用户确认一下方向（"这个 cover 当全 deck 视觉锚 OK 吗？"），收到反馈再做后续；section-divider / decoration / icon 这类单张可直接继续，工具 caption 已自动在 chat 显示。\n\n`
            + `判断诀窍：错了会不会导致全 deck 重生？会 → 邀请反馈；不会 → 继续。\n`
            + `</system-reminder>`,
          },
        };
      }

      if (next < REGEN_THRESHOLD) return {};

      // ≥ 3 次同 base outputName → 注 systemMessage
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `<system-reminder>\n[regen-watchdog] 你已经对 outputName base "${base}" 调 generate_image ${next} 次。\n\n`
          + `如果是 conversational editing 微调（"再暖一点 / 换日落色"），可以继续；\n`
          + `如果在反复尝试不同方向（每次 prompt 大改），**强烈建议**：\n`
          + `  1. 直接在 chat 里邀请用户从最近 2-3 张候选选最好的（image content block 已自动在 chat 渲染）\n`
          + `  2. 或 accept 当前最满意的那张，专心后续工作\n`
          + `理由：reroll 同 prompt 越多次 token 浪费越大，且用户也未必能在第 N 张里看出明显差别。\n`
          + `</system-reminder>`,
        },
      };
    } catch (err) {
      console.warn(`[hooks/regen-watchdog] threw:`, err.message);
      return {};
    }
  };
}

/**
 * PostToolUse(record_decision) —— 锚定风格那一笔之后提醒落两处长期资产
 * （2026-07-28，配合"记忆归 SDK / 品牌归我们 / 指引归用户"的分工）
 *
 * 只在这一笔上注、每 session 一次：
 *   - 品牌档案 `agent-memory/brand/memory.md` —— 前端 BrandCard 会把色板 /
 *     字体渲染出来，是结构化资产，agent 不写就永远空着
 *   - 项目指引 `.claude/CLAUDE.md` —— SDK 每次 session 自动读进 system prompt，
 *     但只有用户能决定要不要固化，所以是"问一句"不是"直接写"
 *
 * 通用偏好不在这儿管：那是 SDK 自动记忆的活（autoMemoryDirectory 已指到
 * .claude/agent-memory/auto，前端记忆卡直接显示）。
 */
export function makePostToolUseStyleAnchorNudge({ sharedRoot }) {
  let nudged = false;
  const ANCHOR_RE = /(style-anchor|风格锚|锚定|视觉基调|palette|配色方案)/i;
  return async (input, _toolUseId, _options) => {
    if (nudged) return {};
    const t = input?.tool_input || {};
    const blob = `${t.topic || ''} ${t.title || ''} ${t.decision || ''} ${t.rationale || ''}`;
    if (!ANCHOR_RE.test(blob)) return {};
    nudged = true;
    const guidePath = sharedRoot ? path.join(sharedRoot, '.claude', 'CLAUDE.md') : '.claude/CLAUDE.md';
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '这一笔看起来是在锚定这个项目的视觉方向。顺手做两件事（都只做一次）：\n'
        + '1. 把这版风格写进 `./agent-memory/brand/memory.md`（色号 / 字体链 / 版式语言 / 动效预算），'
        + '前端品牌档案卡会把色板和字体渲染出来给用户看，不写就一直空着。\n'
        + `2. 如果这次定下来的还包含**项目级约束**（不只这一个 deck 适用，比如"这个项目一律不用 emoji"），`
        + `在收尾时问用户一句要不要写进项目指引（${guidePath}，SDK 每次 session 自动读它）。用户点头你再写。\n`
        + '用户的通用偏好不用你手动记，系统的自动记忆会管。',
      },
    };
  };
}
