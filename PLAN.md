# Plan: Nodesign

> **living document**——跟代码一起 commit，每完成一个 phase 更新状态 + 实施日志。
> 起点：`~/.claude/plans/plan-parallel-harbor.md`（2026-04-29 plan mode 通过）；2026-04-29 迁入 repo。
> 历史交接快照见 [docs/archive/handovers.md](docs/archive/handovers.md)。

---

## 🟢 Canvas 焕新升级（2026-05-02 起，进行中）

> **入口**：用户 2026-05-02 明确目标"完全升级 canvas"——把当前"工程师风 iframe + 平铺 toolbar + 高自由度右栏 InspectTab"换成"agentic 化的活的画布"。
> 用户客户化（说需求 + 看效果 + 微调），而不是用户设计师化（自己点元素调属性）。

### 核心理念

| 维度 | 现状 | 焕新后 |
|---|---|---|
| 用户角色 | 设计师（Inspect 自调字号/颜色/字重六维度） | 客户（说需求 / 看效果 / agent 给的 tweak 浮窗微调）。Direct Edits / InspectTab 保留作高级后路，**不聚焦** |
| 画布形态 | iframe 贴左上 + toolbar 顶 + 右栏 4 tab 平铺 | stage 居中 + 暖底 + 协作信号区，右栏默认只显 InputsTab，其他 tab 收 collapse |
| Comment 流转 | 写完手动复制到 chat | pin 在元素旁 + pending list + 下次 send 自动打包发 agent |
| Tweak 来源 | 用户主动点 InspectTab | agent 改完后**主动 emit** tweak schema → 元素旁浮窗 |
| Agent 视野 | 只看第一页 | 新工具 read_page(N) 精确读任意页 |
| 修改反馈 | iframe 闷头 reload | agent 改第 N 页 → SlideNavigator 自动跳 + 该 section 1.5s pulse 高亮 |
| HTML 形态 | 硬 self-contained | 单文件但放开 trusted CDN（fonts/icons/animation lib）+ data-tweakable / data-page-anchor 标记 |

### 5 阶段执行清单

| 阶段 | 范围 | 估 commit |
|---|---|---|
| **S0** plan 落档 | 本段 + 实施日志预留 | 1 |
| **S1 Agent 端基础设施** | (a) prelude/SKILL.md 教 agent 加 `data-tweakable` / `data-page-anchor` (b) 放开 trusted CDN + PostToolUse hook 软警告 (c) MCP `read_page(N)` (d) 事件 `run.canvas_focus_page` | 4-5 |
| **S2 前端 Stage 重做 + 右栏减负** | (a) CanvasFrame 视觉重做（stage 居中 + 阴影 + 暖底）(b) ContextPanel 减到默认只显 InputsTab (c) Hover 元素显示语义角标 (d) SlideNavigator 接 focus_page event 自动跳 + 1.5s pulse | 3-4 |
| **S3 Comment pin + 攒批 + Tweak 浮窗** | (a) 元素点击 → 评论浮窗 pin + pending list (b) Composer send 时打包所有 pending（anchor + outerHTML + computedStyles + boundingBox + page + screenshot crop）(c) `expose_tweaks` MCP → 元素旁渲染 slider/colorpicker (d) Direct Edit Bridge 保留（高级后路）| 4-5 |
| **S4 时间轴雏形** | (a) 右下角时间轴 collapse panel，git log 拉 commit (b) 节点显示 commit message + 缩略图占位 (c) UndoButton 升级为时间轴节点点击 | 2-3 |

总 14-18 commit。

### 决策档案

- **HTML 形态升级 = 标记 + CDN 放开 + agent 操控画布**，不做 13a 多文件 bundle / 13b React-Vue artifact（耦合 hot reload + git history + iframe / 是下一段大工程）；13c run-time tweaks 已被 S3 吃掉
- **tweak 控件不持久化**——临时遗物 turn 结束自动收起，最终值进 spec.json.decisions
- **HTML 标记策略 = agent 自己加**（SKILL.md 教 + 灵活），hook 不做兜底
- **右栏不砍但不聚焦**——默认 collapse，用户点 tab bar 才展开。Direct Edits Bridge 保留
- **agentic 化 ≠ 砍 Direct Edits**：聚焦点在 agentic（用户大部分时候不必自调），用户主导路径作为后路保留

### 实施日志

（每段 ship 后追加。S0 commit hash 见 git log）

---

## 🟢 当前状态（必读）

