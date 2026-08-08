/**
 * server/engine/mcp/index.js — Nodesign 内置 MCP server
 *
 * 暴露给 agent 的自定义工具集（in-process，via SDK 的 createSdkMcpServer）：
 *
 *   感知层（playwright headless 跑出真实渲染元数据）：
 *     screenshot_canvas / list_pages / read_page / query_elements / get_computed_styles
 *   控制层（emit 事件让前端同步）：
 *     navigate_to_page / highlight / preview_deck
 *   反馈层（用户在 canvas 上的直接编辑 + 评论 buffer）：
 *     get_pending_changes / clear_pending_changes
 *   产物层（NoDesign 差异化能力）：
 *     expose_tweaks / export_handoff / record_decision
 *   研究层：
 *     web_search（4 provider，CJK auto baidu）
 *
 * 调用约定（SDK 自动给 tool name 加前缀）：
 *   tool 名在 agent 端是 mcp__nodesign__<tool>，比如 mcp__nodesign__screenshot_canvas
 *
 * 实例化策略：
 *   每个 runAgent 创建一个新的 MCP server 实例（through createNodesignMcpServer）。
 *   开销小（in-process，没起 process），但能让 deps（workspaceRoot / projectId / ctx）
 *   绑死到当前 turn 的上下文，避免 cross-talk。
 *
 * 安全：
 *   tool handler 在 SDK 进程内（本服务器进程）跑，不通过 stdio/sse/http。
 *   handler 自己不做沙盒，由 PreToolUse hook + workspace cwd 隔离兜底。
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { makeScreenshotCanvasTool } from './tools/screenshot.js';
import { makeScreenshotUrlTool } from './tools/screenshot-url.js';
import { makeExportHandoffTool } from './tools/export-handoff.js';
import { makeRecordDecisionTool } from './tools/record-decision.js';
import { makeWebSearchTool } from './tools/web-search.js';
import { makeReadPageTool } from './tools/read-page.js';
import { makeListPagesTool } from './tools/list-pages.js';
import { makeQueryElementsTool } from './tools/query-elements.js';
import { makeGetComputedStylesTool } from './tools/get-computed-styles.js';
import { makeNavigateToPageTool } from './tools/navigate-to-page.js';
import { makeHighlightTool } from './tools/highlight.js';
import { makePreviewDeckTool } from './tools/preview-deck.js';
import { makeExposeTweaksTool } from './tools/expose-tweaks.js';
import { makeGetPendingChangesTool } from './tools/get-pending-changes.js';
import { makeClearPendingChangesTool } from './tools/clear-pending-changes.js';
import { makeGenerateImageTool } from './tools/generate-image.js';
import { makeRemoveBackgroundTool } from './tools/remove-background.js';
import { makeRequestPlanModeTool } from './tools/request-plan-mode.js';
import { makePinToBoardTool } from './tools/pin-to-board.js';
import { makeDeliverFilesTool } from './tools/deliver-files.js';
import { makeCrystallizeSkillTool } from './tools/crystallize-skill.js';
import { makePublishSiteTool } from './tools/publish-site.js';
import { makeReportIssueTool } from './tools/report-issue.js';
import { makeRollFilmTool } from './tools/roll-film.js';
import { makePaintStillTool } from './tools/paint-still.js';

/**
 * 创建 Nodesign 的 MCP server，绑定当前 run 的依赖。
 *
 * @param {object} deps
 * @param {string} deps.workspaceRoot       绝对路径，project workspace（sessions/<sid>/）
 * @param {string} [deps.sharedRoot]        project shared/ 根（跨 session 共享 assets / .claude）
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]          NoDesign sessionId — request_plan_mode 等
 *                                           "等用户决定"工具用作 pending Promise key
 * @param {import('../agent/context.js').AgentContext} [deps.ctx]  EventBus 入口
 * @returns SDK MCP server config（喂给 query options.mcpServers）
 */
