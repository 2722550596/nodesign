/**
 * engine/agent/agent-shared.js — agent 跑 run 时复用的常量 + 翻译层
 *
 * 历史：原 `session-loop.js` 含 runAgent (per-turn 一次性 query 模式)。streamInput 重构后
 * 生产代码切到 session-loop.js (runSession，long-running query 跨多 turn)，
 * runAgent 死掉。本文件保留 session-loop.js 仍依赖的部分：
 *
 *   - NODESIGN_PRELUDE / NODESIGN_PLAN_INSTRUCTIONS  系统 prompt 段
 *   - DEFAULT_TOOL_ALLOWLIST / STREAMING_ENABLED     SDK options 默认值
 *   - pickThinkingConfig                              按 model 选 thinking 配置
 *   - handleSDKMessage / detectArtifact               SDK 消息 → EventBus 翻译层
 *
 * 调用方：server/engine/agent/session-loop.js (runSession)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Events } from './events.js';

// NoDesign agent 通用 prelude —— append 在 SDK preset 'claude_code' 之后、
// SKILL.md 之前。教 Claude Code 工具用法 + NoDesign 工作台共性约束（assets
// 必看 / 信息不足先问 / git 不自管）。所有 NoDesign agent 共用，跟具体 skill
// 解耦。模块级 readFileSync 一次性读入，避免每次 turn 重读。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NODESIGN_PRELUDE = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'prompts/nodesign-prelude.md'),
      'utf8',
    ).trim();
  } catch (err) {
    console.warn(`[agent-shared] failed to load nodesign-prelude.md:`, err.message);
    return '';
  }
})();

// Phase 3.1：plan-mode workflow instructions（替换 SDK 默认 code-impl phases）
// SDK 在 permissionMode='plan' 时把这段嵌入到 plan-mode system reminder 里，
// 自动包 read-only enforcement preamble + ExitPlanMode protocol footer。
// 内容是 NoDesign 设计场景特化版（设计 plan / 隐喻 / per-page 决策等），
// 不是 code implementation。
export const NODESIGN_PLAN_INSTRUCTIONS = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'prompts/nodesign-plan-instructions.md'),
      'utf8',
    ).trim();
  } catch (err) {
    // FATAL：plan mode 进去后 agent 看不到 workflow 指导，行为完全乱。fail-soft
    // 仍返回 ''（避免起服务直接挂），但用 console.error 让部署日志能立刻发现。
    console.error(
      `[agent-shared] FATAL: nodesign-plan-instructions.md load failed — `
      + `plan mode will lack workflow guidance:`,
      err.message,
    );
    return '';
  }
})();

// SDK base 工具白名单（Options.tools，sdk.d.ts:1216）—— 限定主 agent 可见的
// **内置工具**集合。MCP 工具（mcp__nodesign__*）由 mcpServers 字段独立暴露，
// 不需要列在这里；新加内置工具（如 ExitPlanMode）按需追加。
//
// 设计要点：
//   - Bash 是必需（git/playwright/zip 都靠它）。沙盒由 OS 级 sandbox 字段保证
//   - AskUserQuestion 是 deferred 工具：bypassPermissions 不影响它；canUseTool
//     callback 拦截它注入用户答案（session-loop.js canUseTool 段）
//   - WebFetch（SDK 内置）走 binary 自带的 prompt 总结，不灌完整 HTML 给 model；
//     WebSearch 走我们自己的 mcp__nodesign__web_search（4 provider，免 server_tool_use）
//   - Task 是子代理调用入口；agents 字段注册的子代理通过 Task 暴露给主 agent。
//     **Task 漏挂 = 所有子代理形同摆设**（P0+ stage 1 修复过一次的隐性 bug）
//
// 非显式语义：
//   - tools 字段是"可见集合"白名单，不在里面的内置工具会被剥离
//   - 不是 auto-allow（auto-allow 由 permissionMode='bypassPermissions' 已经全
//     跳）。之前 sdkOptions 同设 allowedTools 是冗余，已删
export const DEFAULT_TOOL_ALLOWLIST = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash',
  'AskUserQuestion',
  'WebFetch',
  'Task',
  'ExitPlanMode',
];

// 主产物候选 — canvas.html 列首位（P0 per-project workspace 主文件名），
// 其余兼容 deec72d 之前的 e2e smoke / 旧 deskskill-engine 输出。
const ARTIFACT_CANDIDATES = ['canvas.html', 'deck.html', 'index.html', 'output.html'];

// P0+ s1 C24：流式打字效果（text / thinking 逐 token 推送）。
// 跟 sdkOptions.includePartialMessages 同步 —— 我们默认开（前端要打字效果）。
// 启用时 handleAssistantBlocks 跳过 text/thinking blocks（已经从 stream_event 推完，
// 避免双推），但仍推 tool_use（stream_event 里 tool_use input 是 partial JSON delta
// 不好用，等 assistant message 完整 block 来一次更省事）。
export const STREAMING_ENABLED = true;

/**
 * 按 model id 选 thinking config（SDK 把 thinking 通道按模型分两路）。
 *
 * sdk.d.ts:1374-1385 + :5342-5368：
 *   - { type: 'adaptive' } 仅 Opus 4.6+ 支持（Claude 自决何时/多少 thinking，是这些模型的 SDK 默认）
 *   - { type: 'enabled', budgetTokens } 是 older-model 路径（Sonnet 4.5 / Sonnet 4 / Haiku 4.5 / 第三方）
 *
 * Kimi K2.6 走 Anthropic 协议但 capability 跟 Sonnet 4.5 同级 —— 视同 older
 * model 走 enabled 路径。adaptive 在非 Opus 4.6+ 上等于不开 thinking
 * （H3 实测：Kimi+adaptive → jsonl 0 thinking blocks），所以默认走 enabled。
 *
 * Future-proof 设计：
 *   - claude-opus-4-[6789] 覆盖 4.6/4.7/4.8/4.9
 *   - claude-opus-[5-9] 覆盖 5.x/6.x/7.x/8.x/9.x（默认假设 Opus 新一代仍走 adaptive）
 *   - 新一代 Opus 改了行为时再扩 regex
 */
