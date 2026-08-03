/**
 * server/engine/agent/hooks.js — agent hooks 集中定义
 *
 * P0+ stage 1（C3-C7）：4 件套（Phase 3d 改为 3 件套，PreToolUse 删）
 *   FileChanged    — 文件改动 → EventBus emit file.changed → 前端 reload iframe
 *   Stop           — agent 收尾自检（占位，stage 2 接真业务）
 *   PostCompact    — compact 摘要写 spec.json 长期记忆
 *   ~~PreToolUse(Bash)~~ — Phase 3d 删，改用 SDK 内置 sandbox（session-loop.js sandbox 字段）。
 *                          OS 级隔离（macOS sandbox-exec / Linux bubblewrap）替代正则白名单。
 *
 * Phase 2（agent 层升级）：新增 5 类 hook
 *   UserPromptSubmit         — 每次用户输入前自动注入 spec.json 摘要 + canvas 页数
 *                              （把 SKILL.md "agent 自己 Read spec.json" 软约束变成 SDK 硬注入）
 *   SessionStart             — noop 占位升级为 emit run.session_start，让上层
 *                              区分 startup / resume / clear / compact
 *   PostToolUse(matcher)     — per MCP 工具注 additionalContext，引导 agent 利用工具结果
 *   PostToolUseFailure       — 工具失败时给 agent 恢复建议（避免重试同样的错）
 *   SubagentStart/Stop       — 主动捕子代理生命周期（vs 间接走 SDK task_* message）
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

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Events } from './events.js';
import { getQuery } from '../runs/active-runs.js';
import { mutateSpecJson } from '../../projects/workspace.js';
import { recordIssue, signatureOf } from '../../lib/issues-store.js';
import { ensureSkillStarterFiles, listSkillIds, listSkillStarterFiles } from './skill.js';
import {
  setActiveArtifact, getActiveArtifact, listWorkspaceArtifacts,
  detectTaskKind, readTaskMarker, kindOfPath, taskManifest, kindDef,
  KIND_DECK, KIND_SITE, ENTRY_FILE,
} from '../../lib/artifact-target.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 内部：UserPromptSubmit hook 读取 spec.json 时的最大字节数 */
const SPEC_JSON_MAX_BYTES = 200 * 1024;
/**
 * Context usage 警告分档（按真实容量算，kimi=256k）：
 *   soft   70% — 提醒：还能再写一阵；下个段落收尾时落档
 *   firm   85% — 加紧：开始整理结论 / 准备 spec.json
 *   urgent 92% — 已过 SDK auto-compact 触发线（90%×真实=230k for 256k 容量），立即收尾
 */
const CONTEXT_USAGE_WARN_LEVELS = [
  { percent: 70, tone: 'soft' },
  { percent: 85, tone: 'firm' },
  { percent: 92, tone: 'urgent' },
];
/** 内部：UserPromptSubmit hook 读 canvas.html 数页数时的最大字节数（防大文件吞内存） */
const CANVAS_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** 内部：spec.json.decisions 注入摘要时取最近 N 条 */
const SPEC_DECISIONS_TAIL = 5;

/**
 * 工具 prompt lazy 注入文件加载（首调即缓存）。仿 agents/index.js loadPrompt 模式。
 *
 * 用途：cookbook / tweaks-syntax / vision-checker-dispatch 这些 reference 文档
 * 不放系统 prompt 恒驻（每 turn 拖累），改由 PreToolUse hook 在 agent 首次调对应工具时
 * 通过 additionalContext 注入。文件存 prompts/tools/*.md，模块加载时一次性读完缓存到 map。
 *
 * fail-soft：缺失 / 读失败返回 stub 字符串，hook 注入也不至于崩；console.warn 让部署
 * 日志能立刻发现。
 */
const TOOL_PROMPT_CACHE = {};
function loadToolPrompt(name) {
  if (TOOL_PROMPT_CACHE[name] !== undefined) return TOOL_PROMPT_CACHE[name];
  const file = path.join(HERE, 'prompts', 'tools', `${name}.md`);
  try {
    TOOL_PROMPT_CACHE[name] = fsSync.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`[hooks] failed to load tool prompt ${name}.md (${err.message}); using stub`);
    TOOL_PROMPT_CACHE[name] =
      `(tool prompt ${name}.md not found at ${file}. PreToolUse hook will skip lazy injection — `
      + `agent fallbacks to whatever guidance lives in SKILL.md core.)`;
  }
  return TOOL_PROMPT_CACHE[name];
}

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
  return {
    // ── P0+ stage 1（不动）──

    // FileChanged → EventBus emit run.file_changed → 前端 reload iframe。
    // ⚠️ 2026-07-28 实测：这是 watcher 型 hook，需要有 hook 先返回
    // hookSpecificOutput.watchPaths 声明监听路径 watcher 才会启动 —— 我们从没
    // 声明过，所以它一次都没触发过。注册保留（将来开 watcher 可覆盖 bash/子代理
    // 写文件），实时刷新真正走下面 PostToolUse 的确定性直发。
    FileChanged: [{
      hooks: [makeFileChangedHandler({ ctx })],
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
      matcher: 'Task|Agent',
      hooks: [
        makePreToolUseAgentForceForegroundHandler(),
        // vision-checker 派遣 prompt 模板首次注入（仅当 subagent_type='vision-checker'）
        makePreToolUseTaskVisionCheckerDispatchInjector(),
      ],
    }, {
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
      // AskUserQuestion 首次调用时注入 NoDesign 的 preview 协议（2026-07-28 从
      // prelude 挪来：常驻 1.2k tokens，但只有真要问用户时才用得上）
      matcher: 'AskUserQuestion',
      hooks: [makePreToolUseAskUserQuestionProtocolInjector()],
    }, {
      // expose_tweaks 首次调用时注入完整语法
      matcher: 'mcp__nodesign__expose_tweaks',
      hooks: [makePreToolUseExposeTweaksSyntaxInjector()],
    }, {
      // Write canvas.html 首次调用时提醒 agent 先 Read 拿 verbatim boilerplate
      // SDK 对 Write 没有 Edit 那样的"必须 Read"强约束，凭印象重写 importmap /
      // shadcn-lite 容易差字节 → deck 看着写出来但浏览器加载不出 React。
      // 中期方向：anchored Edit-first 替换 <style id="design-tokens"> +
      // <div class="__nd-deck-wrap"> 两块，省 verbatim 搬运。详见 memory
      // idea_canvas_write_flow_redesign.md
      matcher: 'Write',
      hooks: [
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
      hooks: [makeUserPromptSubmitHandler({ ctx, workspaceRoot, sessionId })],
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
      // Bash 里 mkdir tasks/<名> 也算认领任务 —— agent 常用 mkdir 起手，
      // 如果那一轮被打断（没写成文件），任务目录会变成没主的孤儿，
      // 桌面上就会同时出现"会话区 + 无主任务区"两块（2026-07-28 实测踩到）
      {
        matcher: 'Bash',
        hooks: [makePostToolUseBashTaskBinder({ sharedRoot, sessionId })],
      },
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
  };
}

// ─────────────────────────────────────────────────────────────────────
// hook handlers
// ─────────────────────────────────────────────────────────────────────

/**
 * PreToolUse(Agent) 强制前台 —— 透明改 input，不 hard deny。
 *
 * ⚠️ 2026-08-03 修：**默认值翻了面，这个 hook 之前形同虚设。**
 *
 * 老 SDK：`run_in_background` 不传 = 前台，所以只需拦 `=== true`。
 * 新 SDK（sdk-tools.d.ts AgentInput 原文）："Agents run in the background by
 * default; you will be notified when one completes. **Set to false** to run this
 * agent synchronously when you need its result before continuing."
 *
 * 也就是说**不传 = 后台**。模型自然写法就是不传（探针实测 bg=undefined），于是：
 * 主 agent 只拿到一句 "Async agent launched successfully"，报告永远不回来。
 * 真实事故：2026-08-03 一个 explorer 烧了 38k tokens / 20 次工具调用 / 108 秒查
 * 完时局资料，主 agent 收到的 tool_result 里一个字都没有，只好自己重搜四轮，
 * 还跟用户说了句"研究员跑完了但报告没回传到我这儿"。
 *
 * 所以判据从"等于 true 才改"改成"**不是显式 false 就补 false**"。
 * 显式传了 false 的（模型自己知道要前台）原样放过，不重复改也不发提示。
 *
 * 为什么 NoDesign 一定要前台：创作的核心反馈环是 agent 看 explorer /
 * vision-checker 传回的素材 URL 与 critique → 据此改产物 → 再自检。
 * fire-and-forget 等于把这个环剪断，agent 拿不到结果只能盲写。
 * forwardSubagentText 已开，前台等的时候用户看得见子代理实时进度，不会卡死。
 *
 * 兜底另有一层：DEFAULT_TOOL_ALLOWLIST 里挂了 `TaskOutput`，万一还是漏成后台
 * （比如 isolation:'remote' 强制后台），主 agent 能凭 task_id 把报告捞回来。
 */
function makePreToolUseAgentForceForegroundHandler() {
  return async (input) => {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    // 显式前台，不动
    if (t.run_in_background === false) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...t, run_in_background: false },
        additionalContext:
          'NoDesign 工作台已把这次派遣改成前台（run_in_background: false），'
          + '你会在这次 tool_result 里直接拿到子代理的完整报告。'
          + '子代理默认是后台跑的，那样报告不会回到你手里——创作需要你看见素材和'
          + 'critique 才能改产物，所以这里一律前台。下次派遣请自己显式写 '
          + '`run_in_background: false`。',
      },
    };
  };
}


