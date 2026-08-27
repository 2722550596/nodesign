# server/engine/ — Agent 引擎（pi-rp RPC）

Nodesign 后端核心。agent 循环由 **pi-rp** 驱动（RPC 模式，`server/engine/pi/`）；
CC SDK 的 `query()` 已随 M1 拆除，SDK hooks / isolation / 注入族已随 M2 删除。
迁移始末与事实核查见 `docs/engine-pi-rp-migration.md`。

## 架构一句话

`session-loop.js` 每会话 spawn 一个 pi-rp 子进程（`lifecycle.js`，带 `-e` 显式挂载
扩展），用 `rpc-client.js` 走 RPC 收发 turn，`event-bridge.js` 把 pi 事件翻译成
EventBus 标准事件推前端；工具经 `buildNodesignTools`（mcp/index.js）→ `standalone.js`
（pi MCP 子进程）直挂，工具名是裸名（无 `mcp__nodesign__` 前缀）。

## 目录结构

```
engine/
├── agent/                       会话编排 + 模型路由 + 事件 schema
│   ├── session-loop.js          ★ runSession：每会话起 pi 进程、跑多 turn（生产入口）
│   ├── context.js               AgentContext（runId / EventBus / abort / counters / workspace）
│   ├── events.js                EventBus + 标准事件 schema（run.* 全家）
│   ├── turn-state.js            每 turn 动态状态注入装配（工作区状态块 + pendingSummary）
│   ├── model-context.js         模型路由 / 上下文窗口 / uncensored 判定
│   ├── model-table.js           模型表（M3 降级，models.json 为唯一真相源）
│   ├── session-model.js         会话级模型解析
│   ├── skill.js                 SKILL.md loader（frontmatter + body）
│   ├── plugin-loader.js         用户级 plugin 加载
│   ├── prompts/                 nodesign-prelude.md（policy 块真相源）+ tools/*.md（懒注入胖文案）
│   └── _smoke.js                烟雾测试（无 key 也能跑非 LLM 部分）
│
├── pi/                          ★ pi-rp 引擎层（M1/M2 新建）
│   ├── lifecycle.js             spawn pi 子进程：-e 挂 6 个扩展 + env 注入（身份/政策/工具）
│   ├── rpc-client.js            RPC 桥：prompt / abort / set_model / set_thinking / get_state
│   ├── event-bridge.js          pi 事件 → EventBus 标准事件（run.delta.* / usage / compaction）
│   ├── sidecar.js               sidecar HTTP 桥：/emit /ask /answer /charge（扩展回主进程）
│   ├── sidecar-client.js        主进程 → sidecar 的薄客户端
│   ├── ask-registry.js          AskUserQuestion 挂起/应答登记（promise 安全）
│   ├── guard-rules.js           安全闸纯判据（项目边界 / 演出隐私 / canvas+site lint）
│   ├── inject-rules.js          懒注入族纯判据（首调注入映射 / 失败建议分流 / rate-limit）
│   ├── policy-render.js         「底线」政策块抽取与渲染（{{ndPolicy}} 宏的实现）
│   ├── model-map.js             本地模型名 → pi provider/model 映射
│   ├── pi-jsonl.js              pi 会话 JSONL 读取（hydrate / 续档真相源）
│   ├── mcp-config.js            每项目 .pi/mcp.json 装配
│   ├── agent-dir/               共享 agent 目录：settings.json（defaultPreset）+ prompt-presets/nodesign.json
│   └── extensions/              pi 扩展（jiti 加载，-e 挂载）
│       ├── providers.ts         注册上游 provider（读 providers-models.json）
│       ├── ask-user.ts          AskUserQuestion 工具（registerTool + sidecar /ask /answer）
│       ├── guards.ts            安全闸（tool_call 拦截 + session_start 装配断言心跳）
│       ├── inject.ts            懒注入 + 失败建议 + rate-limit 上报
│       ├── prompt-support.ts    注册 {{ndPolicy}} 宏
│       ├── migrate-prelude.mjs  nodesign-prelude.md → nodesign.json preset 生成器
│       └── migrate-models.mjs   model-table → providers-models.json 生成器
│
├── mcp/                         工具工厂（buildNodesignTools，零改动复用）
│   ├── index.js                 buildNodesignTools：45+ 工具装配 + tier gate + 项目级禁用
│   ├── standalone.js            MCP 子进程入口（pi 起，读 NODESIGN_DISABLED_TOOLS）
│   ├── tool-shim.js             tool() 本地替身（SDK 拆除后的等价物）
│   ├── tools/                   各工具实现
│   └── external.js              外部 MCP server 装配（NODESIGN_MCP_SERVERS）
│
├── runs/                        run 状态机 + turn 认领
│   ├── store.js                 SQLite 状态机（pending → running → succeeded/failed/cancelled）
│   ├── active-runs.js           活跃 run 登记 / abort / 用量记账
│   ├── turn-relay.js            turn 排队认领（串行纪律）
│   ├── live-turn.js             飞行中 turn 的实时状态
│   └── board-tasklist.js        Task* 工具族 → 黑板镜像
│
├── agents/                      子代理提示词（*.md，迁 pi delegatable presets 中）
│   └── schemas/                 子代理输出 JSON Schema
│
├── runtime/workspace.js         工作区路径解析 + safeResolve + read/write/list 包装
├── browse/                      浏览通道（capture / screencast / refs / registry）
├── perception/                  感知会话
├── motion/                      动效清单
├── chatai/                      小合（OpenAI-compat 编排）
├── plugins/nodesign/            内置 plugin（skills）
└── _smoke.js                    底层骨架烟雾测试（store + workspace）
```

