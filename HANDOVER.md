# Nodesign — 交接文档

> **当前状态**：v0.1.0-mvp 已上线 Ubuntu 服务器，内部测试可访问。
> **历史交接归档**：[docs/archive/handovers.md](docs/archive/handovers.md)（按时间倒序，9 段历史快照）
> **最新进展**：见 [PLAN.md](PLAN.md) "🟢 当前状态" + "🟢 Canvas 焕新升级（进行中）"段
> **核心原则**：见 `~/.claude/projects/.../memory/nodesign_sdk_principle.md`

---

## 一句话定位

NoDesign = **Claude Code 之上的画布编辑层**。底层 agent 能力（LLM / agent loop / 工具集 / session / file checkpoint / hooks / MCP / subagent / permission）**完全来自 Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）。

我们做 4 件事：
| 内容 | 在哪里 |
|---|---|
| ① 薄壳后端（包 SDK + REST/WS）| `server/` |
| ② 前端画布编辑层（chat / iframe / direct edit / inspect） | `web/src/` |
| ③ 默认 SKILL.md（教 agent 做 deck）| `server/engine/skills/deskskill-engine-mini/SKILL.md` |
| ④ Hooks + MCP tools + subagents（业务逻辑） | `server/engine/{hooks,mcp,agents}/` |

**偏不远**：把 server / web 全删，SDK 直接 `npx claude` 在 workspace 里仍能跑。

---

## Workspace 结构（Anthropic Projects 模式）

```
<projects-data>/<projectId>/
├── shared/                          ← project 共享（agent 看，跨 session）
│   ├── .claude/{CLAUDE.md, settings.json, skills, agents, agent-memory/<type>/}
│   ├── assets/                      ← 用户上传文件
│   └── .gitignore
└── sessions/<sid>/                  ← 每 session 独立沙盒
    ├── canvas.html, spec.json
    ├── .claude/{5 软链 → ../../../shared/.claude/...}
    │   └── projects/<encoded-cwd>/<sid>.jsonl  ← SDK 转录
    └── .git/
```

- **Project Hub**（`/projects/:id`）= 控制台：Memory / Instructions / Files cards + sessions list + 新会话 input
- **Project Workspace**（`/projects/:id/work` 或 `/sessions/:sid`）= chat + canvas + context 工作台
- **URL = sid 唯一 source of truth**（切 session 走 navigate 不 setState）

---

## 关键文件 cheatsheet

读代码先看这几个：

```
server/engine/agent/loop.js                 ★ runAgent 主入口；SDK options 中心
server/engine/agent/hooks.js                ★ hooks 业务逻辑（10/29 个 SDK hook）
server/engine/agent/events.js               ★ 30+ 种事件构造器（前端事件协议）
server/engine/agent/prompts/nodesign-prelude.md   通用 prelude
server/engine/skills/deskskill-engine-mini/SKILL.md   ★ deck 业务约束 + HTML 标准
server/engine/agents/{explorer,vision-checker,ds-extractor,tweak-proposer}.md
server/engine/mcp/index.js                  MCP server（13 工具）
server/engine/runs/active-runs.js           AbortController + pendingQuestions registry
server/api/turn.js                          POST /turn + /cancel + /answer
server/lib/binary-fixup-proxy.js            Kimi thinking + vision lift 修复（仅 kimi-*）
server/projects/workspace.js                shared/+sessions/<sid>/ 二级结构 helper
server/runtime/platform.js                  ★ 跨平台决策集中（2026-05-06 新增）

web/src/routes/{ProjectHub,ProjectWorkspace}.jsx
web/src/lib/api.js                          REST 客户端
web/src/lib/ws-client.js                    WS 透传 + 重连
web/src/components/chat/Message.jsx         ★ 多 role 渲染
web/src/components/canvas/CanvasFrame.jsx + iframe + InspectFloatingCard
web/src/components/project/{InstructionsCard,FilesCard,MemoryCard,ContextUsageBar}.jsx
```

---

## SDK 用法关键决策（不要踩老路）

### sdkOptions 必设字段