/**
 * PreToolUse(Grep) handler：把缺省 output_mode 改成 'content'。
 *
 * SDK Grep 工具默认 output_mode='files_with_matches' —— 只返回匹配到的文件名
 * 列表，不返回行内容。Agent 拿到文件名后还得再 Read 一遍，多一个 turn，浪费
 * tokens 和时延。NoDesign 设计场景下 agent grep 几乎都是想看实际文本（CSS
 * 类名定义在哪、某个 token 怎么用），'content' 是更合理的默认。
 *
 * 拦截规则：
 *   - 没传 output_mode 或传了空字符串 → updatedInput 改成 'content'
 *   - 显式传 'files_with_matches' / 'count' → 不动（agent 知道自己在做什么）
 *
 * 不发 additionalContext —— agent 不需要知道这个变换，行为对它透明，结果
 * 直接更有用。
 */
function makePreToolUseGrepContentDefaultHandler() {
  return async (input) => {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    if (t.output_mode && t.output_mode !== '') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...t, output_mode: 'content' },
      },
    };
  };
}


/**
 * FileChanged handler（P0+ s1 C4）：agent 写文件后 SDK 触发，转发给 EventBus。
 *
 * input: FileChangedHookInput (sdk.d.ts:557)
 *   - file_path: string         绝对路径或相对 cwd
 *   - event: 'change' | 'add' | 'unlink'
 *
 * 不在这里做 .html 过滤 —— 全部转发让前端按需消费（C18 ContextUsageBar /
 * C20 file changes 列表都可能用）。前端 Project.jsx 只对 canvas.html bump reloadToken。
 *
 * 返回 {}：不干预 SDK，不影响 agent loop。
 */
function makeFileChangedHandler({ ctx }) {
  // eslint-disable-next-line no-unused-vars
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.fileChanged(input.file_path, input.event));
    } catch (err) {
      console.warn(`[hooks/FileChanged] handler threw:`, err.message);
    }
    return {};
  };
}

// makeBashWhitelistHandler / ALLOWED_FIRST_TOKEN / DANGEROUS_PATTERNS / checkBashCommand
// Phase 3d 删除 —— 命令级正则白名单换成 SDK sandbox（session-loop.js）的 OS 级隔离。
// 如需回滚：git revert 3d commit，本段恢复。

/**
 * Stop handler（P0+ s1 C6）—— agent 准备结束 query 时触发。
 *
 * 两件事：
 * 1. emit run.stop_reflection（hasCanvas 信号给前端）
 * 2. SDK getContextUsage 拉上下文占用 → emit run.context_usage + 三档 70/85/92% 注 systemMessage
 *
 * input: StopHookInput (sdk.d.ts:5247)
 *   - stop_hook_active: boolean
 *   - last_assistant_message?: string
 */