> **活在线上的版本**：v0.1.0-mvp（2026-05-03 上线 Ubuntu 服务器，内部测试可用）。
> 实施细节首选 [HANDOVER.md](HANDOVER.md) + [docs/archive/handovers.md](docs/archive/handovers.md) 最近段。

### 一句话定位

NoDesign = **Claude Code 之上的画布编辑层**，按 Anthropic Projects 模式：
- **Project** = 项目元数据 + workspace 目录
- **Workspace** = `shared/`（CLAUDE.md / agent-memory / assets）+ `sessions/<sid>/`（独立沙盒：canvas / spec / .git / SDK JSONL）
- **Project Hub** （`/projects/:id`）= 控制台
- **Project Workspace**（`/projects/:id/work` 或 `/sessions/:sid`）= chat + canvas + context

### 已 ship 的关键设施（截至 2026-05-06）

| 层 | 现状 |
|---|---|
| **agent 入口** | loop.js 单一 runAgent()，cwd=sessions/<sid>/，shared 通过 additionalDirectories + 软链 |
| **prompt 接口** | AsyncIterable<SDKUserMessage> + content blocks |
| **SDK options** | persistSession / settingSources:['project'] / sessionId 预生成 / thinking enabled+budgetTokens 8192 / additionalDirectories=[shared] / sandbox 暂禁 (bwrap symlink) |
| **session 持久化** | SDK JSONL 落 sessions/<sid>/.claude/projects/<encoded-cwd>/<sid>.jsonl |
| **session API** | listSessions / getSessionMessages / forkSession / renameSession / tagSession / deleteSession |
| **Workspace 结构** | shared/ + sessions/<sid>/ 二级 |
| **Hooks** | FileChanged / PreToolUse / Stop / PostCompact + UserPromptSubmit / SessionStart / PostToolUse×3 / PostToolUseFailure / SubagentStart/Stop（10/29）|
| **MCP 工具集** | screenshot_canvas / export_handoff / record_decision / web_search / list_pages / read_page / query_elements / get_computed_styles / navigate_to_page / highlight / expose_tweaks / get-clear_pending_changes / WebFetch（13）|
| **Subagent** | explorer ✅（真接通）；vision-checker ✅（接通 + Tier 0 plan compliance）；ds-extractor / tweak-proposer 骨架 |
| **Paradigm** | ask（默认 1-3 轮）→ plan（design-plan.md 流）→ explore → generate → vision-check 全闭环 |
| **Kimi 兼容** | binary-fixup-proxy 修 thinking adaptive→enabled + tool_result 嵌套 image lift 到顶层（仅 kimi-*）|
| **UI** | Hub 三 cards + Workspace timeline group + ThinkingMessage shimmer + 工具 icon 实时 + 实时 ContextUsageBar + AskUserQuestion wizard + VisionCheckerCard + DesignPlanModal |
| **HTML 标准** | 单文件 5-style-block head / 6 named layouts（自由命名）/ 3 必装 data-*（page/anchor/node-id）+ 1 可选 / scoped tweak vars |

### 已知 follow-up（不阻塞主路径）

1. ~~Kimi 走 SDK binary 不输出 thinking blocks~~ ✅ 已修
2. **agent 不主动用 agent-memory** — SKILL.md 没教写 memory，要补
3. **agent 用 shared/assets 验证** — probe brief 让 agent 引用上传的图
4. **多 user 并发隔离** — process.env.CLAUDE_CONFIG_DIR mutation（mutex 串行化），生产部署多 user 上要重审
5. ~~vision-checker subagent 真接通~~ ✅ 2026-05-02 S3 接通
6. **Plan mode 接入** — 当前用 design-plan.md 流替代了 SDK permissionMode='plan'。如需正统 plan mode，先 probe Kimi binary 链路下是否 stuck
7. ~~ds-extractor / tweak-proposer 真接通~~ — 骨架在，按需接（参考 vision-checker）
8. **NoDesign agent 接 inspect 整应用 UI** — 目前只能看 canvas.html。需要 `nodesign_open_url` MCP 或外接 Claude Preview MCP server
9. ~~实时 context usage~~ ✅ A2 完成
10. ~~CDN 外部资源~~ ✅ S0 撤白名单
11. ~~Kimi 反思 3 痛点（追问/assets/一图胜千言）~~ ✅ SKILL.md 落实
12. ~~vision-checker prompt~~ ✅ Tier 0 plan compliance + Tier 1 sealed-test
13. **HTML 产物升级方向**（待用户明确范围）— 13a 多文件 bundle / 13b React-Vue artifact / 13c run-time tweaks UI（已被 Canvas v0.6 S3 吃掉）/ 13d 持久化状态 / 13e 多分辨率 / 13f layout 多元化（dashboard / form / landing）
14. **Workspace layout 改 grid + auto reflow**（react-grid-layout 风）— 用户明确选 Grid Layout。**G0+G1+G2 试错全失败回退**（react-grid-layout v2 主入口 API 跟 v1 不同；v1 在 `/legacy` 但 React 19 hook null bug；mount 时自动 reflow 把 default layout 改了；panel h × rowHeight 超 viewport）。新 session 重做 plan：阶段 1 隔离 demo `/grid-demo` 路由 1-2 天充分验证 RGL 配置；阶段 2 接业务 1 天。**关键复用**（9f5b900 回退后保留）：STAGE token / PanelMenu UI / 5 Tab 接口 / ChatPanel / CanvasFrame
15. **AskUserQuestion 教学深化**（intent extraction：多变体 preview 当问题 / 何时停问）
16. **list_layouts MCP**（如果未来加新 layout 频繁）
17. ~~lift transform vs cache_control~~ — 现在 image 每次都被 lift（结构变化）= prompt cache key 变化 = cache miss。同 image 重复使用时需要再设计

