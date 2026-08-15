/**
 * server/engine/agent/hooks.js — agent hooks 组装层
 *
 * 2026-08-14 可维护性行动：1975 行的单文件拆成「这里只做注册与出厂断言，
 * handler 工厂按家族住 hooks/ 目录」。改某个钩子的行为去对应模块；
 * 改「哪个事件挂哪些钩子」才来这里。
 *
 *   hooks/pre-defaults.js            PreToolUse 默认值矫正（Agent 前台 / Grep content）
 *   hooks/pre-injectors.js           首调注入族（cookbook / 协议 / 提醒，每 session 一次）
 *   hooks/pre-starter-files.js       skill 起手文件拷贝（Skill 主路 + Bash 兜底）
 *   hooks/pre-board-neighborhood.js  关系线邻域注入（Read|Edit|Write）
 *   hooks/user-prompt-submit.js      每 turn 状态注入（路径地图 / 决策 / 便利贴 / 产物清单）
 *   hooks/file-events.js             文件改动 → run.file_changed（watcher 型 + 确定性直发）
 *   hooks/lifecycle.js               SessionStart / Stop / PostCompact / Subagent 生命周期
 *   hooks/post-trim.js               Edit|Write tool_response.originalFile 瘦身
 *   hooks/post-canvas-focus.js       改动落页检测 → run.canvas_focus_page
 *   hooks/post-guidance.js           行为引导（截图自检 / 交付告知 / 重生看门狗 / 风格锚）
 *   hooks/canvas-validate.js         canvas.html 一致性校验（anchor 唯一 / layout 组件 / role）
 *   hooks/failure.js                 PostToolUseFailure 恢复建议 + 自动问题记录
 *   hooks/tool-prompts.js            prompts/tools/*.md 懒加载缓存（注入族共用）
 *
 * 调用方式：session-loop.js 在拼 sdkOptions 时调
 *   hooks: createHooks({ ctx, workspaceRoot, projectId })
 *
 * SDK Hook 接口：
 *   HookCallback = (input, toolUseId, { signal }) => Promise<HookJSONOutput>
 *   HookJSONOutput.SyncHookJSONOutput 关键字段（sdk.d.ts:5283）：
 *     - continue?: boolean              false 中断 query
 *     - decision?: 'approve' | 'block'  控制流（PreToolUse 用 block 拒工具）
 *     - hookSpecificOutput?: { ... }    各 hook 自己的输出（如
 *                                       PreToolUseHookSpecificOutput.permissionDecision /
 *                                       UserPromptSubmitHookSpecificOutput.additionalContext)
 *     - systemMessage?: string          注入 system message 给后续轮
 *     - reason?: string                 给用户看的原因（block 时）
 *
 *   返回 {} 表示"通过，不干预"。
 *
 * 设计原则：
 *   - hook handler 必须**快**（不阻塞 agent loop）。fs 读取限制小文件 + 失败 fail-soft。
 *   - hook handler 不抛异常（SDK 内部会吞，但保险起见自己 try/catch）。
 *   - hook handler 通过 ctx.emit 发事件让前端可见，但不阻塞返回。
 *   - additionalContext 注入要简短直接 —— 不让 agent 觉得需要"回应这条系统消息"，
 *     只是提示"已发生 X"。
 */