function makeStopReflectionHandler({ ctx, workspaceRoot }) {
  return async (_input, _toolUseId, _options) => {
    let warnContextUsage = null;
    try {
      // 任务模型下产物住 tasks/<任务>/，这里以前只探 cwd 根的 canvas.html —— 自
      // 任务模型上线起就恒为 false，从来没真过。走统一寻址（deck 和站点都算数）。
      const hasCanvas = workspaceRoot
        ? (await listWorkspaceArtifacts(workspaceRoot)).length > 0
        : false;

      ctx.emit({
        type: 'run.stop_reflection',
        hasCanvas,
      });

      // SDK 0.2.86+ getContextUsage —— 每个 turn 收尾时拉一次上下文占用，
      // emit 给前端做可视化条 + 三档（70/85/92%）注 systemMessage 提示 agent 主动收尾
      // （Kimi gateway 上限 256k，曾经爆过 418k；spoofing 后 SDK auto-compact
      //  在 256k×0.9=230k 触发兜底）
      if (ctx.runId) {
        try {
          const query = getQuery(ctx.runId);
          if (query?.getContextUsage) {
            const usage = await query.getContextUsage();
            if (usage && typeof usage.totalTokens === 'number') {
              // 2026-07-30：这里原来手搓了第二种事件体 { used, max, percent, categories }。
              // 事件名跟 session-loop 那条一样，字段名一个都对不上 —— 前端读的是
              // totalTokens / maxTokens / percentage，所以这条在前端一直是纯噪音，
              // 全靠 store 的 merge「不覆盖已有值」才没显形。而每个 turn 的**最后**
              // 一条 context_usage 恰好总是它，任何"取最新一条"的下游拿到的都是
              // 一片 undefined。现在统一走 Events.contextUsage，全局只此一种形状。
              const evt = Events.contextUsage(usage, ctx.appModel);
              ctx.emit({ ...evt, runId: ctx.runId });

              const used = evt.totalTokens;
              const realMax = evt.maxTokens;
              const percent = evt.percentage;

              // realMax 有可能是 null（appModel 认不出、SDK 也没给容量）——
              // 那时 percentage 退回 SDK 自己的值，但下面的文案要拿 realMax 做减法，
              // 算不出容量就不提醒（宁可不说，也别说个编的数字）
              const hit = (Number.isFinite(realMax) && realMax > 0)
                ? [...CONTEXT_USAGE_WARN_LEVELS].reverse().find((l) => percent >= l.percent)
                : null;
              if (hit) {
                const usedStr = used.toLocaleString();
                const maxStr = realMax.toLocaleString();
                const remain = Math.max(0, realMax - used).toLocaleString();
                let body;
                if (hit.tone === 'soft') {
                  body = `上下文已用 ${percent}%（${usedStr}/${maxStr} tokens），还能再写一阵；下一个段落收尾时把当前进度落到 spec.json，避免后续 compact 丢上下文。`;
                } else if (hit.tone === 'firm') {
                  body = `上下文已用 ${percent}%（${usedStr}/${maxStr}，剩 ~${remain}）。从下一轮开始整理结论 / 落档，避免被自动 compact 硬切。`;
                } else {
                  body = `上下文已用 ${percent}%（${usedStr}/${maxStr}）。已逼近 SDK auto-compact 触发线（90%）；立即收尾或主动整理 spec.json，否则下一轮可能被压缩中断当前思路。`;
                }
                warnContextUsage = `<system-reminder>\n[context-usage] ${body}\n</system-reminder>`;
              }
            }
          }
        } catch (err) {
          console.warn(`[hooks/Stop] getContextUsage fail:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[hooks/Stop] handler threw:`, err.message);
    }
    if (warnContextUsage) {
      return { systemMessage: warnContextUsage };
    }
    return {};
  };
}

/**
 * PostCompact handler（P0+ s1 C7）—— SDK 自动 compact 后把 summary 持久化到 spec.json。
 *
 * input: PostCompactHookInput (sdk.d.ts:1879)
 *   - trigger: 'manual' | 'auto'
 *   - compact_summary: string
 *
 * 失败 fail-soft：spec.json 写不进去 console.warn 但不抛错（不阻塞 query）。
 */
function makePostCompactHandler({ ctx, workspaceRoot }) {
  return async (input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};
      const summary = input?.compact_summary;
      if (!summary || typeof summary !== 'string') return {};

      // 串行 read-modify-write 防 spec.json 三路并发覆盖（详见 workspace.js mutateSpecJson）
      // historyCount 在回调内 capture 出去 —— 之前 emit 里直接引用 spec 是 ReferenceError，
      // 整段被 try 静默吞，导致 run.compact_persisted 事件永远不发。
      let historyCount = 0;
      await mutateSpecJson(workspaceRoot, (spec) => {
        if (!Array.isArray(spec.history)) spec.history = [];
        spec.history.push({
          ts: new Date().toISOString(),
          source: 'compact',
          trigger: input.trigger || 'auto',
          summary,
        });
        historyCount = spec.history.length;
      });

      try {
        ctx.emit({
          type: 'run.compact_persisted',
          trigger: input.trigger || 'auto',
          summaryLength: summary.length,
          historyCount,
        });
      } catch { /* emit fail-safe */ }
    } catch (err) {
      console.warn(`[hooks/PostCompact] handler threw:`, err.message);
    }
    return {};
  };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 新增 handlers
// ─────────────────────────────────────────────────────────────────────

/**
 * SessionStart handler（升级原 noop 占位）。
 *
 * input: SessionStartHookInput (sdk.d.ts:3577)
 *   - source: 'startup' | 'resume' | 'clear' | 'compact'
 *   - agent_type?: string                  父 agent 类型（--agent 时有）
 *   - model?: string
 *
 * Phase 2 范围：仅 emit 事件让上层可见。不注 additionalContext / initialUserMessage —
 * spec.json 的恢复走 UserPromptSubmit 路径（每次用户输入前重新注入），而不是
 * SessionStart 一次性注入（一次性注入只在 session 开头有效，跨多个 turn 后过期）。
 */
function makeSessionStartHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.sessionStart(input.source, input.agent_type, ctx.appModel || input.model));
    } catch (err) {
      console.warn(`[hooks/SessionStart] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * UserPromptSubmit handler — 每次用户输入前自动注入 spec.json 决策摘要 +
 * canvas.html 当前页数到 additionalContext。
 *
 * 为什么要 hook 注入而不是让 agent 自己 Read：
 *   - SKILL.md 引导是软约束，agent 偶尔会忘
 *   - hook 注入 = SDK 硬保证，每个 turn 都有
 *   - 成本：hook 内 fs 读 2 个文件（< 200KB），单次 turn 增加 ~10-50ms。
 *     spec.json 摘要 +canvas 页数本来 agent 就要 Read，hook 提前喂效率更高
 *
 * input: UserPromptSubmitHookInput (sdk.d.ts:5475)
 *   - prompt: string                  用户原文
 *   - session_title?: string
 *
 * output: UserPromptSubmitHookSpecificOutput (sdk.d.ts:5481)
 *   - additionalContext?: string      注入后续 prompt（标记成 system 提示）
 *   - sessionTitle?: string           覆盖 session 标题（不用）
 */
function makeUserPromptSubmitHandler({ ctx, workspaceRoot, sessionId }) {
  return async (_input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};

      const parts = [];

      // 0. cwd + 关键路径常量（用户报告"agent 总找错路径"的根治）
      // 每个 turn 都注入让 agent 不必凭记忆推路径，看一眼 hook 提示就有
      // canonical 答案。especially: agent-memory 路径以前 prompt 0 提及，
      // agent 写品牌档案常写错位置（./brand.md / ./memory.md 等）→ BrandCard 读不到
      parts.push(
        `你的 cwd 是 ${workspaceRoot}\n`
        + `关键路径（用 ./ 相对路径访问，软链已挂好不要绕）：\n`
        + `  ./tasks/<任务名>/          产出的家。deck → canvas.html（用 mcp__nodesign__read_page 切片读，别 Read 全文件）；站点 → index.html + 子页 + style.css\n`
        + `  ./tasks/<任务名>/notes/    便利贴（.md，\\n---\\n 分面）——和用户共享的头脑风暴层，桌面上渲成可翻页贴纸\n`
        + `  ./spec.json                压缩历史暗档案（决策改写便利贴，这里别再写）\n`
        + `  ./assets/                  用户上传素材 + 你 curl 下载的资源（软链 → shared，跨 session 共享）\n`
        + `  ./agent-memory/            跨 session 长期记忆（软链 → shared）\n`
        + `    ├── memory.md            main agent 通用 memory（前端 MemoryCard 读这条）\n`
        + `    └── brand/memory.md      品牌档案（前端 BrandCard 读这条；写品牌信息一定走这个完整路径）`,
      );

      // 1. spec.json：取最近 N 条 decisions 拼摘要
      try {
        const specPath = path.join(workspaceRoot, 'spec.json');
        const stat = await fs.stat(specPath);
        if (stat.size <= SPEC_JSON_MAX_BYTES) {
          const raw = await fs.readFile(specPath, 'utf8');
          const spec = JSON.parse(raw);
          const decisions = Array.isArray(spec?.decisions) ? spec.decisions : [];
          if (decisions.length > 0) {
            const recent = decisions.slice(-SPEC_DECISIONS_TAIL);
            const lines = recent.map((d, i) => {
              const idx = decisions.length - recent.length + i + 1;
              const title = (d?.title || '(无标题)').slice(0, 80);
              const rationale = (d?.rationale || '').slice(0, 200);
              return `  ${idx}. ${title}${rationale ? ` — ${rationale}` : ''}`;
            }).join('\n');
            parts.push(
              `旧决策档案（spec.json 遗产，共 ${decisions.length} 条，最近 ${recent.length} 条；新决策一律走 record_decision → 任务便利贴）：\n${lines}`,
            );
          }
        }
      } catch {
        // spec.json 不存在 / 解析失败 / stat 失败：noop
      }

      // 1.5 任务便利贴清单（2026-07-30）：tasks/*/notes/*.md —— 决策 + 头脑风暴的
      // 共享层。metadata-not-content：只列文件和每张贴的首行标题，细节 agent 自己 Read
      try {
        const tasksDir = path.join(workspaceRoot, 'tasks');
        const taskEntries = await fs.readdir(tasksDir, { withFileTypes: true });
        const lines = [];
        for (const t of taskEntries) {
          if (!t.isDirectory() || t.name.startsWith('.')) continue;
          let noteFiles = [];
          try {
            noteFiles = (await fs.readdir(path.join(tasksDir, t.name, 'notes')))
              .filter(n => n.endsWith('.md') && !n.startsWith('.'));
          } catch { continue; }
          for (const n of noteFiles.slice(0, 12)) {
            let title = '';
            let faces = 0;
            try {
              const raw = await fs.readFile(path.join(tasksDir, t.name, 'notes', n), 'utf8');
              title = (raw.match(/^#\s+(.{1,60})/m)?.[1] || '').trim();
              faces = raw.split(/\n---\n/).length;
            } catch { /* 列出文件名就够 */ }
            const meta = [title, faces > 1 ? `${faces} 面` : ''].filter(Boolean).join(' · ');
            lines.push(`  tasks/${t.name}/notes/${n}${meta ? `（${meta}）` : ''}`);
          }
        }
        if (lines.length > 0) {
          parts.push(`任务便利贴（和用户共享，他看得到也可能改过；细节 Read）：\n${lines.join('\n')}`);
        }
      } catch {
        // tasks/ 不存在：noop
      }

      // 2. 现有产物清单（2026-07-28：任务模型下产物住 tasks/<任务>/，这里以前只看
      //    cwd/canvas.html —— 于是每一轮都在说"还不存在，这可能是首跑"，手上明明有
      //    一份七页的 deck。同日加站点后又要按形态报不同的东西：deck 报页数，
      //    站点报页面清单，报错了等于每轮对 agent 撒一次谎。）
      try {
        const artifacts = await listWorkspaceArtifacts(workspaceRoot);
        if (artifacts.length === 0) {
          parts.push(
            '这个 workspace 还没有产物 —— 产出型工作先建 tasks/<任务名>/，'
            + `deck 往里写 ${ENTRY_FILE[KIND_DECK]}，站点写 ${ENTRY_FILE[KIND_SITE]}，`
            + `世界（角色扮演）写 ${ENTRY_FILE.world}。`,
          );
        } else {
          const active = getActiveArtifact(sessionId)?.path || null;
          const lines = [];
          const manifestCache = new Map();   // 同任务多产物：manifest 只算一次
          for (const a of artifacts.slice(0, 8)) {
            let note = '';
            try {
              if (a.task) {
                // 形态说明由注册表出（每个产物一行：deck 报页数，站点报页面清单+产物根）
                const taskDir = path.join(workspaceRoot, 'tasks', a.task);
                if (!manifestCache.has(a.task)) manifestCache.set(a.task, await taskManifest(taskDir));
                const m = manifestCache.get(a.task);
                const relInTask = a.rel.replace(/^tasks\/[^/]+\//, '');
                const art = m?.artifacts?.find(x => x.entryRel === relInTask) || null;
                note = art ? await kindDef(art.kind).describe(taskDir, art) : '还判不出形态';
              } else {
                // 旧式 cwd 单 deck
                const stat = await fs.stat(path.join(workspaceRoot, a.rel));
                if (stat.size <= CANVAS_HTML_MAX_BYTES) {
                  const raw = await fs.readFile(path.join(workspaceRoot, a.rel), 'utf8');
                  const n = (raw.match(/<section\b[^>]*\bdata-page=/g) || []).length;
                  note = n > 0 ? `deck · ${n} 页` : 'deck · 还没有 <section data-page=> 分页结构';
                } else {
                  note = `deck · ${(stat.size / 1024).toFixed(0)}KB，Read 时配 limit 分段读`;
                }
              }
            } catch { note = '读不到'; }
            lines.push(`  ${a.rel}（${note}）${a.rel === active ? '  ← 画布工具默认打这份' : ''}`);
          }
          parts.push(`现有产物：\n${lines.join('\n')}`);
        }
      } catch {
        // 扫不动就不说，别拿错信息误导
      }

      // 3. design-plan.md：仅检查存在性，不读内容
      // 设计原则 metadata-not-content：给 agent "地图"不给"答案"，保留主动 Read 的判断力
      // 避免"被注入摘要后反而不主动读"的反模式
      try {
        const planPath = path.join(workspaceRoot, 'design-plan.md');
        await fs.access(planPath);
        parts.push(
          'design-plan.md 已存在（plan mode 产出的故事弧）。涉及编辑 / 生成时建议先 Read 对应页 c_decisions（reference / opposition / constraint / motion），对照主线再下笔；改动跟主线方向不一致时跟用户点一下再动。',
        );
      } catch {
        // design-plan.md 不存在：noop
      }

      // 4. session-config.json：tweaks_mode_enabled 注入对应行为提示
      // 用户在 toolbar Tweaks toggle 控制；ON / OFF 对应不同的 agent 行为
      try {
        const cfgPath = path.join(workspaceRoot, 'session-config.json');
        const stat = await fs.stat(cfgPath);
        if (stat.size <= 8 * 1024) {
          const raw = await fs.readFile(cfgPath, 'utf8');
          const cfg = JSON.parse(raw);
          // 默认 true（用户没改过 toggle 时 = 启用）
          const tweaksEnabled = cfg?.tweaks_mode_enabled !== false;
          if (tweaksEnabled) {
            parts.push(
              '【Tweaks 模式：启用】用户偏好"可调产品"——deck 形态稳定后，建议调 expose_tweaks 暴露核心微调参数（颜色 / 字号 / 排版密度等）让用户拖滑杆即时改样式，这是 NoDesign 的差异化价值。',
            );
          } else {
            parts.push(
              '【Tweaks 模式：禁用】用户在 toolbar 关闭了 Tweaks——这次跳过 expose_tweaks，按对话方式让用户提需求你来 Edit。已暴露的 controls 保留不动，不新增 / 不重 expose。',
            );
          }
        }
      } catch {
        // session-config.json 不存在 / 解析失败：默认行为（启用），不注入
      }

      if (parts.length === 0) return {};

      const additionalContext = `[NoDesign 工作台自动注入的当前状态]\n\n${parts.join('\n\n')}\n\n请基于这些信息处理用户的请求。`;

      // 不 emit 业务事件 —— additionalContext 注入是私域提示，不需要前端展示
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      };
    } catch (err) {
      console.warn(`[hooks/UserPromptSubmit] handler threw:`, err.message);
      return {};
    }
  };
}

/**
 * PostToolUse(Edit|Write) handler —— 干掉 tool_response.originalFile 防上下文累积。
 *
 * 背景：
 *   FileEditOutput.originalFile / FileWriteOutput.originalFile (sdk-tools.d.ts:2270, 2328)
 *   是完整原文件内容。canvas.html 25KB 一次 Edit 在 tool_result 里等于 6k tokens。
 *   30 turn 累积 ≈ 180k tokens → 跟 Kimi 256k 上限挤爆（用户实测 418k 报错）。
 *
 *   structuredPatch（diff 行）是模型理解改动所需的全部信息；oldString/newString
 *   是模型自己刚才传的 input，本来就在上下文里。originalFile 对模型基本无用 —
 *   要看完整文件后续再 Read 即可。
 *
 * 行为：
 *   updatedToolOutput 是 SDK 提供的"改写发给 model 的 tool_result"通道
 *   (sdk.d.ts:1944)。**只影响 model 视图**，jsonl 持久化仍是原 tool_response。
 *   也就是 forkSession / 断线恢复看到的还是完整产物 — 不丢数据。
 *
 *   保留字段：filePath / oldString / newString / structuredPatch / type / gitDiff
 *   清掉字段：originalFile（替换为 null，保持类型 string|null）
 *
 *   非 Edit/Write 的 tool_response 形态（如 input 不带 originalFile） noop。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 * output: PostToolUseHookSpecificOutput (sdk.d.ts:1938)
 */
/**
 * PostToolUse(写文件系工具) → 直发 run.file_changed（2026-07-28）。
 *
 * SDK 的 FileChanged hook 是 watcher 型（要先声明 watchPaths 才启动），实测从未
 * 触发。这里走确定性路径：Write/Edit/MultiEdit/NotebookEdit 成功完成即从入参拿
 * 路径发事件 —— agent 每写完一笔，前端立刻 reload iframe / 刷产物墙 / 打角标，
 * 不再等 run.done。PostToolUse 只在工具成功后触发（失败走 PostToolUseFailure），
 * 不会把写坏的半成品刷给用户。
 */
function makePostToolUseFileChangedEmitter({ ctx, workspaceRoot, sharedRoot, sessionId }) {
  // eslint-disable-next-line no-unused-vars
  return async (input, _toolUseId, _options) => {
    try {
      const t = input?.tool_input;
      const filePath = typeof t?.file_path === 'string' ? t.file_path
        : typeof t?.notebook_path === 'string' ? t.notebook_path : null;
      if (filePath) {
        await bindTaskToSession(filePath, sharedRoot, sessionId);
        // 刚写的这份 html 就是"当前产物"——list_pages / screenshot / read_page
        // 不给 path 时默认打它，子代理不必知道任务目录长什么样（artifact-target.js）。
        // 形态（deck / site）不在这里定：resolveArtifactTarget 每次解析都按任务现状
        // 重算，免得"先写 index.html 记成 site、后来目录变了"这种陈旧状态。
        setActiveArtifact(sessionId, toWorkspaceRel(filePath, workspaceRoot));
        ctx.emit(Events.fileChanged(filePath, 'change'));
      }
    } catch (err) {
      console.warn('[hooks/PostToolUse:file-changed] emit failed:', err.message);
    }
    return {};
  };
}

function makePostToolUseEditWriteTrimHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const resp = input?.tool_response;
      if (!resp || typeof resp !== 'object') return {};
      if (!('originalFile' in resp)) return {};
      const originalSize = typeof resp.originalFile === 'string' ? resp.originalFile.length : 0;
      if (originalSize === 0) return {};  // 新建文件 originalFile 本就是 null

      const trimmed = { ...resp, originalFile: null };

      try {
        ctx.emit({
          type: 'run.tool_response_trimmed',
          tool: input?.tool_name || 'Edit/Write',
          field: 'originalFile',
          savedChars: originalSize,
        });
      } catch { /* emit fail-safe */ }

      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: trimmed,
        },
      };
    } catch (err) {
      console.warn(`[hooks/PostToolUse Edit|Write trim] handler threw:`, err.message);
      return {};
    }
  };
}

/**
 * PostToolUse(Edit|Write canvas.html) handler — Canvas 焕新升级 S1d。
 *
 * focus_page：检测改动落在哪些 <section data-page="N"> + 改动里有没有
 *   data-anchor="..." 引用 → emit run.canvas_focus_page(pages, anchor?)
 *   → 前端 SlideNavigator 自动 scrollIntoView + 1.5s pulse 高亮
 *
 * 不返 hookSpecificOutput / 不阻塞 agent / 不注 additionalContext。
 *
 * 检测策略（Edit / Write 都要看）：
 *   - Edit：从 tool_input.new_string 找 data-page / data-anchor
 *     （保守 — 只看新增的，不重复扫旧 content）
 *   - Write：从 tool_input.content 找（整文件都是新内容）
 *   - 非 canvas.html 文件：跳过
 *   - file_path 是相对 cwd 的，没法判断到底是不是 canvas.html，按 basename 匹配
 *
 * 失败 fail-soft：emit fail / 解析炸都不抛，console.warn 一行。
 */
function makePostToolUseCanvasFocusPageHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const filePath = input?.tool_input?.file_path;
      if (!filePath || typeof filePath !== 'string') return {};
      // basename 匹配 canvas.html（兼容相对/绝对路径）
      if (!/(?:^|[/\\])canvas\.html$/i.test(filePath)) return {};

      // 取改动文本：Edit 看 new_string，Write 看 content
      const toolName = input?.tool_name;
      let changeText = '';
      if (toolName === 'Edit') {
        changeText = String(input?.tool_input?.new_string || '');
      } else if (toolName === 'Write') {
        changeText = String(input?.tool_input?.content || '');
      } else {
        return {};
      }
      if (!changeText) return {};

      // focus_page —— 找 <section ... data-page="N"> + 可选 data-anchor
      try {
        const pageMatches = [...changeText.matchAll(
          /<section\b[^>]*\bdata-page\s*=\s*['"]?(\d+)['"]?/gi
        )];
        const pages = [...new Set(pageMatches.map(m => parseInt(m[1], 10)))]
          .filter(n => Number.isFinite(n));

        // 找 data-anchor — 取第一个，前端用它精确定位元素
        const anchorMatch = changeText.match(/\bdata-anchor\s*=\s*['"]([^'"]+)['"]/i);
        const anchor = anchorMatch ? anchorMatch[1] : null;

        // Edit 改的是 page 内某段时不会包含 <section data-page>，要从 file path
        // 上推 ——但 hook 时 canvas.html 已写完，可以读出来定位。为避免 hook IO
        // 阻塞 agent，这次先只 emit 显式带 data-page 的改动；不带 page 但带 anchor
        // 也 emit（前端能找到 anchor 元素自己反推 page）。
        if (pages.length > 0 || anchor) {
          ctx.emit(Events.canvasFocusPage(pages, anchor));
        }
      } catch (err) {
        console.warn(`[hooks/canvas_focus_page] handler partial failure:`, err.message);
      }

      return {};
    } catch (err) {
      console.warn(`[hooks/canvas_focus_page] outer handler threw:`, err.message);
      return {};
    }
  };
}

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
function makePostToolUseExitPlanModeHandler(_deps) {
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
 */
/**
 * 截图后的引导（2026-07-28；硬上限已撤销）
 *
 * 实测：一个真实会话 9-33 张截图，每张 0.6 倍光栅后 ≈1k vision tokens，且
 * **永久留在上下文里**（SDK 不能回改历史工具输出）。
 *
 * 曾经加过"整会话超 12 张就把图换成文字"的硬闸，撤掉了：那等于在 agent 检查
 * 自己作品的时候把它的眼睛蒙上，而且蒙得悄无声息 —— 它只会以为"看起来 OK"。
 * 省下来的几十 k 换不来这个代价。现在只报数、给建议，看不看由它自己判断；
 * 真正的省是 0.6 倍光栅（每张 1.85k→1.0k）和压缩阈值，不是拦着不让看。
 */
const SCREENSHOT_BUSY_HINT_AT = 6;   // 累到这个数开始提醒"大面积检查交给子代理"

function makePostToolUseScreenshotHandler({ ctx }) {
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
function makePostToolUseExportHandler({ ctx: _ctx }) {
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

// makePostToolUseRecordDecisionHandler — 已移除（git 历史可查）。
// 之前注 "继续做用户的当前任务" 跟 SDK preset 'claude_code' 教的内容重复，
// 让 agent 行为像被牵着走。删除后 agent 记完决策自己判断下一步，更接近
// SDK 默认行为。如未来观察到 agent 反复 record_decision 信号稀释，再考虑
// 加回（那时改成更精准的 anti-loop 检测，不是无脑注引导）。

/**
 * PostToolUseFailure handler — 工具失败时给 agent 恢复建议。
 *
 * input: PostToolUseFailureHookInput (sdk.d.ts:1908)
 *   - tool_name: string
 *   - tool_input: unknown
 *   - tool_use_id: string
 *   - error: string
 *   - is_interrupt?: boolean
 *   - duration_ms?: number
 *
 * output: PostToolUseFailureHookSpecificOutput (sdk.d.ts:1921)
 *   - additionalContext?: string
 */
function makePostToolUseFailureHandler({ ctx, projectId, sessionId }) {
  return async (input, _toolUseId, _options) => {
    const tool = input?.tool_name || 'unknown';
    const error = String(input?.error || '').slice(0, 500);
    const isInterrupt = Boolean(input?.is_interrupt);

    try {
      ctx.emit(Events.toolFailure(tool, error));
    } catch { /* ignore */ }

    // is_interrupt: 用户中断 → 不注入建议（agent 应该停下，不是恢复）
    if (isInterrupt) return {};

    // 自动层问题记录（2026-07-30）：每次真失败按"错误类"累加计数。
    // 这层不依赖 agent 自觉 —— 它太会兜底了，工具坏了换个姿势就绕过去，
    // 表面上活儿还是干完的，于是"某个工具本周失败 40 次"没人知道。
    // fail-soft：记录本身绝不能变成新的故障源。
    try {
      recordIssue({
        source: 'auto',
        toolName: tool,
        summary: `${tool} 失败：${error.slice(0, 120)}`,
        detail: error,
        projectId,
        sessionId,
        signature: signatureOf(`${tool}|${error}`),
      });
    } catch { /* ignore */ }

    let advice;
    if (tool === 'mcp__nodesign__screenshot_canvas') {
      advice =
        '截图失败。常见原因：\n'
        + '  1. canvas.html 还没创建 → 先 Write 创建首版\n'
        + '  2. playwright spawn 慢 / 失败 → 换 Read canvas.html 让用户看代码\n'
        + '  3. fullPage 截图太大 → 换 fullPage:false 截视口';
    } else if (tool === 'Bash') {
      advice =
        'Bash 命令失败。常见：\n'
        + '  1. sandbox 拦截（命令访问越界文件 / 不允许的网络）→ 换 Read / Glob / Grep / MCP 工具\n'
        + '  2. cwd 越界 → 路径相对 workspace\n'
        + '  3. 命令本身错（参数 / 文件不存在）→ 检查 stderr';
    } else if (tool === 'Write' || tool === 'Edit') {
      advice =
        `${tool} 失败。检查：\n`
        + '  1. 路径相对 workspace 还是绝对路径\n'
        + '  2. Edit 的 old_string 是否完整匹配（含空格/缩进）\n'
        + '  3. 文件是否存在（不存在用 Write 创建）';
    } else if (tool === 'Read') {
      advice = `Read 失败：${error}\n  1. 确认路径相对 workspace\n  2. 用 Glob 找文件确认存在`;
    } else if (tool === 'mcp__nodesign__generate_image') {
      // 按错因分流恢复建议（多数 generate_image 失败可恢复，**默认应重试不是放弃**）
      const errLower = error.toLowerCase();
      let cause;
      if (/http 429|rate.?limit|too many request/.test(errLower)) {
        cause = '网关限流（429）→ 等 3-5 秒**直接重试**，不必改 prompt。短时间内连续生图触发的，过会儿就 OK';
      } else if (/http 5\d\d|timeout|gateway|econnreset|socket/.test(errLower)) {
        cause = '网关 / 上游临时故障（5xx / 网络抖动）→ **直接重试 1-2 次**，多数情况下第二次就成；连续 3 次同错才考虑改思路';
      } else if (/no parts|no image|safety|blocked|policy/.test(errLower)) {
        cause = '模型拒生（安全过滤 / 内容策略）→ 调 prompt：换更具体的视觉词（流派 / 镜头 / 灯光），去掉可能触发安全过滤的人物 / 暴力 / 品牌侵权描述，重试';
      } else if (/http 400|invalid|bad request/.test(errLower)) {
        cause = 'Prompt 或参数问题（400）→ 检查：去掉否定描述（"no cars" → "empty street"）/ 加风格锚（"Saul Bass minimalist" / "Fujifilm color science"）/ aspectRatio + imageSize 组合是否合法，重试';
      } else if (/path|reference|enoent|not.?found/.test(errLower)) {
        cause = 'referenceImages 路径错 → 用 Glob 确认文件存在；只接 workspace 相对路径（assets/...），不接 http url；选 1-2 张最切题的不要全 14 张';
      } else if (/quota|budget|limit/.test(errLower)) {
        cause = '配额 / 预算限制 → 看 PM2 日志确认；非紧急情况下告诉用户，等用户决定';
      } else {
        cause = '错因未知 → **先重试 1 次**（多数是网络抖动）；同错重现再调 prompt 关键参数（5 元素公式 / 风格锚 / 文字带引号）。不要第一次失败就放弃';
      }
      advice =
        `generate_image 失败：${error}\n\n`
        + `→ ${cause}\n\n`
        + `**重要**：generate_image 多数失败是可恢复的（网关抖动 / prompt 微调）。第一次失败就放弃 = 用户没图用，跟"agent 不会生图"体感一样差。**默认应重试 1-2 次**，连续 3 次同错才考虑换思路 / 询问用户。`;
    } else {
      advice =
        `${tool} 失败：${error}\n`
        + '常见恢复：\n'
        + '  1. 先重试 1 次（网络抖动 / 临时上游故障多数情况下二次成功）\n'
        + '  2. 同错重现 → 分析错因调整参数 / 换工具\n'
        + '  3. 仅当连续失败且阻塞主线 → 在 chat 里跟用户说当前卡点 + 你打算怎么绕过';
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `[工具失败恢复建议]\n${advice}`,
      },
    };
  };
}

/**
 * SubagentStart handler — 子代理启动时主动 emit 事件给 EventBus。
 *
 * input: SubagentStartHookInput (sdk.d.ts:5258)
 *   - agent_id: string
 *   - agent_type: string
 *
 * 与 SDK system 'task_started' message 路径并行：task_* message 走的是 SDK
 * agentProgressSummaries 通道（30s 摘要），而 hook 是子代理 spawn 时立即触发，
 * 时序更前 + 更可靠。session-loop.js 已对 task_started 翻译成 run.task.started，
 * 这条 hook emit 的 run.subagent.start 是更主动的入口。
 *
 * Phase 2 仅 emit；不注入 additionalContext（子代理刚启动还没产出，注啥都早）。
 */
function makeSubagentStartHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStart(input.agent_id, input.agent_type));
    } catch (err) {
      console.warn(`[hooks/SubagentStart] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * SubagentStop handler — 子代理结束时主动 emit。
 *
 * input: SubagentStopHookInput (sdk.d.ts:5269)
 *   - stop_hook_active: boolean
 *   - agent_id: string
 *   - agent_transcript_path: string       子代理转录文件路径
 *   - agent_type: string
 *   - last_assistant_message?: string     子代理最后一条 assistant 文本
 *
 * 注意：SubagentStop 没有 specific output 类型（sdk.d.ts:5291 的 union 里没列），
 * 只能返回通用 SyncHookJSONOutput（continue/decision/systemMessage）。
 * 这里只 emit 不返 specific 输出，符合规范。
 */
function makeSubagentStopHandler({ ctx }) {
  return async (input, toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStop(
        input.agent_id,
        input.agent_type,
        input.last_assistant_message,
        input.agent_transcript_path,
        toolUseId,    // main agent 调 Task 时的 tool_use_id；前端按它 match 卡
      ));
    } catch (err) {
      console.warn(`[hooks/SubagentStop] handler threw:`, err.message);
    }
    return {};
  };
}