---

## Design Principles（长期约束）

1. **不污染原则**：v0.7.5 是参考不是约束。Nodesign 的 spec / HTML 生成 / 渲染 / 验证全部独立设计
2. **探索 → 反向优化**：Nodesign 是工作台，目的探索更好的 deck 生成流程。skill 是被探索对象不是天花板
3. **spec 与 HTML 角色分离**：
   - **spec**：agent commitment device + 跨 run 设计意图记忆。结构化 JSON，给 LLM / 历史 / 多 skill 协作看
   - **HTML**：用户面前的产物，所有局部交互（comment / edit / slider）的修改对象。自包含单文件
   - **修改流向**：spec → HTML 是生成；HTML → spec **不回流**；用户改 spec 必须通过 chat 触发新 run
4. **视觉沿用 DeskSkill 风格**：亮黑主按钮 #2d2418 / 深棕标题 #3a2a18 / F9F8F6 页面底 / layered shadows / Container Transform 入退场 / cubic-bezier(0.25, 1, 0.5, 1)
5. **能复用 dev/src 就复用**
6. **参照系统 = 工作流产品化**（不是 nice-to-have）— 完整工作流：用户给现有作品 → Nodesign 扫风格/组件/布局/节奏 → 设计师 review/调整 → 应用到新项目（含"惯用法"不只是 token）
7. **Inspector 级元素选择 +「人话/AI 双视图」**：
   - **人话视图**（设计师）：用途 + 当前样式 + 可调维度 + ripple 范围
   - **AI 上下文视图**（LLM）：path / outerHTML / computed styles / spec field / siblings / data-node-id

### 5 条新设计原则（SDK 接通后，覆盖原 §1-§8）

1. **agent 能力 = SDK**。不要自撸 LLM 调用 / agent loop / 工具实现 / session 管理 / file checkpoint
2. **可见性优先**。"agent 在做什么"是产品核心信号，不要默认折叠
3. **不框定模式**。SDK 接通后 agent 看输入和附件能自决
4. **双轨持久化**。session 内 SDK rewindFiles + 跨 session git
5. **沙盒分阶段**。stage 1 cwd + canUseTool；stage 2 公测时 Docker via `spawnClaudeCodeProcess`

---

## Architecture Decision

### 统一 iframe canvas（HTML 中心）

| 模式 | 用途 | 实现 |
|---|---|---|
| **Edit** | inline comment / direct edit / slider live preview / 未来 CAD | iframe + 顶层 overlay + postMessage 桥接 |
| **Preview** | 看最终效果 | 同 iframe，关 overlay 和编辑钩子 |
| **Code** | 直接改 HTML 源码 | Monaco editor，blur 落库 |

**理由**：HTML 自包含单文件 → iframe 加载零改造；Claude Design § 6.2 明说他们的 canvas 就是 "interactive HTML rendered in canvas"；省 React spec renderer 一大块前端工程量。

### 双向流：WebSocket

每 project 一个 WS（带 reconnect）。30+ 事件类型见 `events.js` 头部完整列表。

### page-spec（commitment device，不是渲染源）

存 spec.json，给 LLM / 项目历史看。前端不直接渲染，只在 SystemTab / Decisions 展示摘要。结构由 agent 维护：`{ history: [...], decisions: [...] }`。agent 通过 `mcp__nodesign__record_decision` 写入。