| 字段 | 值 | 为什么 |
|---|---|---|
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code', append: skill.systemPrompt }` | string 模式让 agent 失去 SDK 默认约束 → 一个 turn 做 30 件事停不下来 |
| `permissionMode` | `'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | 默认 'default' 让 binary 等 stdin → spawn 没接 stdin → hang |
| `enableFileCheckpointing` | `true` | session 内 rewindFiles 能用；跨 session 走 git 双轨 |
| `agentProgressSummaries` | `true` | subagent 30s 摘要事件 |
| `promptSuggestions` | `true` | 每轮预测下条 prompt |
| `includePartialMessages` | `true` | stream_event → 流式打字 |
| `maxTurns` | 15 | 50 太宽（agent 反复优化）|
| `forwardSubagentText` | `true` | 子代理可观测性零成本 |
| `maxBudgetUsd` | env-driven 默认 $1 | 防失控 |
| `cwd` | `sessions/<sid>/` | per-session 物理隔离 |
| `additionalDirectories` | `[sharedRoot]` | 让 agent 跨目录 Read shared/assets |
| `sessionId` (新建) / `resume` (续约) | crypto.randomUUID 预生成 / 前端传 sid | sid 由谁生成 |
| `persistSession: true` / `settingSources: ['project']` | — | SDK 自持久化 + 项目级 settings |
| `thinking` | `{ type: 'enabled', budgetTokens: 8192 }` | adaptive 仅 Opus 4.6+ |
| ~~`sandbox`~~ | **2026-05-06 暂时禁用** | bwrap 不解析 symlink；详见 `server/runtime/platform.js` |

### 5 条新设计原则

1. **agent 能力 = SDK**。不要自撸 LLM/agent loop/工具/session/checkpoint
2. **可见性优先**。"agent 在做什么"必须在前端可见
3. **不框定模式**。SDK 接通后 agent 自决；不要前端预设 mode/skill type
4. **双轨持久化**。session 内 rewindFiles + 跨 session git
5. **沙盒分阶段**。stage 1 cwd + canUseTool 兜底；stage 2 公测前上 Docker via `spawnClaudeCodeProcess`

### 已撞过的坑（不要重蹈）

- ❌ `systemPrompt: skill.systemPrompt`（string 完全覆盖）→ 失去 SDK 默认约束
- ❌ 默认 permissionMode + spawn 没接 stdin → AskUserQuestion / 危险操作 prompt 卡死
- ❌ 自撸 git commit/revert/history endpoint（SDK 有 enableFileCheckpointing + rewindFiles）
- ❌ brief 字符串拼附件路径（用 content blocks）
- ❌ iframe reloadToken 手动 bump（用 FileChanged hook）
- ❌ 自定义 ask 工具（SDK 内置 AskUserQuestion，走 canUseTool）
- ❌ Kimi 把 image 嵌 tool_result.content（vision pipeline 不识别，要 lift 到 user message 顶层 — 仅 kimi-*）
- ❌ 把 lift transform 推广到非 kimi-* model（其他 model 可能依赖 tool_result image attribution）
- ❌ 重启 server 用 `pkill` pattern（共享机风险），用 `kill <PID>` 精准

---

## Debug 入口

| 症状 | 看哪 |
|---|---|
| agent 不响应 | server console + DevTools Network → WS 连接 |
| iframe 不刷新 | Project handleEvent 收到 `run.file_changed`？filePath 命中 canvas.html？ |
| chat 看不到 agent 在做什么 | events.js 翻译完整否？handleEvent case 全否？Message.jsx tool 渲染 |
| "ask 不 pending" | loop.js permissionMode 是 `'bypassPermissions'`？`allowDangerouslySkipPermissions: true`？|
| "停不下来" | maxTurns？systemPrompt 用 preset 'claude_code'？|
| spec.json 没更新 | agent 调 record_decision 工具了吗？|
| 截图返回 base64 字符串而非图 | tool_result 中 image content block 路径 fix（loop.js handleUserBlocks 提取 images）|
| Kimi 看不到图 | binary-fixup-proxy 的 liftImagesFromToolResult 是否生效（仅 kimi-*）|
| 撤销不动 | Canvas.undo() → POST /canvas/undo → git checkout HEAD~1 |

---

## Cold-start 推荐阅读

1. `~/.claude/projects/.../memory/nodesign_sdk_principle.md`（必读，1 分钟）
2. `~/.claude/projects/.../memory/MEMORY.md`（索引）
3. 本文 § "关键文件 cheatsheet" + "SDK 用法关键决策"
4. [PLAN.md](PLAN.md) "🟢 当前状态" + "🟢 Canvas 焕新升级"
5. [docs/archive/handovers.md](docs/archive/handovers.md) 最近一段（视任务而定）
6. [Canvas.md](Canvas.md) — Canvas v0.6 完整架构（510 行）
7. [DEPLOY.md](DEPLOY.md) — 生产部署 + 跨平台决策档案