// Phase 3d 删除：Bash 白名单 / 危险正则 / checkBashCommand
// 替换为 SDK 内置 sandbox（session-loop.js sandbox 字段）。OS 级隔离比正则白名单更稳。
// 如需回滚：git revert 3d commit，恢复 ALLOWED_FIRST_TOKEN / DANGEROUS_PATTERNS / checkBashCommand。

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
function makePostToolUseGenerateImageRegenWatchdog() {
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
 * PreToolUse(generate_image) — 第一次调用时提醒 agent 先 Read 目标页面。
 *
 * 设计原则 metadata-not-content：不预解析 canvas.html 注入页面 HTML，
 * 而是提醒 agent 自己 Read。避免"被注入摘要后反而不主动读"的反模式。
 *
 * 触发：本 session（hook 工厂调用一次 → closure 一份 alreadyReminded）内
 *      第 1 次调用 generate_image；后续不再注入。
 *
 * 不阻塞工具调用，permissionDecision='allow' 直接放行。
 */
function makePreToolUseGenerateImageReadPageReminder() {
  let alreadyReminded = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyReminded) return {};
    alreadyReminded = true;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[generate_image 目标页提醒]\n\n'
        + '即将生成图片。如果还没看过目标页（canvas.html 中对应 <section data-page="N">），建议先 Read 一下：\n'
        + '  - 页面尺寸（多少行 / 多大留给图）\n'
        + '  - 主色（design-tokens 里的 --bg / --accent / --hero）\n'
        + '  - 已有视觉风格（hybrid 范式有无 React 组件 / 已有图片调性）\n\n'
        + '多数情况下第一张图会被当 referenceImages 种子用于全 deck，看一眼能避免后续违和（暖色页塞冷调插图这类）。本提醒每 session 只触发一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(generate_image) — 第一次调用时注 完整 cookbook（A-J 段）。
 *
 * 配套 SKILL.md 里的精简版 cookbook（5 元素公式 + 渲文字铁律 + 反例正例）保第一张
 * 图质量底线；本 hook 注入完整深度内容，让第二张起 agent 拿出更稳的 prompt。
 *
 * 触发：本 session 第 1 次调 generate_image；后续不再注入（避免 spam）。
 * 文件源：prompts/tools/generate-image-cookbook.md（模块加载时缓存）。
 */
/**
 * PreToolUse(Skill) — agent 加载 deskskill-engine-mini 时把 skill 起手文件
 * （canvas.template.html 等）拷进 session cwd。
 *
 * 2026-07-27 工作台升级起，starter 拷贝从 session-loop init 挪到这里：
 * session 不再默认等于 deck 任务（可能是便签 / 整理画布 / 收集参考），
 * 非 deck 会话的 cwd 不再预置 deck 模板。ensureSkillStarterFiles 幂等 + fail-soft。
 */
function makePreToolUseSkillStarterFilesCopier({ workspaceRoot }) {
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
function makePreToolUseBashStarterFilesFallback({ workspaceRoot }) {
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

/**
 * PreToolUse(get_pending_changes) — 第一次调用时注入 DirectEdit 逐 kind
 * 处理协议全文（字段结构 / pending-move 语义 / 邻居保护 / preDragLayout /
 * constraint anchor 表）。prelude 常驻部分只留流程骨架 + 语义底线三条，
 * ~90 行细则在 agent 真的要处理 pending changes 时才进 context。
 */
function makePreToolUseGetPendingChangesProtocolInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const protocol = loadToolPrompt('direct-edit-protocol');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[DirectEdit 逐 kind 处理协议 — 首次注入]\n\n'
        + protocol
        + '\n\n本协议每 session 只注入一次，后续处理 pending changes 直接按它做。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(AskUserQuestion) — 第一次问用户时注入 NoDesign 的问法协议
 * （何时用卡片 vs chat、schema、写选项的诀窍、preview 字段的两种形态与限制）。
 * 常驻在 prelude 里是 1.2k tokens，但一次会话里可能一次都用不上。
 */
function makePreToolUseAskUserQuestionProtocolInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const protocol = loadToolPrompt('ask-user-question-protocol');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[AskUserQuestion 协议 — 首次注入]\n\n'
        + protocol
        + '\n\n本协议每 session 只注入一次，后续问用户直接按它写。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(Write) — 第一次写 .html 时注入该形态的技术参考。
 *
 * 2026-07-28 加站点后按 kind 分流：以前是"任何 .html 都注入 hybrid deck 参考"，
 * 于是 agent 写站点首页时会被塞一份讲 `data-page` / `__nd-deck-wrap` / babel 的
 * 文档 —— 文不对题，还会诱导它往站点里塞 deck 专属结构。
 *
 * 两种形态各注一次（一个会话理论上只做一种，但试作阶段可能先摸另一种）。
 */
function makePreToolUseHybridReferenceInjector({ workspaceRoot } = {}) {
  const injected = new Set();
  return async (input, _toolUseId, _options) => {
    const fp = input?.tool_input?.file_path;
    if (typeof fp !== 'string') return {};
    const rel = workspaceRoot ? toWorkspaceRel(fp, workspaceRoot) : fp;
    const kind = workspaceRoot ? await kindOfPath(workspaceRoot, rel) : KIND_DECK;
    // 触发条件从「写 .html」改成「写的文件跟这个形态的入口同类型」（2026-08-01）。
    // 写死 .html 的年代只有 deck 和 site，两者入口都是 html 所以恰好没错；world
    // 的入口是 世界.md，于是它的技术参考**永远不会被注入**，agent 一辈子不知道
    // 目录结构该长什么样。扩展名从注册表的 entryFile 推，加形态不用再回来改。
    const wantExt = path.extname(kindDef(kind)?.entryFile || '.html').toLowerCase();
    if (path.extname(fp).toLowerCase() !== wantExt) return {};
    if (injected.has(kind)) return {};
    injected.add(kind);
    // 技术参考按注册表分发（kinds/<kind>.referenceDoc）—— 新形态自带自己那份
    const meta = kindDef(kind)?.referenceDoc || kindDef(KIND_DECK).referenceDoc;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          `<system-reminder>\n[${meta.title} — 首次注入]\n\n`
        + loadToolPrompt(meta.file)
        + '\n\n本参考每 session 每形态只注入一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

function makePreToolUseGenerateImageCookbookInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const cookbook = loadToolPrompt('generate-image-cookbook');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[generate_image 完整 cookbook — 首次注入]\n\n'
        + cookbook
        + '\n\n本 cookbook 每 session 只注入一次，已读完后续生图调用直接用即可。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(expose_tweaks) — 第一次调用时注 完整控件 schema 语法。
 *
 * SKILL.md 已有"何时暴露 / 暴露什么"哲学（5-8 个核心维度即可）；本 hook 注入完整
 * 控件类型 / target_var vs target_class_on / target_scope / Tailwind 桥接 / 常坑
 * 等参考语法，让 agent 写 controls JSON 时一次到位。
 *
 * 触发：本 session 第 1 次调 expose_tweaks；后续不再注入。
 * 文件源：prompts/tools/tweaks-syntax.md（模块加载时缓存）。
 */
function makePreToolUseExposeTweaksSyntaxInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const syntax = loadToolPrompt('tweaks-syntax');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[expose_tweaks 完整语法 — 首次注入]\n\n'
        + syntax
        + '\n\n本语法每 session 只注入一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(Write) — 首次 Write canvas.html 时提醒 agent 先 Read 拿 verbatim。
 *
 * 背景：canvas.html 已是 cp 后的 template（~3K boilerplate：importmap +
 * shadcn-lite + keyboard nav）。SDK 对 Write 没有 Edit 那样的"必须 Read"强约束，
 * agent 凭印象 verbatim 重写这些块容易差字节——importmap URL 错版本号、shadcn 闭
 * 花括号差一对——结果 deck 看着写出来但浏览器加载不出 React / standalone build
 * 报错。短期 hook 堵漏。
 *
 * 触发：matcher='Write' + file_path endsWith('canvas.html') + 本 session 首次。
 * 不匹配 canvas.template.html（template 本身不该被 Write）/ spec.json / .md 笔记。
 *
 * 设计原则：
 *   - metadata-not-content：不预读 template 注入内容，让 agent 自己 Read
 *   - 不阻塞，permissionDecision='allow'
 *   - 跟 prelude § 文件改动工作流 形成回声而非新规则
 *   - 内容里同时提 Write-first / Edit-first 两条走法，不强推
 *
 * 长期方向：anchored Edit-first（替换 <style id="design-tokens"> 和
 * <div class="__nd-deck-wrap"> 两块），省 ~5K verbatim 搬运。需实测样本支撑后
 * 再改 prelude 文件改动工作流大段。详见 memory idea_canvas_write_flow_redesign。
 */
function makePreToolUseWriteCanvasReadReminder() {
  let alreadyReminded = false;
  return async (input, _toolUseId, _options) => {
    if (alreadyReminded) return {};
    const filePath = input?.tool_input?.file_path || '';
    if (!filePath.endsWith('canvas.html')) return {};
    alreadyReminded = true;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[Write canvas.html 起手提醒]\n\n'
        + 'canvas.html 已是 cp 后的 template（~3K boilerplate：importmap + shadcn-lite + keyboard nav）。\n'
        + '凭印象 verbatim 重写这些块容易跟原文差一两个字符——importmap URL 错版本号、shadcn 闭花括号差一对——\n'
        + '结果 deck 看着写出来了但浏览器加载不出 React / standalone build 报错。\n\n'
        + '两条走法可选：\n'
        + '- Write-first：Read canvas.html 一遍把 verbatim 装进 context，再 Write 整文件\n'
        + '- Edit-first（更省）：Read 后只 Edit 替换 <style id="design-tokens"> 和 <div class="__nd-deck-wrap"> 两块（boilerplate 不动），~5K → 1-2K diff\n\n'
        + '本提醒每 session 只触发一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(Agent) — subagent_type='vision-checker' 时首次注 派遣 prompt 模板。
 *
 * 注：跟 makePreToolUseAgentForceForegroundHandler 共存于同一 'Task|Agent' matcher
 * 下，SDK 按数组顺序串行执行多个 hook。本 hook 仅在 subagent_type==='vision-checker'
 * 命中时注 dispatch 模板（含全 deck 自检 / 有 plan 时按计划 critique / 单页评审 3 模板）。
 *
 * ⚠️ 2026-08-03 修：原来读的是 `input.subagent_type`，而 PreToolUse 的 hook input
 * 形状是 `{ tool_name, tool_input, tool_use_id, ... }`（sdk.d.ts PreToolUseHookInput），
 * 工具入参在 **tool_input** 里 —— 顶层那个字段永远是 undefined，条件永远不成立。
 * 结果：历史上 6 次 vision-checker 派遣，模板一次都没注进去（jsonl 全量 grep 0 命中）。
 * 同文件的 force-foreground handler 一直读的是 `input?.tool_input`，是对的，
 * 这里当初抄漏了一层。
 *
 * 触发：本 session 第 1 次派 vision-checker；后续不再注入。
 * 文件源：prompts/tools/vision-checker-dispatch.md（模块加载时缓存）。
 */
function makePreToolUseTaskVisionCheckerDispatchInjector() {
  let alreadyInjected = false;
  return async (input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    if (input?.tool_input?.subagent_type !== 'vision-checker') return {};
    alreadyInjected = true;
    const dispatch = loadToolPrompt('vision-checker-dispatch');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[vision-checker 派遣 prompt 模板 — 首次注入]\n\n'
        + dispatch
        + '\n\n本模板每 session 只注入一次。后续派遣按这套结构写 prompt 即可。\n'
        + '</system-reminder>',
      },
    };
  };
}

// ─────────────────────────────────────────────────────────────────────
// Canvas 一致性校验（2026-05-08 范式重整 #1/#3/#5/#6 反馈通道）
// ─────────────────────────────────────────────────────────────────────

/**
 * 校验前预处理：strip HTML 注释 + CSS/JS block 注释
 *
 * 防止 false positive：模板里的 `<!-- ┄┄┄ 骨架范例 ... data-anchor="cover" ┄┄┄ -->`
 * HTML 注释 + page-styles 里"取消注释切到 ppt mode"的 CSS 注释切片，原始 grep
 * 都会误匹配。预先 strip 后再校验。
 *
 * 仅用于 validator 内部 regex 扫描；agent 看到的源文件不受影响。
 */
function stripCommentsForValidate(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')        // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '');      // CSS / JS block 注释（含 babel script）
}

/**
 * LAYOUT_COMPONENT_TRIGGERS — data-layout 值 → 推荐组件 import / detect 列表
 *
 * 校验项 4（#6）消费：data-layout ∈ keys + babel script 段所有 detect 都不命中
 * → warn agent reach for 推荐组件（模板自带 inline 4 件 / 或 import @radix-ui）
 *
 * 形态：{ [layoutName]: { recommend: string[], detect: string[] regex sources } }
 */
const LAYOUT_COMPONENT_TRIGGERS = {
  'comparison-table':         { recommend: ['<Tabs>', '<Card>'], detect: ['\\bTabs\\s*[\\.<]', '<TabsList\\b', '<Card\\b', "import[^;]*['\"]@radix-ui/react-tabs['\"]"] },
  'feature-cards':            { recommend: ['<Card> 阵列'], detect: ['<Card\\b', '<CardHeader\\b', '<CardContent\\b', '<CardTitle\\b'] },
  'use-cases':                { recommend: ['<Tabs>', '<Card> 阵列'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b', "import[^;]*['\"]@radix-ui/react-tabs['\"]"] },
  'core-products':            { recommend: ['<Card> 阵列', '<Tabs>'], detect: ['<Card\\b', '\\bTabs\\s*[\\.<]'] },
  'tech-highlights':          { recommend: ['<Card> 阵列'], detect: ['<Card\\b', '<Badge\\b'] },
  'feature-array':            { recommend: ['<Tabs>', '<Card>'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b'] },
  'variant-showcase':         { recommend: ['<Tabs> (≤4) / embla-carousel-react (>4)'], detect: ['\\bTabs\\s*[\\.<]', 'embla-carousel-react', 'useEmblaCarousel'] },
  'comparison':               { recommend: ['<Tabs>', '<Card> 对比阵列'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b'] },
  'step-switcher':            { recommend: ['<Tabs>'], detect: ['\\bTabs\\s*[\\.<]', "import[^;]*['\"]@radix-ui/react-tabs['\"]"] },
  'concept-vs-misconception': { recommend: ['<Tabs>', '<Card> 对照阵列'], detect: ['\\bTabs\\s*[\\.<]', '<Card\\b'] },
  'config-switcher':          { recommend: ['<Tabs>'], detect: ['\\bTabs\\s*[\\.<]'] },
  'quadrant':                 { recommend: ['<Card> 4 格阵列'], detect: ['<Card\\b', 'grid-cols-2'] },
};

/**
 * 校验项 1：data-anchor 唯一性
 *
 * 全文 grep `data-anchor="X"`，按值分组，重名 → 报冲突 + 列页号
 */
function validateAnchorUniqueness(html) {
  const matches = [...html.matchAll(/data-anchor\s*=\s*['"]([^'"]+)['"]/g)];
  if (matches.length === 0) return null;

  const groups = new Map();
  for (const m of matches) {
    const value = m[1];
    const idx = m.index;
    // 反推所在 page：往前找最近的 <section data-page="N">
    const before = html.slice(0, idx);
    const lastSection = [...before.matchAll(/<section\b[^>]*data-page\s*=\s*['"](\d+)['"]/g)].pop();
    const page = lastSection ? lastSection[1] : '?';
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(page);
  }

  const conflicts = [];
  for (const [value, pages] of groups) {
    if (pages.length > 1) {
      conflicts.push(`"${value}" → 出现在 page ${[...new Set(pages)].join(', ')} (${pages.length} 次)`);
    }
  }
  if (conflicts.length === 0) return null;
  return {
    title: `data-anchor 重名 ${conflicts.length} 处`,
    detail: conflicts.join('\n   ') + '\n   data-anchor 必须 deck 内唯一（重名加 -pN 页号或角色后缀，如 portrait-name-p3 / cover-sub-1）。findElementByAnchor 三层 fallback 第一层是按 data-anchor 查；重名时 querySelector 永远返第一个匹配，DirectEdit / 评论 pin 到错的元素。',
  };
}

/**
 * 校验项 2：data-layout 推荐组件 reach for 检查（#6）
 *
 * data-layout ∈ LAYOUT_COMPONENT_TRIGGERS keys 且整文件 babel script 段所有
 * detect[i] regex 都不命中 → warn agent 用 inline 4 件
 */
function validateLayoutComponents(html) {
  const layoutMatches = [...html.matchAll(/data-layout\s*=\s*['"]([^'"]+)['"]/g)];
  if (layoutMatches.length === 0) return null;

  // 抽 babel script 段（多个）拼一起
  const babelBlocks = [...html.matchAll(/<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).join('\n');

  const issues = [];
  const seen = new Set();
  for (const m of layoutMatches) {
    const layoutName = m[1];
    if (seen.has(layoutName)) continue;
    seen.add(layoutName);
    const trigger = LAYOUT_COMPONENT_TRIGGERS[layoutName];
    if (!trigger) continue;
    const anyHit = trigger.detect.some(src => {
      try { return new RegExp(src).test(babelBlocks); } catch { return false; }
    });
    if (!anyHit) {
      issues.push(`data-layout="${layoutName}" 适合 ${trigger.recommend.join(' / ')}，但 babel script 段没检测到对应组件`);
    }
  }
  if (issues.length === 0) return null;
  return {
    title: `${issues.length} 处 data-layout 漏用推荐组件`,
    detail: issues.join('\n   ') + '\n   模板 <script id="__nd-shadcn-lite"> 已自带 Card / Button / Badge / Tabs，0 import 直接 <Card> / <Tabs> 用即可。看 SKILL.md § Hybrid 选型表 + patterns/hybrid-grid.md。',
  };
}

/**
 * 校验项 3：data-layout-role 必装
 *
 * 每个 <section data-page> 必标 data-layout-role
 */
function validateLayoutRolePresence(html) {
  const sections = [...html.matchAll(/<section\b[^>]*data-page\s*=\s*['"](\d+)['"][^>]*>/g)];
  if (sections.length === 0) return null;
  const missing = [];
  for (const m of sections) {
    const tag = m[0];
    if (!/data-layout-role\s*=/.test(tag)) {
      missing.push(m[1]);
    }
  }
  if (missing.length === 0) return null;
  return {
    title: `${missing.length} 个 section 缺 data-layout-role`,
    detail: `Page ${missing.join(', ')} 没标 data-layout-role（image-led / text-led / data-led / hybrid 必选其一）。这字段决定页型分布 + 视觉判断；缺它系统按"未知"处理，patterns/<role>.md 也无法对应。`,
  };
}

/**
 * Canvas validation 总入口（PostToolUse Edit|Write canvas.html 触发）
 *
 * matcher 第一行 path filter：仅对 canvas.html 跑校验，其他文件 noop。
 * 单 hook 内 3 项串行校验（in-memory，~ms），有 issue 拼 systemMessage 注下一轮。
 *
 * 单 turn 反馈（不持久化）：agent 不修则下次 Edit 自然惩罚再报，跨 turn 持续
 * 延期下一轮（spec.json schema 扩展）。
 */
function makePostToolUseCanvasValidationHandler({ ctx: _ctx, workspaceRoot }) {
  return async (input, _toolUseId, _options) => {
    try {
      const fp = input?.tool_input?.file_path;
      if (!fp || !/(?:^|[/\\])canvas\.html$/i.test(fp)) return {};
      if (!workspaceRoot) return {};

      // 校验刚写的那份（2026-07-28）：任务模型下 deck 在 tasks/<任务>/canvas.html，
      // 这里以前固定读 cwd/canvas.html —— 文件不存在直接 ENOENT return，
      // 于是整套一致性校验在任务模型下从来没跑过。
      const canvasPath = path.resolve(workspaceRoot, fp);
      let html;
      try {
        const stat = await fs.stat(canvasPath);
        if (stat.size > CANVAS_HTML_MAX_BYTES) return {};  // 大文件 noop
        html = await fs.readFile(canvasPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
      }

      // 预 strip 注释（HTML + CSS/JS block）防 false positive
      const cleaned = stripCommentsForValidate(html);
      // hooks.js 文件内 helper 表达成 "校验项 N"，下面 issues 数组依序调对应 validator
      // 旧版含 mode-CSS / 必装 CSS 两项已删（2026-05-08 范式简化：不再有 deck-mode）

      const issues = [
        validateAnchorUniqueness(cleaned),
        validateLayoutComponents(cleaned),
        validateLayoutRolePresence(cleaned),
      ].filter(Boolean);

      if (issues.length === 0) return {};

      const body = issues.map((i, idx) => `${idx + 1}. ${i.title}\n   ${i.detail}`).join('\n\n');
      return {
        systemMessage:
          `<system-reminder>\n[canvas-validate] 你刚改完 ${fp}，系统检测到 ${issues.length} 项可疑：\n\n`
        + body
        + `\n\n如果有意为之（custom mode / 故意命名重复 等）忽略；否则在下一轮主动修。每次 Edit/Write 后都跑这套校验。\n`
        + `</system-reminder>`,
      };
    } catch (err) {
      console.warn('[hooks/canvas-validate] threw:', err.message);
      return {};
    }
  };
}


/** PostToolUse(Bash) —— 命令里出现 tasks/<名> 就把它认领给当前会话 */
function makePostToolUseBashTaskBinder({ sharedRoot, sessionId }) {
  return async (input, _toolUseId, _options) => {
    try {
      const cmd = input?.tool_input?.command;
      if (typeof cmd !== 'string') return {};
      const seen = new Set();
      for (const m of cmd.matchAll(/tasks\/([^\s/'"`;|&]+)/g)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        await bindTaskToSession(`tasks/${m[1]}/.probe`, sharedRoot, sessionId);
      }
    } catch (err) {
      console.warn('[hooks/PostToolUse:bash-task-bind]', err.message);
    }
    return {};
  };
}

/**
 * 任务=会话（2026-07-28 定死的一对一）：会话第一次往 tasks/<任务>/ 里写东西时，
 * 在任务目录里落一个 .nd-task.json 记住是谁的家。前端据此把"进任务"翻译成
 * "进那个会话"，把"退出任务"翻译成"退出会话"，不用再各处对表。
 *
 * 只写一次（已有 marker 不覆盖）—— 任务的归属在它被建出来那一刻就定了。
 */
/** 工具入参给的可能是绝对路径，也可能是相对 cwd 的 —— 统一成 workspace 相对 */
function toWorkspaceRel(filePath, workspaceRoot) {
  const p = String(filePath).replace(/\\/g, '/');
  if (!workspaceRoot) return p;
  const root = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  return abs.startsWith(root + path.sep) ? abs.slice(root.length + 1) : p;
}

async function bindTaskToSession(filePath, sharedRoot, sessionId) {
  if (!sharedRoot || !sessionId) return;
  const m = String(filePath).replace(/\\/g, '/').match(/(?:^|\/)tasks\/([^/]+)\//);
  if (!m) return;
  const taskDir = path.join(sharedRoot, 'tasks', m[1]);
  const marker = path.join(taskDir, '.nd-task.json');
  try {
    await fs.access(taskDir);     // 目录还没建出来就别造标记
  } catch { return; }

  // 形态（deck / site）在建目录那一刻还判不出来 —— Bash 认领走的是 `mkdir tasks/x`，
  // 那时目录是空的。所以 kind 允许**后补**：第一次写出入口文件后这里就能判出来，
  // 补进已有 marker。归属（sessionId）仍然只写一次，认领了就不改。
  const kind = await detectTaskKind(taskDir);
  const existing = await readTaskMarker(taskDir);
  if (existing) {
    if (kind && existing.kind !== kind && !existing.kindLocked) {
      try {
        await fs.writeFile(marker, JSON.stringify({ ...existing, kind }, null, 2), 'utf8');
      } catch (err) {
        console.warn('[hooks] backfill task kind failed:', err.message);
      }
    }
    return;                       // 已有归属，不动
  }
  try {
    await fs.writeFile(marker, JSON.stringify({
      sessionId,
      boundAt: new Date().toISOString(),
      ...(kind ? { kind } : {}),
    }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[hooks] bind task→session failed:', err.message);
  }
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
function makePostToolUseStyleAnchorNudge({ sharedRoot }) {
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