### 项目数据流

```
brief + 上传素材 + previousSpec?
    ↓ agent loop（思考 → 产出 spec → 生成 HTML）
HTML 存项目 → canvas iframe 加载

用户局部修改 HTML：
    ├─ direct edit  → contenteditable → blur 落 HTML（不动 spec）
    ├─ comment apply → simple-LLM 收 element + 指令 → patched HTML
    ├─ slider apply  → CSS var 落 HTML（不动 spec）
    └─ (v2) CAD     → DOM 操作落 HTML（不动 spec）

用户全局意图变化：
    └─ chat "整体重新规划" → 新 run（agent 可能改 spec + 重生成 HTML）
```

---

## 完成度速查

| Phase | 状态 | 完成日期 | 工作量（实际）|
|---|---|---|---|
| **P1-P2.5 前端骨架 + 产品壳** | ✅ | 2026-04-29 | 1 天半 |
| **P3 后端最小集 + agent 模块** | ✅ | 2026-04-29 | 半天（live e2e ✅）|
| **P0 重做主线 5 流（A/B/C/E/I）** | ✅ | 2026-04-30 | 一天（10 commit）|
| **P0+ stage 1 全量切 SDK** | ✅ | 2026-04-30 | 一天（22 commit）|
| **P0+ Phase H 前端可视化** | ✅ | 2026-04-30 | 半天（10 commit）|
| **agent 层 Phase 1+2+3 SDK 用法精度对齐** | ✅ | 2026-05-01 | 半天（8 commit）|
| **S1-S4 + H1-H5 session-scoped 重构** | ✅ | 2026-05-01 | 一天（11 commit）|
| **P2 thinking proxy + UI 精修** | ✅ | 2026-05-01 下半场 | 半天（17 commit）|
| **A1-A6 + C1-C6 paradigm 落地 + Canvas v0.6** | ✅ | 2026-05-02 | 一天（21 commit）|
| **S0-S8 paradigm 5 阶段全接通 + Kimi vision fix** | ✅ | 2026-05-02 晚 | 半天（16 commit）|
| **v0.1.0-mvp 上线生产** | ✅ | 2026-05-03 | 半天（DEPLOY.md 4 个 Linux 坑）|
| **跨平台决策落档 + Linux 修复合并** | ✅ | 2026-05-06 | merge nodesign-server-ver |
| **🟢 Canvas 焕新升级（S0-S4）** | 🟡 进行中 | — | 估 14-18 commit |

详见 [docs/archive/handovers.md](docs/archive/handovers.md) 各段。

---

## 修订历史