export function pickThinkingConfig(model) {
  if (model && /^claude-opus-(?:4-[6789]|[5-9])/.test(model)) {
    return { type: 'adaptive' };
  }
  return { type: 'enabled', budgetTokens: 8192 };
}

// ── SDK message → EventBus 翻译层 ──

/**
 * 把 SDK 各种 message 类型翻译成 Nodesign 内部事件。
 * SDKMessage union 见 sdk.d.ts:2988（28+ 种 type/subtype 组合）。
 *
 * 翻译策略：
 * - 主流程消息（assistant / user / result）：走 handleAssistantBlocks / handleUserBlocks
 * - SDK system subtype 多达 14 种：分派到对应 Events 构造器
 * - 旁路类型（stream_event / tool_use_summary / keep_alive）：noop（前端不需要）
 */
export function handleSDKMessage(ctx, msg) {
  // 首条 message 含 session_id，记下
  if (msg.session_id) ctx.recordSdkSession(msg.session_id);

  switch (msg.type) {
    case 'assistant':
      // BetaMessage 含 content[] (text / thinking / tool_use blocks)
      // STREAMING_ENABLED 时 text/thinking 已从 stream_event 推完，跳过避免双推
      handleAssistantBlocks(ctx, msg.message?.content || [], STREAMING_ENABLED);
      break;

    case 'user':
      // 一般是 tool_result 反馈（agent loop 中 SDK 会回填）
      handleUserBlocks(ctx, msg.message?.content || []);
      break;

    case 'system':
      handleSystemMessage(ctx, msg);
      break;

    case 'stream_event':
      // SDKPartialAssistantMessage —— 流增量（includePartialMessages: true）
      // 推逐 token text_delta / thinking_delta 给前端实现打字效果
      if (STREAMING_ENABLED) handleStreamEvent(ctx, msg);
      break;

    case 'tool_use_summary':
      // SDKToolUseSummaryMessage —— 工具调用摘要（旁路审计），不入 EventBus
      break;

    case 'tool_progress':
      // SDKToolProgressMessage —— 工具执行 >1s 时定期推（前端可显示"读取中 12s..."）
      ctx.emit(Events.toolProgress(msg.tool_use_id, msg.tool_name, msg.elapsed_time_seconds));
      break;

    case 'prompt_suggestion':
      // SDKPromptSuggestionMessage —— 每轮后 piggyback 预测的下条 prompt
      // 前端 SuggestionChip（C19）渲染
      ctx.emit(Events.promptSuggestion(msg.suggestion));
      break;

    case 'status':
      // SDKStatusMessage —— 'compacting' | 'requesting' | null
      ctx.emit({ type: 'run.status', status: msg.status });
      break;

    case 'rate_limit_event':
      ctx.emit({ type: 'run.rate_limit', info: msg.rate_limit_info });
      break;

    case 'auth_status':
      // 鉴权状态（首次 spawn 时可能出现）
      if (msg.error) {
        ctx.emit({ type: 'run.auth_error', message: msg.error });
      }
      break;

    case 'keep_alive':
      // SDKKeepAliveMessage —— WS 心跳，不入 EventBus
      break;

    case 'result':
      // 由外层 for await 捕获处理（finalText / artifactPath / counters）
      break;

    default:
      // 兜底：未识别的新 type 留个调试痕迹，方便 SDK 升级时发现
      console.warn(`[run ${ctx.runId}] unknown SDK message type:`, msg.type);
      break;
  }
}