// 常驻 schema 白名单（2026-07-23 订阅模式 token 瘦身）：
// 高频 + schema 小的工具第一 turn 就注入 prompt；不在名单里的走 SDK 默认
// deferred —— system prompt 只留工具名，agent 用 ToolSearch 按需拉 schema
// （需要 ENABLE_TOOL_SEARCH=true + allowlist 含 ToolSearch，见 session-loop）。
// 实测 defer 掉 generate_image/web_search/remove_background 等 6 个胖工具
// 省 ~80k 字符常驻 schema。prelude 的工具速查表仍列全部工具名 + 一句话用途，
// agent 知道存在什么、需要时先 ToolSearch("select:mcp__nodesign__<tool>")。
// （kimi 时代曾全局 alwaysLoad —— kimi 不认 ToolSearch；claude 系模型原生受训，可放心 defer）
const ALWAYS_LOAD_TOOLS = new Set([
  'screenshot_canvas', 'read_page', 'list_pages', 'query_elements',
  'get_computed_styles', 'navigate_to_page', 'highlight', 'preview_deck',
  'record_decision', 'get_pending_changes', 'clear_pending_changes',
  // screenshot_url 常驻：explorer 显式 tools 列表没有 ToolSearch，defer 了它就
  // 永远拉不到 schema；schema 本身很小（4 字段），常驻成本可忽略
  'screenshot_url',
]);