| 日期 | milestone |
|---|---|
| 2026-04-29 | 初版（plan mode 通过）+ §7 §8（参照系统 / Inspector 双视图）+ 迁入 repo + P2.5 对照 Claude_design.md gap 审计 + **P3 战略转向：弃自写 agent-loop，包 Claude Agent SDK**（用户提供 tokendance gateway，Kimi 在 Claude Code/SDK 全功能可用，借力 SDK 23 工具 + 30 hooks + sub-agents） |
| 2026-04-30 | reset deec72d；4-29 晚 yolo 8 commit 移到 yolo-night-2026-04-29 分支。**战略再转向：NoDesign = Claude Code 之上的画布编辑层**（不是独立 agent 系统）。5 条产品/架构原则锁定。**P0+ stage 1：22 commit 全量切 SDK 现成能力**（hooks / MCP / agents / undo 双轨 / 4 个前端组件 / SDK message 翻译扩展）。**Phase H：10 commit 前端可视化补完**。"自由创作 vs 参照模式"过时设计移除。memory 同步（`nodesign_sdk_principle.md` + `nodesign_p0plus_stage1_summary.md`） |
| 2026-05-01 | **agent 层 Phase 1+2+3：8 commit SDK 用法精度对齐**（query handle / hooks 4→10 / 子代理 thinking 转发 / SKILL.md 精简 / cancelRun 切 query.interrupt() / SDK sandbox 替白名单）。**S1-S4 + H1-H5：11 commit session-scoped 重构**（Anthropic Projects 模式，shared/+sessions/<sid>/，Hub 二级页，三 cards 真接）。下半场 17 commit P2：Kimi thinking 修（binary-fixup-proxy）+ autoCompact + Edit originalFile trim + web_search MCP + Timeline UI 精修 |
| 2026-05-02 | F0-F3 FloatingPanel 重构 + S1-S4 canvas 焕新；**A1-A6 + C1-C6：21 commit agent paradigm 落地 + Canvas v0.6 13 MCP 工具齐全 + HTML 5-style-block 标准锁定 + AskUserQuestion 走 SDK canUseTool**；**S0-S8 晚段：16 commit paradigm 5 阶段全接通**（vision-checker 真接通 / plan-mode = design-plan.md 流 / Kimi vision tool_result 嵌套 image lift 修复） |
| 2026-05-03 | **v0.1.0-mvp 上线 Ubuntu 服务器**（生产可用，内部测试）；DEPLOY.md 落 4 个 Linux 坑（bubblewrap+socat / non-root 用户 / SDK musl 误判 / SDK dep 位置）|
| 2026-05-06 | **跨平台决策落档 + Linux 部署修复合并** — merge `nodesign-server-ver`：CLAUDE_CONFIG_DIR 全局化 / 软链拓扑重排（bwrap 兼容）/ skipWebFetchPreflight / 导出质量升级。**新增 [server/runtime/platform.js](server/runtime/platform.js) 集中跨平台决策**；**sandbox 暂时禁用**（bwrap 不解析 symlink）。详见 README.md "开发约束" + DEPLOY.md "跨平台决策档案"。⚠️ memory `feedback_sandbox_replaces_whitelist.md` 已 superseded |
| 2026-05-06（晚） | **NoDesk 公司网关切换 + SDK helper 全量接入** — 4 commit：(1) `e6607e3` 网关换 NoDesk passthrough（channel="DMX" → DMXAPI），主代理保留 kimi-k2.6，subagent + 所有 SDK helper 升 `claude-haiku-4-5-20251001-cc`；修 binary-fixup-proxy `x-api-key→Bearer` 鉴权（不修则全 401）；补 hooks.js 遗失的 Grep handler。(2) `e770dc7` 前端接 4 类后端已 emit 但前端没消费的 helper：rate_limit/status toast、rewindFiles per-msg Undo（前后端协同）、MemoryCard 双向 recall（主动 📎 attach + 自动召回历史区）、Elicitation 占位 Modal。(3) `4165292` SDK auto session title — drop turn.js 硬塞 sessionTitle，让 SDK haiku 自动总结。(4) `4ac88f3` TimelineGroup 折叠标题升级 — Stop hook 调 `summarizeForTimeline(last_assistant_message)` 出 12 字"动作型"标题，emit `run.timeline_summary` → 前端按 runId 查表替代旧的"首段截 60 字"。新增 [server/lib/llm-summary.js](server/lib/llm-summary.js)。**发现并归档 K2.6 长 context `tool_use_id` 卡死循环 bug**（memory `feedback_kimi_k26_long_context_tool_loop.md`）。下次 session 要"优化方法论" |

---

## 实施日志

> 早期 P1-P3 / P0 / Phase H / Phase 1+2+3 / session-scoped / paradigm 各段实施细节已迁入 [docs/archive/handovers.md](docs/archive/handovers.md)，按时间倒序列每段：commit hash + 关键文件 + 决策因果链 + 踩坑。

后续每完成一段就在这里追加一段（不再追加到 PLAN.md，落档到 archive）。

---

## Verification（P1 完成的判据）

P1 验证已全部通过（2026-04-29 commit `c7ddf23`）。当前每段新功能验证清单写在对应 archive 段或 commit message。最近一次 cold-start 自检清单见 [HANDOVER.md](HANDOVER.md) "Cold-start 推荐阅读"。

---

## 开放问题

1. **page-spec schema 字段** — 草案在早期 archive，实际探索 P3-P5 时根据 agent 实际产出迭代。当前由 agent 自维护 `{ history, decisions }`
2. **WS 事件协议** — 30+ 事件类型见 `server/engine/agent/events.js` 头部
3. **iframe postMessage 编辑桥接细节** — element anchor 序列化（DOM path / data-node-id 已用）/ contenteditable scope / direct read vs postMessage
4. **inputs ingest pipeline 范围**（P3 之后）— MVP 只 .html / .pdf / 截图（PNG/JPG）；.pptx / .docx / repo / web capture 推后
5. **CAD 拖动 v2 技术** — dnd-kit vs react-dnd vs 自写。等 v2 启动再选
6. **PPTX 导出**（P7）— pptxgenjs vs 自写 page-spec → PPTX 转换器
7. **Workspace layout 改 grid**（follow-up #14）— react-grid-layout v2 试错失败，新 session 走隔离 demo 路线