/**
 * SDK type:'system' 下的 14 种 subtype 派发。集中放一处便于维护。
 */
function handleSystemMessage(ctx, msg) {
  switch (msg.subtype) {
    case 'init':
      // 初始化元信息：agents / tools / mcp_servers / model / permissionMode 等
      ctx.emit(Events.systemInit({
        agents: msg.agents,
        tools: msg.tools,
        mcpServers: msg.mcp_servers,
        model: msg.model,
        permissionMode: msg.permissionMode,
        skills: msg.skills,
        plugins: msg.plugins,
        claudeCodeVersion: msg.claude_code_version,
        cwd: msg.cwd,
      }));
      break;

    case 'compact_boundary':
      ctx.counters.compactBoundaries += 1;
      ctx.emit({ type: 'run.compact_boundary', compactMetadata: msg.compact_metadata });
      break;

    case 'api_retry':
      // SDKAPIRetryMessage（sdk.d.ts:2322）：API 请求失败，可重试，将在 retry_delay_ms 后重试。
      // 之前落到 default warn —— 改为 emit 让上层能看到"网络抖了，agent 还在重试"，
      // 避免用户以为卡死。
      ctx.emit(Events.apiRetry(
        msg.attempt,
        msg.max_retries,
        msg.retry_delay_ms,
        msg.error_status,        // number | null（连接错误时为 null）
        msg.error,               // SDKAssistantMessageError union
      ));
      break;

    case 'files_persisted':
      // SDKFilesPersistedEvent —— agent 写完 file checkpoint 持久化通知
      // FileChanged hook 触发的 file.changed 事件是更直接的；这个仅审计
      ctx.emit(Events.filesPersisted(msg.files, msg.failed));
      break;

    case 'memory_recall':
      // 自动 memory 召回 —— 前端可显示"recalled from memory"
      ctx.emit(Events.memoryRecall(msg.mode, msg.memories));
      break;

    case 'task_started':
      ctx.emit(Events.taskStarted(
        msg.task_id, msg.description, msg.task_type, msg.prompt, msg.tool_use_id,
      ));
      break;

    case 'task_progress':
      // agentProgressSummaries: true 时每 ~30s 一次："正在调整字号节奏" 之类
      ctx.emit(Events.taskProgress(
        msg.task_id, msg.description, msg.summary, msg.last_tool_name, msg.usage, msg.tool_use_id,
      ));
      break;

    case 'task_updated':
      ctx.emit(Events.taskUpdated(msg.task_id, msg.patch, msg.tool_use_id));
      break;

    case 'task_notification':
      ctx.emit(Events.taskNotification(
        msg.task_id, msg.status, msg.summary, msg.usage, msg.tool_use_id,
      ));
      break;

    case 'notification':
      // SDKNotificationMessage —— 系统级 toast（priority: low/medium/high/immediate）
      ctx.emit(Events.notification(msg.key, msg.text, msg.priority, msg.color, msg.timeout_ms));
      break;

    case 'session_state_changed':
      ctx.emit(Events.sessionState(msg.state));
      break;

    case 'hook_started':
      ctx.emit(Events.hookStarted(msg.hook_name, msg.hook_event));
      break;

    case 'hook_progress':
      // hook 执行中 stdout/stderr 流（仅 includeHookEvents: true 时）
      // 前端不需要，旁路日志即可
      break;

    case 'hook_response':
      ctx.emit(Events.hookResponse(
        msg.hook_name, msg.hook_event, msg.outcome, msg.output, msg.exit_code,
      ));
      break;

    case 'plugin_install':
      // 插件安装进度（headless mode），不入 EventBus
      break;

    case 'local_command_output':
      // 本地 slash command 输出（/voice / /usage 等），不入 EventBus
      break;

    case 'elicitation_complete':
      // MCP elicitation URL 模式完成确认，旁路
      break;

    case 'mirror_error':
      // SessionStore mirror 失败，旁路（我们没用 SessionStore）
      break;

    case 'status':
      // SDK 进度/心跳状态，旁路（前端不需要）
      break;

    default:
      console.warn(`[run ${ctx.runId}] unknown system subtype:`, msg.subtype);
      break;
  }
}