import {
  makePreToolUseAgentForceForegroundHandler,
  makePreToolUseGrepContentDefaultHandler,
} from './hooks/pre-defaults.js';
import {
  makePreToolUseGetPendingChangesProtocolInjector,
  makePreToolUseAskUserQuestionProtocolInjector,
  makePreToolUseHybridReferenceInjector,
  makePreToolUsePaintStillCookbookInjector,
  makePreToolUseRollFilmCookbookInjector,
  makePreToolUseGenerateImageCookbookInjector,
  makePreToolUseGenerateImageReadPageReminder,
  makePreToolUseExposeTweaksSyntaxInjector,
  makePreToolUseWriteCanvasReadReminder,
  makePreToolUseTaskVisionCheckerDispatchInjector,
} from './hooks/pre-injectors.js';
import {
  makePreToolUseSkillStarterFilesCopier,
  makePreToolUseBashStarterFilesFallback,
} from './hooks/pre-starter-files.js';
import { makePreToolUseBoardNeighborhoodInjector } from './hooks/pre-board-neighborhood.js';
import { makePreToolUsePerformanceLogGuard } from './hooks/pre-performance-log-guard.js';
import { makeUserPromptSubmitHandler } from './hooks/user-prompt-submit.js';
import {
  makeFileChangedHandler,
  makePostToolUseFileChangedEmitter,
} from './hooks/file-events.js';
import {
  makeSessionStartHandler,
  makeStopReflectionHandler,
  makePostCompactHandler,
  makeSubagentStartHandler,
  makeSubagentStopHandler,
} from './hooks/lifecycle.js';
import { makePostToolUseEditWriteTrimHandler } from './hooks/post-trim.js';
import { makePostToolUseCanvasFocusPageHandler } from './hooks/post-canvas-focus.js';
import {
  makePostToolUseExitPlanModeHandler,
  makePostToolUseScreenshotHandler,
  makePostToolUseExportHandler,
  makePostToolUseGenerateImageRegenWatchdog,
  makePostToolUseStyleAnchorNudge,
} from './hooks/post-guidance.js';
import { makePostToolUseCanvasValidationHandler } from './hooks/canvas-validate.js';
import { makePostToolUseFailureHandler } from './hooks/failure.js';

/**
 * 工厂：根据当前 run 上下文 + workspace 路径生成 hooks 配置。
 *
 * @param {object} deps
 * @param {import('./context.js').AgentContext} deps.ctx
 * @param {string} deps.workspaceRoot
 * @param {string} [deps.projectId]
 * @returns {Partial<Record<string, Array<{ matcher?: string, hooks: Function[], timeout?: number }>>>}
 */