## 入口

- 内部：`runSession({ sessionId, projectId, ownerId, sessionWorkspaceRoot, eventBus,
  inputQueue, skillId, initialRunId })` from `agent/session-loop.js` —— 每会话一个
  pi 进程，`inputQueue.next()` 拉 turn，一条消息一个完整 turn（settle 前不返回）。
- HTTP / WebSocket 装配在 `server/api/` 与 `server/ws/`。

## 跑测试

```bash
# 服务端全量（vitest，server 配置）
npm run test:server

# 非 LLM 烟雾（EventBus / AgentContext / parseFrontmatter / loadSkill）
npm run smoke:agent

# 底层骨架（runs/store + runtime/workspace）
npm run smoke:engine
```

Live 验证走 `_probe-*.mjs`（GATE PASS 文化）：`_probe-m2-prelude-live.mjs`（第一步
preset/policy）、`_probe-m2-step2-live.mjs`（第二步扩展健康 + AskUserQuestion 回路）。

## 事件流（EventBus 标准 schema）

```
run.start
run.delta.text          { round, text }
run.delta.thinking      { round, text }
run.delta.tool_use      { round, blockId, name, input }
run.delta.tool_result   { round, blockId, name, ok, output | error }
run.ask_user_question   { runId, sessionId, askId, questions, ts }
run.compact_boundary    { compactMetadata }       // 上下文压缩点
run.status              { status }                 // compacting | requesting | null
run.rate_limit          { info }
run.preset_activated    { presetId }
run.task.*              { taskId, ... }            // 子代理（delegatable preset）
run.cancelled           { reason }
run.done                { finalText, artifactPath?, snapshot }
run.error               { message, code, stack }   // code ∈ TERMINAL_ERROR_CODES 才终态
```

非终态 `run.error`（如 guards 的 `INIT_CONTRACT` 装配心跳）只转发前端不杀 turn；
`session-loop.js` 的 `TERMINAL_ERROR_CODES`（PROMPT_REJECTED / AUTO_RETRY_EXHAUSTED /
STOP_REASON_ERROR）才是 turn 终结判据。

外层把 `eventBus.subscribe('*', handler)` 桥到 WebSocket / 审计日志 / 测试 buffer。

## 决定 / 不做的事

- ✅ 消费外部 MCP server：.env 的 `NODESIGN_MCP_SERVERS` 声明（JSON：名字 →
  `{type:'sse',url}`），装配见 mcp/external.js。名字/数量全由站主 env 决定。
- ✅ 子代理：pi delegatable presets（agents/*.md 迁移），`subagent` /
  `subagent_profiles` 在 agent-dir/settings.json defaultTools 启用。
- ✅ AskUserQuestion：pi 无原生对应，方案 A 复刻（ask-user.ts registerTool +
  sidecar /ask /answer + ask-registry.js）。
- ❌ bash 工具：pi defaultTools 白名单暂不含（迁移文档开放项，待复评）。
- ❌ SYSTEM.md / APPEND_SYSTEM.md：禁止（会短路 preset 编译，见迁移文档附录 D）。
- ❌ `.pi/` 内不放密钥：身份/配置全走 env（lifecycle spawn 注入）。
