# Handovers Archive

历史交接文档归档（时间倒序）。每节是一段重大推进的高密度提炼：commit hash / 关键文件 / 决策因果链 / 踩坑。流水账细节翻 git history。

当前状态见根目录 [`HANDOVER.md`](../../HANDOVER.md) + [`PLAN.md`](../../PLAN.md) "🟢 当前状态" 段。

---

## 2026-05-02 晚 · S0-S8：paradigm 5 阶段全接通 + Kimi vision fix

**16 commit**。两件事：paradigm 闭环接通 + Kimi vision tool_result 嵌套 image 真坑修了。

### 关键 commit

| Commit | 主题 |
|---|---|
| `8a9d474` S0 | 撤 CDN 白名单（hooks.js TRUSTED_CDN_HOSTS / SKILL.md 4 处 trusted 措辞）+ 加图片+音频源 cheatsheet |
| `7c3dfe7` S1 | HTML 标记轻量化：6 件套 → **3 必装**（page/anchor/node-id）+ 1 可选（layout 自由命名）；6 named layout cookbook 撤 |
| `393cb17` S2 | explorer 加 WebFetch HEAD hotlink 验证 + Content-Type 过滤 + audio/* + 推荐源（unsplash/pexels/pixabay-audio CC0）+ maxTurns 5→8 |
| `f52bf8e` S3a | SKILL.md § vision-checker 协议（70 行）：何时派 / 不派 + 3 prompt 模板 + ≤2 次/turn-cluster 防 self-criticism |
| `41100cd` S3b | events.js subagentStop +toolUseId / 前端 VisionCheckerCard（解析 VERDICT/ISSUES/OVERALL，染色 chip）|
| `066cf95` S4a | SKILL.md § "深度对齐 + 设计计划档"（80 行）：触发条件 + 4 步流程 + plan-doc 模板（port 0.7.7：core metaphor + 拒掉的默认 + 4-stage chain + per-page 反默认决策三段式 + sealed-test）|
| `16ba8e0` S4b-1 | vision-checker.md 加 Tier 0 plan compliance（最高优先级 when plan exists）+ Tier 1 sealed-test |
| `f9ec3cd` S4b-2 | events.js planDocReady / hooks.js PostToolUse(Write design-plan.md) handler / canvas.js GET /plan endpoint |
| `f77aadb` S4b-3 | DesignPlanModal（react-markdown）/ globalStore designPlanOpen / Message.jsx Write design-plan.md → "📄 查看设计计划" 按钮 |
| `b2fb16f` S5 | hooks.js focus_page 重命名 + 去孤编号 |
| `114d809` S6 | **撤节流措辞**：默认 1-3 轮 ask + 每轮 2-4 题 + agent 自判停；escape hatch 仅"别问/赶时间/单参数指令清晰"；SKILL.md 5 处节流措辞撤 |
| `dcf560f` S7 | Subagent icon 分类（explorer→Compass / vision-checker→ScanEye / ds-extractor→Palette / tweak-proposer→Sliders）；ContextUsageBar fallback "📊 等待 context 数据"；移到 ChatPanel header 下方 |
| `92a4728` S8.1 | binary-fixup-proxy 加 `NODESIGN_DEBUG_VISION=1` 诊断日志（image block 位置 + schema sample）|
| `b201bfa` S8.2 | **核心 fix**：`liftImagesFromToolResult` — tool_result.content 里的 image lift 到 user message 顶层（仅 kimi-* model 生效） |

### Kimi vision 真坑（长期记忆）

**症状**：SDK Read 图片 Kimi 看不到；mcp__nodesign__screenshot_canvas 完美工作。

**诊断链**：proxy 加 image scanner → curl Kimi 顶层 image 准确识别 → curl 嵌 tool_result.content 的 image → Kimi hallucinate → curl lift 到顶层 → 完美识别。

**根因**：Kimi K2.6 / 网关 vision pipeline **不识别 tool_result.content 嵌套里的 image block**，只识别 user message 顶层 image content block。

**修复**：[server/lib/binary-fixup-proxy.js](../../server/lib/binary-fixup-proxy.js) `liftImagesFromToolResult` — 扫 outgoing /v1/messages，把 user message 里 tool_result.content 的 image lift 到该 user message content 顶层，原位置替换占位文本。仅 `if (/^kimi/i.test(model))` 进入。

⚠️ 未来切别 model 别推广 — 其他 model 可能要求 image 留 tool_result 内才能 attribute。

### Paradigm 5 阶段接通度（S0-S8 后）

| 阶段 | 状态 |
|---|---|
| **ask** | ✅ + 默认 1-3 轮 + agent 自判停 |
| **plan** | ✅ design-plan.md 流（agent Write + run.plan_doc_ready + 前端 modal）|
| **explore** | ✅ + hotlink 验证 + audio + 推荐源 cheatsheet |
| **generate** | ✅ + HTML 标记轻量化 + Kimi vision 通 |
| **vision-check** | ✅ SKILL.md 教 + 前端 critique 卡 + Tier 0 plan compliance |

### 关键文件

- `server/lib/binary-fixup-proxy.js` — lift transform + vision 诊断日志
- `server/engine/agent/events.js` — subagentStop +toolUseId / planDocReady
- `server/engine/agent/hooks.js` — PostToolUse(Write design-plan.md)
- `server/engine/agents/{explorer,vision-checker}.md` — 协议升级
- `server/engine/skills/deskskill-engine-mini/SKILL.md` — 主战场（深度对齐 / vision-checker 协议 / design-plan 流程 / 撤节流 / HTML 标记轻量化）
- `server/api/canvas.js` — GET /plan
- `web/src/components/project/DesignPlanModal.jsx` — 新组件
- `web/src/components/chat/Message.jsx` — VisionCheckerCard / subagent icon 分类

### env

- `NODESIGN_TAVILY_KEY` / `NODESIGN_EXA_KEY`（dev key 不 commit）
- `NODESIGN_DEBUG_VISION=1`（诊断用，prod 关）

### 不要做

- ❌ 简单 brief 跳 ask（撤节流后默认仍要问 1 题对齐方向）
- ❌ 把 lift transform 推广到非 kimi-* model
- ❌ 重启 server 用 `pkill` pattern（共享机风险）

---

## 2026-05-02 傍晚 · A4-A6 + C1-C6：agent paradigm 落地 + Canvas v0.6 对齐

**21 commit**。Canvas v0.6 完整能力 + paradigm 框架成型。详见 [Canvas.md](../../Canvas.md) 510 行。

### 关键 commit

| Commit | 主题 |
|---|---|
| `31e11cc` A1.1 | **explorer subagent + 修 Task 工具白名单 bug** — Task 不在 DEFAULT_TOOL_ALLOWLIST → 此前所有 subagent 形同摆设 |
| `cd8efcd` A2.1 | 后端 loop.js 每个 assistant message 后 `query.getContextUsage()` fire-and-forget emit `run.context_usage` |
| `cf6795d` A2.2a | ContextUsageBar 升级 liveUsage prop：进度条 + 百分比 + breakdown tooltip + autoCompact 阈值竖线 |
| `4377a59` A2.2b | 前端接 run.context_usage / compact_boundary toast / >=90% 阈值预警 toast |
| `062df88` A3.1 | **session 加 `assets/` 软链 → `../../shared/assets/`** — 修 H3 重构后路径漂移：prelude 教 `./assets/` 但实际 `../../shared/assets/`，agent Glob 永远 0 结果 |
| `4a4e262` A4.1+2 | **AskUserQuestion 走 SDK canUseTool**：根因是 cli.js `shouldDefer:true + requiresUserInteraction:true`，SDK 期待 host 提供 input.answers。后端 canUseTool 拦 + emit run.ask_user_question + await Promise；active-runs.js 加 pendingQuestions Map；turn.js POST /answer endpoint |
| `08bee85` A4.3 | 前端 AskUserQuestionView 改走 Turn.answer；prelude 加完整教学 |
| `91e7e68` A4.4 | wizard 重写：一次 1 题（之前 N 题平铺）+ collected state + [← 上一题/跳过/下一题 →] + 末题 [✓ 提交全部] |
| `4a4e262`+ A4.5 | AskUserQuestion 卡片接时间轴 icon HelpCircle |
| `0e67da9` A4.6 | thinking 流式超 1000 字自动收起到 500 字 |
| `51681e6` A4.7 | **去 isShortNarration 启发式**：任何 assistant text 都 break group → DONE 出现（修 Kimi 交错模式真实内容被当过场的 bug）|
| `cbc9043` A5.1 | SKILL.md 加 read_page + expose_tweaks 工具表 + data-node-id 教学 |
| `6c79fdc` A6.1 | **SKILL.md 大重写**：dedupe + HTML 5-style-block head / 6 named layouts / 6 件套 data-* / scoped tweak vars + 中文字体 4 项 CDN（思源黑/宋/霞鹜文楷/HarmonyOS Sans）|
| `e8ca5f3` A6.2 | **expose_tweaks 加 target_scope** — backend zod schema + 前端 TweaksPanel resolveScopeEl + applyToIframe / Reset / Apply chat 全部 scope-aware |
| `6ca83dc` C1 | 8 个新 MCP 工具（list_pages / read_page / query_elements / get_computed_styles / navigate_to_page / highlight / expose_tweaks / get-clear_pending_changes）|
| `52c6744` C2 | System popover 收口（吞掉 Decisions 浮窗）|
| `3cfe6e0` C3 | Inspect 改 contextual 浮卡（贴选中元素，不再 floating panel）|
| `914e780` C4 | 用户直接编辑 + 评论 buffer，agent 主动拉 |
| `58f1aba` C5 | Tweaks schema 驱动（5 种控件类型）|
| `a48e53b` C6 | 反向通道前端消费（navigate_to_page / highlight）|

### 关键文件

- `server/engine/agent/loop.js` — runAgent 总入口；canUseTool（A4.1）；context usage emit（A2.1）；Task 在 toolAllowlist（A1.1）
- `server/engine/agent/prompts/nodesign-prelude.md` — AskUserQuestion 教学（A4.3）；子代理段（A1.1）
- `server/engine/runs/active-runs.js` — pendingQuestions Map + registerPendingQuestion / provideAnswer
- `server/engine/skills/deskskill-engine-mini/SKILL.md` — HTML 5-style-block + 6 layouts + 6 件套 data-* + scoped tweak（A6.1）；C4 直接编辑协议；C5 Tweaks 暴露协议含 target_scope
- `server/engine/agents/explorer.md` — 研究员 prompt（A1.1）
- `server/engine/mcp/tools/expose-tweaks.js` — ControlSchema 含 target_scope（A6.2）
- `server/projects/workspace.js` — ensureSessionWorkspace 加 assets symlink（A3.1）
- `server/api/turn.js` — POST /turn + /cancel + /answer
- `web/src/components/chat/Message.jsx` — AskUserQuestionView wizard / ThinkingMessage 1000 字自动收起
- `web/src/components/chat/MessageList.jsx` — assistant 全 break group
- `web/src/components/project/ContextUsageBar.jsx` — 实时进度条 + breakdown
- `web/src/components/context-panel/TweaksPanel.jsx` — scope-aware applyToIframe
- `web/src/components/canvas/InspectFloatingCard.jsx` / `SystemPopover.jsx` — C2/C3
- `web/src/lib/api.js` — Turn.answer + PendingChanges API
- `web/src/stores/globalStore.js` — activeRun: { pid, runId }

### 不要做（用户已 push back）

- ❌ 字体配对库 / 调色板库 / 布局模板库 / 风格 preset 库 / 反例库（"喂 agent" 思路）— K2.6 万亿参数知道这些。详见 memory `feedback_agent_not_junior.md`
- ❌ 拆多文件 HTML / 改 React component / 改 reveal.js framework — 单文件仍最优。详见 memory `nodesign_canvas_v06_html_standard.md`

---

## 2026-05-01 下半场 · P2 thinking proxy + UI 精修

**17 commit**。Kimi thinking 通了 + 上下文不爆 + Timeline UI 跟 Claude Code native 对齐。

### 关键 commit

| Commit | 主题 |
|---|---|
| `28c48f9` | probe 留档：T1-T6 直连测试 + binary intercept proxy 诊断证据 |
| `069e595` | **binary-fixup-proxy** — server 进程内 mini HTTP proxy，binary 出口拦 `/v1/messages` POST 把 `thinking.type adaptive→enabled` |
| `a7d20e4` | thinking config 按 model id 自动选 type（Opus 4.6/4.7→adaptive，其他→enabled+budgetTokens 8192）|
| `fa21c33` | settings.json 全局生效 + autoCompactEnabled/Window；`DEFAULT_NODESIGN_SETTINGS` 代码 = source of truth；每次 ensureProjectWorkspace merge defaults；autoCompactWindow=230000（Kimi 256k 留 10% 阈值）|
| `1255383` | **PostToolUse Edit\|Write trim originalFile** — `FileEditOutput.originalFile` 默认含完整原文件（25KB canvas.html ≈ 6k tokens / Edit），30 turn 累积 180k+ 触发 256k 上限。hook 用 `updatedToolOutput` 把 originalFile=null，保留 structuredPatch + filePath。**只影响 model 视图，jsonl 持久化不动** |
| `08df134` | **web_search MCP tool**（4 provider 0 依赖）：baidu/tavily/exa/zhipu，按 query 语言自动路由（CJK→baidu，英文→tavily），移植自 `~/.deskclaw/skills/deskclaw-search-pro` |
| `8892a3e` | **WebFetch 用 SDK 内置**（白名单加 DEFAULT_TOOL_ALLOWLIST）|
| `3812cf0` | hooks.js 移除 record_decision 冗余 additionalContext |
| `3bceb76` | timeline group 标题从第一段 thinking 自动提取（纯字符串截取）|
| `583745e` | 修 timeline 线段溢出（DONE icon 之下 + 第一节点之上不再多线，TimelineGroupContext 传 position）|
| `f4ce82c` | group title 缩小克制（13px / weight 500 / 中灰 / 无底色 / chevron 14px，参 Claude Code）|
| `a2cbf56` | **工具 icon 实时显示** — handleStreamEvent 加 content_block_start handling，emit run.tool_use.started；前端 upsert 模式 |
| `5a6a2d4` | 删 ThinkingMessage "▼ THINKING" inner label（Clock icon 已传递语义）|

### Kimi thinking 根因

SDK binary 对**非白名单 model id** 一律 fallback `thinking.type=adaptive`，但 Kimi gateway 不支持 adaptive。详见 memory `feedback_kimi_thinking_blocks.md`。修复用 binary-fixup-proxy 拦改。

### 关键架构

**Server 进程内嵌 proxy**：`server/lib/binary-fixup-proxy.js` 懒启动 HTTP server `127.0.0.1:动态端口`，转发到真实 `NODESIGN_GATEWAY_URL`。loop.js → getOrStartProxy → SDK options.env.ANTHROPIC_BASE_URL = proxy baseUrl → binary spawn 子进程发 HTTP 到 proxy → proxy 拦 /v1/messages POST 改 body.thinking 后转发真 gateway。

**settings.json merge 不再 if-not-exists**：`server/projects/workspace.js` 每次 mergeSettingsDefaults，merge 顺序 `defaults < existing`。

**PostToolUse hook 改 tool_result**：`hooks.js` Edit|Write matcher 用 `updatedToolOutput` 改写 tool_response（删 originalFile）。SDK [hookSpecificOutput.updatedToolOutput] 能力，**不影响 jsonl 持久化**。

### web_search vs WebFetch（不要混淆）

- `mcp__nodesign__web_search` — 自实现，4 provider，纯 fetch + JSON
- `WebFetch` — SDK binary 内置，input `{ url, prompt }`，binary 取 URL 后用配的 model 跑 prompt 总结

### env

- `.env` 加 `NODESIGN_BAIDU_QIANFAN_KEY=bce-v3/...`（移植 deskclaw skill）

### 关键文件

- `server/lib/binary-fixup-proxy.js` — **新**，thinking 修复核心
- `server/projects/workspace.js` — settings.json merge
- `server/engine/agent/loop.js` — model 解析 + thinking config + ANTHROPIC_BASE_URL → proxy + content_block_start
- `server/engine/agent/hooks.js` — Edit|Write trim
- `server/engine/mcp/tools/web-search.js` — **新**，4 provider
- `web/src/components/chat/{MessageList,TimelineGroup,TimelineNode,Message}.jsx` — timeline 精修
- `web/src/components/chat/TimelineGroupContext.js` — **新**，传 position 给 TimelineNode
- `server/_probe-{kimi,binary-thinking}.js` — 诊断 probe

---

## 2026-05-01 上半场 · S1-S4 + H1-H5：session-scoped workspace 重构

**11 commit**。从"项目级共享 canvas"重构成 Anthropic Projects 模式（Project = workspace dir + .claude/；Session = 独立沙盒）。

### 关键 commit

| Commit | 主题 |
|---|---|
| `a871696` S1 | per-project workspace + SDK 自持久化：persistSession=true / settingSources=['project'] / `<workspace>/.claude/CLAUDE.md`+settings.json 模板 / projects.description 列 / 老 active_session_id 一次性清洗 / per-project CLAUDE_CONFIG_DIR via Options.env |
| `11e0f7e` S2 | sessions API 走 SDK：GET /sessions（listSessions 薄壳）/ GET /sessions/:sid / **withConfigDir mutex** 串行化 process.env 切换 / sessionMessagesToDisplay helper |
| `a87c6ba` S3 | description UI + ContextPanel 项目背景 tab 编辑 .claude/CLAUDE.md / GET/PUT instruction endpoint |
| `a47f7ac` S4 | SessionListModal + fork/PATCH/DELETE endpoint + ChatPanel header session selector + Turn.send 加 sessionId 参数（null=新建/string=续约）|
| `beb1d0a` H1 | routing 重构：`/projects/:id` → ProjectHub / `/work` + `/sessions/:sid` → ProjectWorkspace（原 Project.jsx 重命名）/ URL 驱动 sid（删 currentSessionId state）/ run.done 后 navigate replace 真 sid |
| `84071e9` H2 | Hub 两栏布局（左 1fr + 右 340px sticky 三 cards）|
| `afe63cc` H3 | **session-scoped workspace 核心改造**：shared/ + sessions/<sid>/ / 5 个软链共享 shared/.claude/{CLAUDE.md, settings.json, skills, agents, agent-memory} / cwd=sessions/<sid>/ + CLAUDE_CONFIG_DIR per-session / additionalDirectories=[shared] / canvas/spec/exports API 全加 sid / forkSessionWorkspace cp -r 含 .git history |
| `8c31cff` H4a | Workspace auto-send（location.state.initialMessage → setTimeout 250ms）+ initialMessageSentRef 防双发 / ContextPanel 删 background+inputs tab，默认 inspect |
| `19b9873` H4b | Hub 三 cards 真接：Instructions/Files/Memory cards + GET/PUT /memory（per agentType）|
| `90720f6` H5 | timeline groupMessages 重写（assistant 中间 text 进 group + isStreaming 决定 closed + final text 抽出）/ ThinkingMessage > 320 字符折叠 / loop.js thinking adaptive→enabled budgetTokens 8192 |

### Workspace 结构（H3 后）

```
<projects-data>/<projectId>/
├── shared/                          ← project 共享（agent 看，跨 session）
│   ├── .claude/{CLAUDE.md, settings.json, skills, agents, agent-memory/<type>/}
│   ├── assets/
│   └── .gitignore
└── sessions/<sid>/                  ← 每 session 独立沙盒
    ├── canvas.html, spec.json
    ├── .claude/
    │   ├── {CLAUDE.md, settings.json, skills, agents, agent-memory} → softlink → ../../../shared/.claude/...
    │   └── projects/<encoded-cwd>/<sid>.jsonl  ← SDK 转录
    └── .git/                        ← per-session history
```

### SDK options 关键 fields

```js
{
  cwd: sessionWorkspaceRoot,
  env: {
    CLAUDE_CONFIG_DIR: process.env.NODESIGN_CONFIG_DIR
                       || path.join(sessionWorkspaceRoot, '.claude'),
  },
  additionalDirectories: [sharedRoot],
  sessionId: <pre-generated-uuid>,    // 新建；续约不传
  resume: <sid>,                      // 续约；新建不传
  persistSession: true,
  settingSources: ['project'],
  thinking: { type: 'enabled', budgetTokens: 8192 },
  sandbox: { filesystem: { allowWrite: [sessionWorkspaceRoot, agent-memory] } }
}
```

### 路由

```
/projects/:id                  ProjectHub   ← 二级控制台
/projects/:id/work             ProjectWorkspace（无 sid，新会话）
/projects/:id/sessions/:sid    ProjectWorkspace（带 sid，恢复）
```

URL = sid 唯一 source of truth。run.done 时 /work → navigate replace `/sessions/<sid>`。

### 用户决策（落库）

| 决策 | 选项 |
|---|---|
| cwd 策略 | per-session（真物理隔离）|
| 老项目 canvas/spec/.git 迁移 | 删了（removeRootLegacyArtifacts）|
| forkSession 复制产物 | 是（cp -r 含 .git）|
| URL 形态 | `/work` + `/sessions/:sid` 两套 |
| description | 选填 |
| Cowork 链接 | 砍 |

### 心智模型陷阱

- **cwd vs CLAUDE_CONFIG_DIR**：cwd = agent 工作目录（Read/Write 默认相对路径基准）；CLAUDE_CONFIG_DIR = SDK 写 JSONL / 读 settings 的 base。SDK JSONL 路径 = `<CLAUDE_CONFIG_DIR>/projects/<encoded(cwd)>/<sid>.jsonl`，encoded = `cwd.replace(/[^a-zA-Z0-9]/g, '-')`
- **listSessions dir 不扫子树** — sessions.js list endpoint 自实现：readdir sessions/ 后 per-sid getSessionInfo
- **forkSession 把新 jsonl 写到 src cwd** — 调 SDK forkSession({ dir: srcSessionRoot }) 时 SDK 把新 sid jsonl 写到 srcSessionRoot 下，需要手动 mv 到新 session encoded-cwd 子目录
- **sid 由谁生成** — 新会话服务端 `crypto.randomUUID()` 预生成传 SDK options.sessionId（d.ts:1537）；续约用前端传的 sid 走 SDK options.resume

### 关键文件

- `server/projects/workspace.js`（重写）— getProjectWorkspace / getSharedDir / getSessionWorkspace / ensureProjectWorkspace / ensureSessionWorkspace / forkSessionWorkspace / commitWorkspace / removeRootLegacyArtifacts
- `server/lib/sdk-session.js`（S2）— `withConfigDir(configDir, fn)` async-mutex-lite
- `web/src/routes/{ProjectHub,ProjectWorkspace}.jsx` — 二/三级页
- `web/src/components/project/{InstructionsCard,FilesCard,MemoryCard,SessionListModal}.jsx`
- `web/src/lib/session-to-messages.js` — SDK SessionMessage[] → 前端 messages

---

## 2026-05-01 早上 · agent 层 Phase 1+2+3：SDK 用法精度对齐

**8 commit**。把 SDK 已经付费但没用透 / 自己手撸了 SDK 已能做的事系统化解决。

### 关键 commit

| Commit | Phase | 主题 |
|---|---|---|
| `bbf271a` | 1 | 基础设施 — query handle 暴露 + 事件翻译补全 |
| `b2db717` | 2 | hooks 4/29 → 10/29，SDK hook 系统真用起来 |
| `e8a05f4` | 2 fix | 去掉 PostToolUse 三个 handler 的 double emit |
| `a59b0b7` | 3a | SDK options 三连 — forwardSubagentText + maxBudgetUsd |
| `77f6541` | 3b | SKILL.md 精简 215→93 行（v0.2.1 → v0.3.0）|
| `24c701e` | 3a/3b fix | maxBudgetUsd clamp + SKILL.md 加回 Edit > Write |
| `426559f` | 3c | cancelRun 切 query.interrupt() + 修 Phase 1 abort 路径 bug |
| `42062d8` | 3d | SDK 内置 sandbox 替换 PreToolUse Bash 白名单 |
| `149770b` | 3d fix | sandbox denyRead 加回 ~/.ssh / ~/.aws / ~/.gnupg（os.homedir 展开）|

### 关键架构

**active-runs registry 升级**：存的不再只是 abortController：`{ abortController, query, ctx, startedAt }`。`query` 字段 attachQuery 后可调 `query.interrupt() / setModel() / rewindFiles() / getContextUsage() / mcpServerStatus() / streamInput()` 全 control 方法。

**prompt 路径统一 streaming**：`buildUserMessageStream` 接受 string|content blocks 都包成 AsyncIterable — 因为 SDK control 方法**只在 streaming input/output 模式下可用**（sdk.d.ts:2018-2022）。

**ctx.cancel() 幂等**：`context.js` 加 `_cancelled` flag，三条 cancel 路径只触发一次：race window / interrupt 成功 / 5s 兜底。

**hooks 4/29 → 10/29**：FileChanged ✅ / ~~PreToolUse(Bash)~~（3d 改 SDK sandbox）/ Stop / PostCompact / **UserPromptSubmit**（自动注入 spec.json 摘要 + canvas 页数）/ **SessionStart**（emit run.session_start 区分 startup/resume/clear/compact）/ **PostToolUse(matcher×3)**（screenshot 后注 / export 后注 / record_decision 后注）/ **PostToolUseFailure** / **SubagentStart/Stop**

**SDK 内置 sandbox 替换白名单**（3d）：`sdkOptions.sandbox` 替 PreToolUse 命令级正则白名单。`enabled: true / failIfUnavailable: true`；`filesystem.allowWrite: [wsRoot]`；`denyRead: ['/etc/passwd', '/etc/shadow', '/etc/sudoers']`；`network.allowLocalBinding: false`。⚠️ **未真测**：sandbox 是否拦 Bash spawn 出去的命令级危险（`curl/wget/sudo`）。回滚预案：`git revert 42062d8` 的 hooks.js 部分恢复白名单。详见 memory `feedback_sandbox_replaces_whitelist.md`。

**SKILL.md 精简 215→93 行**：删工具用法表 / "TodoWrite 列计划" / "turn 开头 Read spec.json" / 子代理调用引导 / 错误处理（hook 已注入）。保留：工作台路径 / 业务工具时机 / 视觉风格 / HTML 规范 / 不要做的事。

**SDK options 增补**：`forwardSubagentText: true`（子代理 thinking/text 转发主流）；`maxBudgetUsd: clamped(env, 1)`（IIFE 防 env typo，负数/0/NaN fallback $1）。

### SDK 用法精度对齐表

| 决策 | 选择 | 理由 |
|---|---|---|
| prompt 路径 | 统一 AsyncIterable | control 方法只在 streaming 可用 |
| query handle | attachQuery 暴露 | 上层 endpoint 能用 control |
| cancelRun 路径 | interrupt 优先 + 5s 兜底 | 优雅中断 |
| ctx.cancel() | 幂等 | 防三条路径双 emit |
| terminal_reason 'aborted_*' | 走 cancelled 路径 | 不被当 success |
| sandbox | OS 级隔离替正则白名单 | SDK 原生 |
| outputFormat | **跳过** | 强制 main agent JSON 违反自然对话 |
| forwardSubagentText | 开 | 子代理可观测性零成本 |
| maxBudgetUsd | env-driven 默认 $1 | 防失控 |
| additionalDirectories | **跳过** | 无硬场景 |
| onElicitation / forkSession | **暂不接** | 无硬场景 |

---

## 2026-04-30 下午 · P0+ stage 1 + Phase H：全量切换 SDK 现成能力 + 前端可视化

**32 commit**。吃完 SDK 5524 行 d.ts 后发现手撸了一批 SDK 已提供能力（git checkpoint / multimodal user message / iframe reload bust / Bash 沙盒），并且没用上 SDK 大量上层能力（hooks / MCP / agents / outputFormat / progress summaries / prompt suggestions / context usage / canUseTool）。

### 关键决策（用户拍版）

1. Checkpoint 双轨：session 内 SDK rewindFiles + 跨 session git。git 不删
2. User msg 切流式：`prompt: AsyncIterable<SDKUserMessage>` + content blocks。附件按文本路径 + Read（不 base64 内联）
3. Hooks 4 件套：FileChanged / Stop / PreToolUse(Bash) / PostCompact（**修正 plan PreCompact → PostCompact**，因 PreCompact 没 compact_summary 字段）
4. MCP 工具集：screenshot_canvas / export_handoff / record_decision
5. agents 子代理：vision-checker / ds-extractor / tweak-proposer 三个骨架（stage 1 不主动调）
6. **outputFormat: json_schema 子代理级别不支持**（C15 实测发现 SDK AgentDefinition 没 outputFormat 字段）→ 子代理走 prompt 内嵌 schema + main agent JSON.parse
7. 零风险默认带：agentProgressSummaries / promptSuggestions / canUseTool 占位 / getContextUsage

### Stage 1（C1-C22，22 commit）

**Phase A 后端基础**（C1-C2）：loop.js 加 4 SDK options + events.js 翻译 28+ message 类型 / prompt 切 AsyncIterable<SDKUserMessage>

**Phase B Hooks 4 件套**（C3-C7）：
- FileChanged → EventBus emit `run.file_changed` → Project.jsx 自动 reload iframe
- PreToolUse(Bash) → 30 个白名单 token + 12 条危险正则
- Stop → 占位 emit run.stop_reflection
- PostCompact → spec.json.history 沉淀长期记忆

**Phase C MCP 工具集**（C8-C11）：createSdkMcpServer + Zod schema / screenshot_canvas（playwright headless → image content block）/ export_handoff（buildHandoffZip 抽公共）/ record_decision（写 spec.json.decisions[]）

**Phase D file checkpoint 双轨**（C12）：POST /canvas/undo 简版（git checkout HEAD~1）+ UndoButton

**Phase E agents 子代理定义**（C13-C16）：3 个 AgentDefinition + design-system.json + tweak-schema.json

**Phase F 前端配套**（C17-C20）：handleEvent 加 11 种新事件 case + 4 个新 state / ContextUsageBar 顶栏 chip / SuggestionChip / ChatPanel header 显示 subagent 30s 进度摘要

### Phase H 前端可视化补完（C23-C32，10 commit）

stage 1 ship 后用户反馈"agent 在做什么前端要完整可见"+ "暴露思维链"+ "AskUserQuestion 没渲染" + "自由 / 参照模式过时" + "工作区可视化"：

- C23 Message tool 强化（工具图标 / 智能 input 摘要 / elapsed 计时 / 折叠 INPUT/OUTPUT/ERROR）
- C24 流式打字（stream_event → 逐 token）+ tool_result image content block 渲染
- C25 'system' role + SystemMessage（bash_blocked / 4 variant）
- C26 Thinking 默认展开 + 视觉区分（左条 + 等宽小字）
- C27 AskUserQuestion 进白名单 + 卡片渲染
- C28 subagent 调用 chat 可视化（task_* events 加 toolUseId / Task → agentType / 30s 摘要 chip）
- C29 Decisions tab + GET /api/projects/:pid/spec endpoint
- C30 移除 "自由创作 vs 参照模式"
- C31 已生成的交付包列表 + 单文件下载（workspace/exports/）
- C32 iframe reload 保留滚动位置

### sdkOptions 7 个必设字段

| 字段 | 值 | 为什么 |
|---|---|---|
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code', append: skill.systemPrompt }` | 继承 SDK 默认约束（何时停 / be concise / task completion）；SKILL.md 仅 append。**string 模式让 agent 失去这些约束 → 一个 turn 做 30 件事停不下来** |
| `permissionMode` | `'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | 跳过 binary stdio prompt；危险拦截走 PreToolUse hook。**默认 'default' 让 binary 等 stdin → spawn 没接 stdin → hang（"ask 不 pending"真根因）** |
| `enableFileCheckpointing` | `true` | session 内 rewindFiles 能用 |
| `agentProgressSummaries` | `true` | subagent 30s 摘要事件，piggyback prompt cache 几乎免费 |
| `promptSuggestions` | `true` | 每轮预测下条 prompt |
| `includePartialMessages` | `true` | stream_event → 流式打字 |
| `maxTurns` | 15 | 50 太宽（agent 反复优化）；15 够写完 canvas + 1-2 次自检 |

### 已撞过的坑（不要重蹈）

- ❌ `systemPrompt: skill.systemPrompt`（string 完全覆盖）→ 失去 SDK 默认约束
- ❌ 默认 permissionMode + spawn 没接 stdin → AskUserQuestion / 危险操作 prompt 卡死
- ❌ `canUseTool always-allow` 不能 override binary stdio prompt（要 permissionMode）
- ❌ 自撸 git commit/revert/history endpoint（SDK 有 enableFileCheckpointing + rewindFiles）
- ❌ brief 字符串拼附件路径（用 content blocks）
- ❌ iframe reloadToken 手动 bump（用 FileChanged hook）
- ❌ "自由创作 vs 参照模式"等 mode 框定（agent 自决）
- ❌ 自定义 ask 工具（SDK 内置 AskUserQuestion）

### 关键 SDK 用法笔记

- `prompt: AsyncIterable<SDKUserMessage>` → 单次 yield + 自然结束 → SDK 进 agent loop。多轮 streamInput 复用要 generator 不结束 + 外部 push 队列
- `enableFileCheckpointing: true` → SDK 在每个 user message 处快照文件，`Query.rewindFiles(userMessageId)` 回滚。**per-query**，跨 session 失效，必须双轨 + git
- `agents` 接 `Record<string, AgentDefinition>`。**没有 outputFormat 字段** — 子代理强制 JSON 输出走 prompt 内嵌 schema
- `mcpServers: { name: createSdkMcpServer({ tools: [...] }) }` → in-process MCP server。tools 用 `tool(name, desc, zodRawShape, handler)`。agent 端工具名 `mcp__<server>__<tool>`
- `hooks: { [HookEvent]: HookCallbackMatcher[] }` → 每个 event 一组 hook。matcher 字段（如 'Bash'）让 SDK 只匹配工具调用时触发
- `canUseTool: (toolName, input, ctx) => { behavior: 'allow' | 'deny' }` → 自定义权限处理器
- SDK **28+ 种 message type/subtype**（events.js 头部完整列表）。从 sdk.d.ts:2988 SDKMessage union 起读
- SDKResultMessage 的 `subtype: 'success'` 才有 `result` 字段；`error_*` 子类型有 `errors[]`

### 沙盒 / 工作区虚拟容器（stage 2 计划）

单 container 占用估算：镜像 ~600 MB / idle 内存 ~250-350 MB / 活跃 ~500-800 MB / chromium screenshot ~200-400 MB / 冷启动 1-3s。

10 active = ~5-8 GB / 10 cores；100 active = ~50-80 GB / 100 cores。

**实施路径**：SDK 留了 `Options.spawnClaudeCodeProcess` 钩子。stage 1 现状用 cwd 隔离 + Bash 白名单；stage 2 公测时换 Docker。

---

## 2026-04-30 早上 · P0 重做 · 主线 5 流（A/B/C/E/I）

**11 commit**。从地基重做"P0 主线 5 流"，每段停下让用户 review。reset 回 deec72d 后整晚 yolo 8 commit 移到 `yolo-night-2026-04-29` 分支。

### 关键 commit

```
9e27924  fix: vite proxy 加 /ws 路径 — agent 事件流终于能流到前端 ★ 关键 hotfix
6178437  P0 C9: 流 I 导出 — HTML / PDF / Handoff
853cc79  P0 C8: 流 B 引用上下文 — 附件托盘 + 上传走 turn
16722da  P0 C7: 流 E direct edit — outerHTML PUT /canvas + git commit
0026aca  P0 C6: 流 A/C 跑通 — Project.jsx + Home + CreateProjectModal 真接
d5fc205  P0 C5: 前端基础设施 — api.js / ws-client.js / projectStore 真接
e1d5c25  P0 C4: 用户主动导出 endpoints
822bfb9  P0 C3: 业务 endpoints 全套 — projects / canvas / skills / assets / turn
ec68120  P0 C2: Express 4001 入口 + WS broker + 默认 skill
f489a3d  P0 C1: 后端 scaffold — projects workspace + agent loop 接 workspaceRoot
```

### ★ 关键 hotfix（9e27924）— vite proxy /ws 路径

**症状**：用户点 chat send 后看不到任何 agent 流式回复。

**根因**：`web/vite.config.js` proxy 只配了 `/api`：`ws: true` 在 `/api` 下只覆盖 `/api/*` 的 WebSocket 升级。WS 升级路径 `/ws/projects/:pid` 不在 `/api` 下 → vite 不转发 → 前端连 `ws://localhost:5174/ws/projects/:pid` 立即被 vite 关掉。

**修复**：vite.config 加单独的 `/ws` proxy entry，`target: ws://localhost:4001`。

**教训**：Backend + Frontend 联调，必须真发一条 turn 看前端能否收到事件，不能只靠 endpoint 200 / 编译通过。

### 5 流 × 主线

| 流 | P0 交付 | commit |
|---|---|---|
| A 自由创作 | brief → POST /turn → agent 写 canvas.html → iframe | C1+C2+C3+C5+C6 |
| B 引用上下文 | 附件托盘 → 上传 → POST /turn 带 attachments | C3+C8 |
| C chat 全局重规划 | 复用 POST /turn | C6 |
| E direct edit | iframe 双击 → blur → outerHTML → PUT /canvas + git commit | C3+C7 |
| I 导出 | 顶栏 ExportMenu → GET /exports/{html,pdf,handoff} | C4+C9 |

D / F / H 三流（inline comment / custom slider / DS 抽取）**不在 P0 范围**。

### 5 条产品/架构原则（写进 SKILL.md）

1. Agent 解析 → 思考 → 对齐 → 动手不揣测，模糊一律提问
2. 多 modality 信号 = chat 消息附件：不各自触发 agent
3. 意图明确则收敛，模糊则建议变体
4. export 双入口：用户按钮 + agent 工具
5. Agent 写完 HTML 倾向截图自检（P0+ 启用，需 vision input）

### 已知风险点

1. **outerHTML 序列化丢内容**：C7 加了 `el.contentEditable='false'` 强制 commit DOM 防御
2. **playwright PDF 启动延迟**：每次 spawn ~1-2s。P0 接受
3. **vite.config 改动需要重启 vite** — HMR 不重载 proxy 配置
4. **tool_result 没带 name** — SDK 在 user message 里返回的 tool_result block 不带 name 字段，loop.js handleUserBlocks 硬编码 '<sdk-tool>'。前端通过 blockId 跟 tool_use 配对找到 name

---

## 历史档案合集摘要（Pre-2026-04-30）

P1（2026-04-29 commit `c7ddf23`）— 14/14 验证项过；前端骨架建完；视觉实验插曲撤回（整体 floating card 三栏）。

P2（2026-04-29 commit `abf20f9`）— A 级核心闭环（Project CRUD + ExportMenu）+ B 级 Inspect 三动作（DirectEditModal / chatDraft / patches state / CommentsTab / EditOverlay）+ C 级次要页面。

P2.5（2026-04-29 commit `6479177`）— 对照 Claude_design.md 1591 行做 gap 审计，补 7 项核心交互：Slide Navigator / A11y Review Popover / Multi-candidate Compare / Snapshot 机制 / Engineering Handoff Bundle / GitHub Repo Connection / Structured Prompt Fields。

P3 第一阶段（2026-04-29 commit `4381663`）— **战略转向**：弃自写 agent-loop，包 Claude Agent SDK 的 `query()`。SDK 实际是 Claude Code 子进程的程序化包装。tokendance gateway URL `https://tokendance.space/gateway`。Live E2E ✅：8 turns / 7 工具调用 / cache read 43k tokens / $0.103 / 5 页 deck。

详见 git log `c7ddf23` ... `4381663` 区间。