function handleAssistantBlocks(ctx, content, skipTextThinking = false) {
  for (const block of content) {
    switch (block.type) {
      case 'text':
        // 流式开了 → text 已通过 stream_event 推完，跳过避免重复
        if (!skipTextThinking && block.text) {
          ctx.emit(Events.deltaText(ctx.counters.turns, block.text));
        }
        break;
      case 'thinking':
        if (!skipTextThinking && block.thinking) {
          ctx.emit(Events.deltaThinking(ctx.counters.turns, block.thinking));
        }
        break;
      case 'tool_use':
        // tool_use 不论流式与否都在 assistant 完成时推一次（SDK stream_event
        // 里 tool_use input 是 partial JSON delta，前端拼起来不划算）
        ctx.emit(Events.deltaToolUse(ctx.counters.turns, block.id, block.name, block.input));
        ctx.incrementTool(false);

        // Phase 1：TodoWrite 工具单独再 emit 一条 todoUpdated。
        // SDK 不会在 type:'system' 里专门推 TodoWrite 状态 —— agent 用工具
        // 写计划时，input.todos 就是完整的 [{ content, status, activeForm }] 列表
        // （sdk-tools.d.ts:530 TodoWriteInput）。
        // tool_use 只够前端展示"调了 TodoWrite"，但拿不到结构化的 todo 列表给
        // 计划面板用，所以这里平行 emit 一次 run.todo.updated。
        if (block.name === 'TodoWrite' && block.input && Array.isArray(block.input.todos)) {
          ctx.emit(Events.todoUpdated(block.input.todos));
        }
        break;
      // 其他 block 类型（redacted_thinking / image / document）忽略
    }
  }
}

/**
 * C24：处理 SDK stream_event message（含 BetaRawMessageStreamEvent）。
 * 推逐 token 增量给前端实现打字效果。
 *
 * BetaRawMessageStreamEvent.type 值：
 *   message_start / content_block_start / content_block_delta /
 *   content_block_stop / message_delta / message_stop
 *
 * 我们只关心 content_block_delta（含 text_delta / thinking_delta /
 * input_json_delta / signature_delta / citations_delta）。
 * input_json_delta 不处理（tool_use input 等完整 block 在 assistant message 里推）。
 */