export function createHooks({ ctx, workspaceRoot, sharedRoot, sessionId, projectId } = {}) {
  return assertHooksWellFormed({
    // ── P0+ stage 1（不动）──

    // FileChanged → EventBus emit run.file_changed → 前端 reload iframe。
    // ⚠️ 2026-07-28 实测：这是 watcher 型 hook，需要有 hook 先返回
    // hookSpecificOutput.watchPaths 声明监听路径 watcher 才会启动 —— 我们从没
    // 声明过，所以它一次都没触发过。注册保留（将来开 watcher 可覆盖 bash/子代理
    // 写文件），实时刷新真正走下面 PostToolUse 的确定性直发。
    FileChanged: [{
      hooks: [makeFileChangedHandler({ ctx, workspaceRoot })],
    }],

    // ~~PreToolUse(Bash) 白名单~~ Phase 3d 删 —— 改用 session-loop.js sandbox option
    // OS 级隔离（macOS sandbox-exec / Linux bubblewrap），filesystem.allowWrite/denyRead
    // 替代命令级正则。

    // PreToolUse Agent：强制子代理前台跑，主 agent 才拿得到报告。
    //
    // matcher 写 'Task|Agent'：SDK 0.3 起工具真名叫 **Agent**，'Task' 是旧别名
    // （sdk.mjs 的 i6 表 Task→Agent，binary 侧 matcher 也吃这个别名 —— 2026-08-03
    // 双 matcher 探针实测两个都命中）。两个都写，换 SDK 版本时不会静默失配。
    PreToolUse: [{
      // 演出记录隐私闸：Read/Grep 直接点到演出文件夹的对话记录 → deny + 教义
      //（RP 台词只走 chatai 通路不进设计会话；写不拦——建场要种开场白）。
      // ⚠️ 边界写清楚：**只拦点名那一种读法**。`Grep path=<目录>` 和 Bash `cat`
      // 都过得去 —— 08-15 补过那两条（Grep 注排除 glob + Bash 命令闸），因为
      // 连带面太宽被用户撤回：固定记录名靠项目 .gitignore 兜（ripgrep 默认跳过
      // 被 gitignore 的文件），剩下的靠 rp-craft 的隐私纪律。
      matcher: 'Read|Grep',
      hooks: [makePreToolUsePerformanceLogGuard({ workspaceRoot })],
    }, {
      matcher: 'Task|Agent',
      hooks: [
        makePreToolUseAgentForceForegroundHandler(),
        // vision-checker 派遣 prompt 模板首次注入（仅当 subagent_type='vision-checker'）
        makePreToolUseTaskVisionCheckerDispatchInjector(),
      ],
    }, {
      // ⚠️ Grep 的输入改写只许有这一个 handler——两个各返回 updatedInput 会互相抹掉
      matcher: 'Grep',
      hooks: [makePreToolUseGrepContentDefaultHandler()],
    }, {
      // Skill 加载 deskskill 时才拷起手文件（canvas.template.html 等）——
      // 2026-07-27 起从 session-loop init 挪到这里：session ≠ 默认 deck 任务
      matcher: 'Skill',
      hooks: [makePreToolUseSkillStarterFilesCopier({ workspaceRoot })],
    }, {
      // 兜底：agent 没走 Skill 直接 cp canvas.template.html → 现场补拷
      matcher: 'Bash',
      hooks: [makePreToolUseBashStarterFilesFallback({ workspaceRoot })],
    }, {
      // get_pending_changes 首次调用时注入 DirectEdit 逐 kind 处理协议全文
      // （prelude 只留流程骨架，~90 行细则挪到 prompts/tools/direct-edit-protocol.md）
      matcher: 'mcp__nodesign__get_pending_changes',
      hooks: [makePreToolUseGetPendingChangesProtocolInjector()],
    }, {
      // generate_image 两个 hook 串：先目标页提醒（已有），再首次注 cookbook 完整版
      matcher: 'mcp__nodesign__generate_image',
      hooks: [
        makePreToolUseGenerateImageReadPageReminder(),
        makePreToolUseGenerateImageCookbookInjector(),
      ],
    }, {
      // roll_film 首次调用时注入 H3 三字段提示词手册（纪律配方全在里面）
      matcher: 'mcp__nodesign__roll_film',
      hooks: [makePreToolUseRollFilmCookbookInjector()],
    }, {
      // paint_still 首次调用时注入本地生图手册（四模型选型+BFL 官方提示词实践）
      matcher: 'mcp__nodesign__paint_still',
      hooks: [makePreToolUsePaintStillCookbookInjector()],
    }, {
      // AskUserQuestion 首次调用时注入 NoDesign 的 preview 协议（2026-07-28 从
      // prelude 挪来：常驻 1.2k tokens，但只有真要问用户时才用得上）
      matcher: 'AskUserQuestion',
      hooks: [makePreToolUseAskUserQuestionProtocolInjector()],
    }, {
      // expose_tweaks 首次调用时注入完整语法
      matcher: 'mcp__nodesign__expose_tweaks',
      hooks: [makePreToolUseExposeTweaksSyntaxInjector()],
    }, {
      // 关系线邻域（2026-08-14 切片③）：agent 摸某个文件时，把连着它的线注进来。
      // UserPromptSubmit 的全图摘要截断后，这里做精确补充。每个文件一个会话只注一次。
      matcher: 'Read|Edit|Write',
      hooks: [makePreToolUseBoardNeighborhoodInjector({ workspaceRoot, projectId })],
    }, {
      matcher: 'Write',
      hooks: [
        // Write canvas.html 首次调用时提醒 agent 先 Read 拿 verbatim boilerplate
        // （SDK 对 Write 没有 Edit 那样的"必须 Read"强约束，凭印象重写 importmap /
        // shadcn-lite 容易差字节 → deck 看着写出来但浏览器加载不出 React）
        makePreToolUseWriteCanvasReadReminder(),
        // 首次写 HTML 时注入该形态的技术参考（deck: 模板结构 / 标记规约 / 库速查 /
        // 常坑；site: 目录约定 / 相对路径铁律 / 响应式与中文排版）。2026-07-28 从
        // prelude 搬来：那是参考知识不是行为，常驻 1.4k tokens 每轮都在，但只有真
        // 动 HTML 的那一刻用得上。
        makePreToolUseHybridReferenceInjector({ workspaceRoot }),
      ],
    }],

    // Stop —— agent 准备结束 query 时触发，发自检事件给前端
    Stop: [{
      hooks: [makeStopReflectionHandler({ ctx, workspaceRoot })],
    }],

    // PostCompact —— compact 后把摘要写入 spec.json 长期记忆
    PostCompact: [{
      hooks: [makePostCompactHandler({ ctx, workspaceRoot })],
    }],

    // ── Phase 2 升级 ──

    // SessionStart —— 之前是 noop 占位；现在 emit 一条事件让上层知道
    // session 是 startup / resume / clear / compact（注：clear 是 /clear 斜杠命令）
    SessionStart: [{
      hooks: [makeSessionStartHandler({ ctx })],
    }],

    // UserPromptSubmit —— 每次用户输入前自动注入 spec.json 决策摘要 +
    // canvas.html 当前页数。把 SKILL.md 软约束（"agent 自己 turn 开头 Read
    // spec.json"）变成 SDK 硬注入 —— agent 不必每次都自觉，hook 直接喂上下文。
    UserPromptSubmit: [{
      hooks: [makeUserPromptSubmitHandler({ ctx, workspaceRoot, sessionId, projectId })],
    }],

    // PostToolUse —— 按 MCP 工具名分别注 additionalContext，引导 agent 利用
    // 工具结果。matcher 字段是 SDK 标准（与 PreToolUse 'Bash' 同语义）。
    PostToolUse: [
      // Edit/Write 后干掉 tool_response.originalFile：FileEditOutput/FileWriteOutput
      // 默认含完整原文件（sdk-tools.d.ts:2270, 2328），这是上下文累积大头。
      // canvas.html 25KB 一次 Edit ≈ 6k tokens，30 turn 累积可达 180k+ → 触发 256k 上限。
      // 模型有 structuredPatch (diff 行) 看改动够了，原文件需要再用 Read 拿。
      {
        matcher: 'Edit|Write',
        hooks: [makePostToolUseEditWriteTrimHandler({ ctx })],
      },
      // 写完一笔立刻让前端应用（2026-07-28）：写文件系工具成功即从入参直发
      // run.file_changed，deck iframe / 产物墙不再等 run.done 才刷新。
      // （FileChanged watcher hook 从未真正触发过，见上方 FileChanged 注释）
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [makePostToolUseFileChangedEmitter({ ctx, workspaceRoot, sharedRoot, sessionId })],
      },
      // （曾有 Bash mkdir 认领任务钩子，08-08 扁平化随任务模型一起拆除。当时删了
      // hooks 数组却留下 `{ matcher: 'Bash' }` 空壳 —— SDK initialize 的大 try 被
      // 它的 TypeError 打穿，全部程序化钩子 + 全部 in-process MCP server 无声蒸发，
      // 潜伏六天（2026-08-14 空壳钩子灭门案）。删钩子必须删整个条目；下方
      // assertHooksWellFormed 出厂断言从此拦这类残骸。）
      // Canvas 焕新升级 S1d — Edit/Write canvas.html 时检测改动落在哪些 page →
      // emit run.canvas_focus_page（前端 SlideNavigator 跳页 + pulse 高亮）。
      // 不返 hookSpecificOutput，纯 emit；不阻塞 agent，不注 additionalContext。
      {
        matcher: 'Edit|Write',
        hooks: [makePostToolUseCanvasFocusPageHandler({ ctx })],
      },
      // Phase 3.2 — SDK plan mode：agent 调 ExitPlanMode 工具提交 plan，
      // host emit run.plan_for_approval 让前端弹 PlanReviewCard。
      // SDK 自身在 plan mode 下会停 agent 等待 host 切 mode 才继续，所以本 handler
      // 不需要返回 hookSpecificOutput.decision='block'，纯 emit 即可。
      {
        matcher: 'ExitPlanMode',
        hooks: [makePostToolUseExitPlanModeHandler({ ctx })],
      },
      {
        matcher: 'mcp__nodesign__screenshot_canvas',
        hooks: [makePostToolUseScreenshotHandler({ ctx })],
      },
      {
        matcher: 'mcp__nodesign__export_handoff',
        hooks: [makePostToolUseExportHandler({ ctx })],
      },
      // Phase Image-4：generate_image 调用计数 hook ——
      // agent 同 outputName regenerate 第 3 次时注 systemMessage 建议
      // 直接 chat 邀请用户在已有候选中拍板，避免闷头改浪费 token。
      {
        matcher: 'mcp__nodesign__generate_image',
        hooks: [makePostToolUseGenerateImageRegenWatchdog()],
      },
      // 2026-05-08 canvas 范式重整 #1/#3/#5/#6 反馈通道 ——
      // Edit/Write canvas.html 后跑一致性校验（mode-CSS / 必装 CSS / anchor 唯一 /
      // layout 推荐组件 / role 必装），有 issue 注 systemMessage 单 turn 反馈。
      // 跨 turn 持续延期下一轮（spec.json schema 扩展）。
      {
        matcher: 'Edit|Write',
        hooks: [makePostToolUseCanvasValidationHandler({ ctx, workspaceRoot })],
      },
      // record_decision 一般**不注** additionalContext（"继续主任务"那种跟 SDK
      // preset 重复，agent 自己懂）。唯一例外是"锚定风格"这一笔：那是项目级
      // 长期资产该落盘的时刻，而品牌档案 / 项目指引这两处 SDK 不知道。
      {
        matcher: 'mcp__nodesign__record_decision',
        hooks: [makePostToolUseStyleAnchorNudge({ sharedRoot })],
      },
    ],

    // PostToolUseFailure —— 任意工具失败时统一处理：emit 事件 + 给 agent
    // 注入恢复建议（避免重试同样的错）。
    PostToolUseFailure: [{
      hooks: [makePostToolUseFailureHandler({ ctx, projectId, sessionId })],
    }],

    // SubagentStart / SubagentStop —— 主动捕子代理生命周期。当前只 emit 事件
    // 给上层观察；不阻塞流程。stage 2 真接通子代理时这里加调度逻辑。
    SubagentStart: [{
      hooks: [makeSubagentStartHandler({ ctx })],
    }],
    SubagentStop: [{
      hooks: [makeSubagentStopHandler({ ctx })],
    }],
  });
}