export function createNodesignMcpServer({ workspaceRoot, sharedRoot, projectId, sessionId, ctx } = {}) {
  return createSdkMcpServer({
    name: 'nodesign',
    version: '0.1.0',
    tools: [
      // C9 screenshot_canvas — playwright headless 截图 → image content block
      makeScreenshotCanvasTool({ workspaceRoot, sessionId, ctx }),

      // screenshot_url — 外部 URL 截图（2026-07-29）。explorer 找视觉参考不再
      // 只能 WebFetch 文本转述；主 agent 也能直接看参考站。http/https only。
      makeScreenshotUrlTool({ ctx }),

      // deliver_files — agent 挑好的产物直接进用户浏览器下载列表（emit run.download_ready）
      makeDeliverFilesTool({ workspaceRoot, projectId, sessionId, ctx }),

      // C10 export_handoff — 复用 exports.js 的 buildHandoffZip，写到 workspace/exports/
      makeExportHandoffTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }),

      // C11 record_decision — 写入 spec.json decisions[] 设计意图档案
      makeRecordDecisionTool({ workspaceRoot, sessionId, ctx }),

      // crystallize_skill — 把探索出来的方法论固化成用户自己的 skill + 作品进橱窗
      // （2026-07-30）。用户明确要求才调；写的是判断依据不是成品 HTML。
      makeCrystallizeSkillTool({ projectId, sessionId, ctx }),

      // publish_site — 站点一键上线 Cloudflare Pages（2026-08-02）。用户明确要求
      // 才调（发公网是外发动作）；额度按项目 owner 算，与站点窗按钮共用一套闸门。
      makePublishSiteTool({ projectId }),

      // roll_film — 自部署 MiniMax-H3 视频产线（2026-08-08）。管线只有定档主力
      // 线路一条（Modal H100+sage Turbo8步 ≤12.25s）；花站主 Modal 余额，试用号
      // 拒（owner 闸门同 publish_site）。视觉 QC 归用户，工具只回文本路径。
      makeRollFilmTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }),

      // paint_still — 站主本地 GPU 盒子生图（NoobAI/Anima，2026-08-08）。盒子
      // 在线才可用（NODESIGN_H3BOX_SSH）；动漫向/视频关键帧首选，通用生图仍走
      // generate_image。视觉 QC 归用户。
      makePaintStillTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }),

      // report_issue — agent 给维护者写信（08-02 由 report_friction 扩容改名）：
      // bug / friction / idea 三类走同一张 issues 表。跟 PostToolUseFailure 的
      // 自动记录分工：自动层记"发生了什么"，这层补"为什么难受、期望怎样"。
      makeReportIssueTool({ projectId, sessionId, ctx }),

      // web_search — 4 provider 联网搜索（baidu/tavily/exa/zhipu，CJK auto route to baidu）
      // 移植自 ~/.deskclaw/skills/deskclaw-search-pro/scripts/search.py，0 外部依赖。
      // WebFetch 不在这里 — 用 SDK 内置（session-loop.js DEFAULT_TOOL_ALLOWLIST 启用），
      // 它自带 LLM summarize 能控制上下文，不需要自实现。
      makeWebSearchTool({ workspaceRoot, sharedRoot, ctx }),

      // S1c canvas 焕新升级 — read_page 让 agent 精确读 canvas.html 任意页
      // （`<section data-page="N">` 一段），不必 Read 整文件 + Grep + offset/limit。
      // 解 2026-05-02 用户观察"agent 只看第一页"痛点。
      makeReadPageTool({ workspaceRoot, sessionId, ctx }),

      // ── Canvas 焕新 C1（2026-05-02）：完整 agent "感知 + 操作" 工具链 ──
      // 感知层：list_pages / query_elements / get_computed_styles —— playwright
      // headless 跑出来真实 render 后的元数据，agent 不再盲改
      makeListPagesTool({ workspaceRoot, sessionId, ctx }),
      makeQueryElementsTool({ workspaceRoot, sessionId, ctx }),
      makeGetComputedStylesTool({ workspaceRoot, sessionId, ctx }),

      // 控制层：emit 反向事件给前端，server 主动操作 canvas UI
      makeNavigateToPageTool({ ctx }),
      makeHighlightTool({ ctx }),
      // 把 deck 摊到用户眼前（= 用户双击那张卡）：收起态→内嵌渲染，展开态→最大化窗
      makePreviewDeckTool({ ctx, sessionId }),

      // 反馈层：用户在 canvas 上的直接编辑 + 评论 buffer
      // 前端在 chat 时由 turn.js 注入 system 提示，agent 主动调下面两个工具读 + 清
      makeGetPendingChangesTool({ workspaceRoot, ctx }),
      makeClearPendingChangesTool({ workspaceRoot, ctx }),

      // Tweaks 协议：agent 暴露 deck 专属可调参数 schema → 前端按 schema 渲染控件
      makeExposeTweaksTool({ workspaceRoot, ctx }),

      // 图片生成（gemini-3.1-flash-image-preview / Nano Banana 2，via NoDesk passthrough）
      // 落档优先 sharedRoot/assets/generated/，fallback workspaceRoot/assets/generated/。
      // 跨 session 共享靠 sessions/<sid>/assets softlink → shared/assets。
      makeGenerateImageTool({ workspaceRoot, sharedRoot, ctx }),

      // 抠图（rembg U²-Net，server 端 spawn .venv-rembg python subprocess）
      // 任何 workspace 里的图都能抠，输出 RGBA PNG 到 assets/generated/<name>.png。
      // 跟 generate_image 解耦：generate_image 只生图，想透明叠加单独调本工具。
      makeRemoveBackgroundTool({ workspaceRoot, sharedRoot, ctx }),

      // Agent in-loop 请求进 SDK plan mode —— emit run.plan_mode_requested
      // 给前端弹横幅，用户点 yes 走 /permission-mode endpoint 切 mode 后再 POST
      // /plan-request/:tid/decide 解阻塞。
      // 工具是**阻塞态** — handler await 用户决定再返回，避免 agent 在等的时候继续动作
      // （之前非阻塞导致 agent 边请求边写文件，等用户点 yes 时 run 已 done → 切不了）。
      makeRequestPlanModeTool({ ctx, sessionId }),

      // 工作台分区画布（2026-07-27）：agent 协助摆放 —— 把产物/文档/deck 钉进
      // 某 session 的工作区。写 board.json（board-store 单锁）+ 广播 board.updated。
      makePinToBoardTool({ sharedRoot, projectId, sessionId, ctx }),

      // 注：Phase Image-2 的 request_image_approval 工具已废弃（2026-05-06）。
      // generate_image 的 CallToolResult 已返 image content block，前端自动渲染；
      // agent 在 caption / 自然回话邀请反馈，下一轮用户 chat 即天然 gate。
    ].map((t) => (
      // SDK 用 _meta['anthropic/alwaysLoad'] 标记常驻（tool() 第 5 参的等价物，
      // 集中在这打标避免改 16 个工具文件）
      ALWAYS_LOAD_TOOLS.has(t.name)
        ? { ...t, _meta: { ...t._meta, 'anthropic/alwaysLoad': true } }
        : t
    )),
  });
}