function handleStreamEvent(ctx, msg) {
  const evt = msg.event;
  if (!evt) return;

  // tool_use 起点 —— content_block_start { content_block: { type: 'tool_use', id, name } }
  // 推 toolUseStarted 让前端立即显示 icon + tool name（status='running'）。
  // input 还没流完，等 assistant message 完成后 deltaToolUse 同 blockId update。
  // 体感：agent "想完→开干" 之间几乎没延迟，工具图标第一时间出现。
  if (evt.type === 'content_block_start') {
    const cb = evt.content_block;
    if (cb && cb.type === 'tool_use' && cb.id && cb.name) {
      ctx.emit(Events.toolUseStarted(ctx.counters.turns, cb.id, cb.name));
    }
    return;
  }

  if (evt.type !== 'content_block_delta') return;

  const delta = evt.delta;
  if (!delta) return;

  if (delta.type === 'text_delta' && delta.text) {
    ctx.emit(Events.deltaText(ctx.counters.turns, delta.text));
  } else if (delta.type === 'thinking_delta' && delta.thinking) {
    ctx.emit(Events.deltaThinking(ctx.counters.turns, delta.thinking));
  }
  // input_json_delta / signature_delta / citations_delta 暂不处理
}

function handleUserBlocks(ctx, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      const ok = !block.is_error;

      // C24：tool_result 的 content 可能是：
      //   - string（简单文本输出）
      //   - block[]（含 type:'text' / type:'image' 等多模态 content blocks）
      // P0 时把 image block JSON.stringify 序列化丢到文本里 → 前端显示
      // 一段难看的 base64 字符串。本提取分离：text 部分合并到 output，
      // image 部分单独传 images[] 数组让前端 <img src="data:..."> 渲染。
      let output = null;
      const images = [];

      if (typeof block.content === 'string') {
        output = block.content;
      } else if (Array.isArray(block.content)) {
        const textParts = [];
        for (const b of block.content) {
          if (b?.type === 'text' && b.text) {
            textParts.push(b.text);
          } else if (b?.type === 'image') {
            // 双格式兼容：
            //   - Anthropic content block: { type:'image', source:{ type:'base64', media_type, data } }
            //   - MCP CallToolResult ImageContent: { type:'image', data, mimeType }
            // SDK 透传 MCP CallToolResult 时格式不一定转换；只查 source.data 会漏接
            // generate_image 返的图，前端 chat 缩略图就空。
            const imgData = b.source?.data || b.data;
            const imgMime = b.source?.media_type || b.mimeType || 'image/png';
            if (imgData) {
              images.push({ mediaType: imgMime, data: imgData });
            } else {
              textParts.push(JSON.stringify(b));  // 拿不到 data 时留痕不丢数据
            }
          } else if (b) {
            // 未识别 block 类型 → fallback JSON.stringify 留痕（不丢数据）
            textParts.push(JSON.stringify(b));
          }
        }
        output = textParts.length > 0 ? textParts.join('\n') : null;
      }

      ctx.emit(Events.deltaToolResult(
        ctx.counters.turns,
        block.tool_use_id,
        '<sdk-tool>',                  // SDK 不在 tool_result 里带 name；前端可以从 tool_use 配对
        ok,
        ok ? output : undefined,
        ok ? undefined : { message: output || 'tool failed' },
        images.length > 0 ? images : undefined,
      ));
      if (!ok) ctx.counters.toolFailures += 1;
    }
  }
}

// ── 产物检测 ──

export async function detectArtifact(ctx) {
  for (const candidate of ARTIFACT_CANDIDATES) {
    if (await ctx.workspace.exists(candidate)) return candidate;
  }
  return null;
}