/**
 * 出厂断言（2026-08-14 空壳钩子灭门案第 2 层）：createHooks 出口处校验每个事件
 * 数组的每个条目都有非空 hooks 数组且全是函数。校验放出口不放调用方 —— 跟着
 * 真相源走，任何调用路径都逃不过。
 *
 * 为什么必须启动即炸：一个 `{ matcher: 'Bash' }` 空壳条目会让 SDK 0.3.218
 * initialize 的大 try 抛 TypeError 并整段吞掉 —— 全部程序化钩子 + 全部
 * in-process MCP server 无声蒸发，mcp_servers 里连 failed 都不留，会话照常跑。
 * 静默降级是六天暗账，启动炸是五分钟定位。
 */
function assertHooksWellFormed(hooksByEvent) {
  for (const [event, entries] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(entries)) {
      throw new Error(`[hooks] ${event} 不是数组 —— createHooks 出厂断言拦截`);
    }
    entries.forEach((entry, i) => {
      const bad = !entry
        || !Array.isArray(entry.hooks)
        || entry.hooks.length === 0
        || entry.hooks.some((h) => typeof h !== 'function');
      if (bad) {
        const label = entry?.matcher ? ` (matcher: ${entry.matcher})` : '';
        throw new Error(
          `[hooks] ${event}[${i}]${label} 是空壳/坏条目（hooks 必须是非空函数数组）。`
          + '删钩子要删整个条目 —— 空壳会让 SDK initialize 把全部钩子和 in-process '
          + 'MCP server 无声吞掉（2026-08-14 灭门案）。',
        );
      }
    });
  }
  return hooksByEvent;
}
