# Engine 替换：CC SDK → pi-rp RPC（定稿 v3）

> 状态：**M1 完成**（2026-08-27）——CC SDK 依赖已移除，pi-rp 为唯一执行引擎；live 探针 GATE PASS，
> `npm run test:server` 778/778 全绿。**M1.5（簇 A RPC 接线）完成**（2026-08-27）：热换模型 /
> thinking 档位 / context usage / 默认模型 fail-loud / env 全家桶 fallback 全部接线，
> `_probe-m15-live.mjs` GATE PASS；set_preset live 验证 `_probe-preset-live.mjs` GATE PASS（pre-M2）。
> **M2 / 簇 B / M3 已排期**（2026-08-27 grill 定案，见 §6）。
> 目标：把 `@anthropic-ai/claude-agent-sdk`（`query()` 子进程）整个摘掉，agent loop 交给 pi-rp
> （`pi --mode rpc`），工具面最终走 pi 扩展 `registerTool` 直挂（MCP 层为 M1 过渡态）。
> 作者同时是 pi-rp 维护者：pi-rp 侧的缺口就地补（见 §5.6），不做版本防御。

## 1. 动机

1. CC SDK 的隐形提示词（`claude_code` preset ~27.7KB、SDK 硬注入残留、`CLAUDE_CODE_*` env 行为）改不掉、剥不净，`sdkPreset='replace'` 也只能换掉 systemPrompt 字段。
2. Nodesign 在 SDK hooks 上叠加的注入族（pre-injectors / user-prompt-submit / post-guidance / canvas-validate / site-validate / failure / subagent-report…）越滚越厚，成了第二层隐形提示词。
3. pi-rp 有可见的 prompt preset 体系、原生 skills/subagent、RPC 模式、扩展 API——提示词变成**能读的文件**，安全闸变成**显式 hook 代码**。

## 2. 已验证事实

> 来源：M0 四路调研（scout）+ 两波探针（REPORT 于 /tmp/nd-m0-probe/）+ preset 机制 6 问源码核查 + M1 live 探针 + 2026-08-27 假缺口审计。全部标来源；与正文冲突处以此节为准。

### 2.1 RPC 协议面（PiRpSrc + REPORT）

- 线上事件是 `AgentSessionEvent`：agent_start / turn_start / message_start / message_update / message_end / turn_end / agent_end / agent_settled / tool_execution_start / tool_execution_update / tool_execution_end / compaction_start / compaction_end / extension_error / error 等。**无 hello 启动消息**；session_start / session_shutdown / session_compact 是**扩展 API 事件，不走 RPC 线上**。
- 所有命令支持可选 `id` 做请求-响应关联（`response{id}`）；**事件不带 id**，靠顺序 + 状态机（agent_settled 收尾）。
- 实测事件序列：`response{id:req-1}` → agent_start → turn_start → message_start/end(user) → message_start(assistant) → message_update{thinking_start/delta/end, text_start/delta/end} → message_end(stopReason, usage) → turn_end → agent_end{willRetry} → agent_settled。
- 思考走 thinking_delta、正文走 text_delta；跨块（contentIndex）累积后与 `get_last_assistant_text` **逐字节一致**（B2 重放 28 行真实事件验证）。
- prompt 命令是排队语义：启动未完成也能缓冲、不丢。
- pi 冷启 1.3–1.8s（无 adapter；带 adapter 时首事件窗口更大）；首消息总耗时 ~8s（其中冷启 ~1.75s）。

### 2.2 RPC 命令全表（2026-08-27 假缺口审计，rpc-mode.ts 源码）

M1 文档曾把若干能力标为"pi 无对应物"，审计后**多数是假缺口**：

| 能力 | RPC 命令 | 状态 |
|---|---|---|
| 热换模型 | `set_model {provider, modelId}` + `cycle_model` | ✅ 存在（rpc-mode.ts:629），M1 误标 501 |
| preset 切换 | `set_preset {presetId}` | ✅ 源码存在（rpc-mode.ts:678），dist 已重建（2026-08-27），live 验证 GATE PASS |
| context usage | `get_session_stats` → `SessionStats.contextUsage?: ContextUsage` | ✅ 存在（rpc-mode.ts:767，agent-session.ts:336） |
| 会话树导航 | `navigate_tree {targetId}` + `get_tree` + `fork` + `reroll` + `clone` | ✅ 存在；navigate_tree 注释原话 "used by the writer process to rewind" |
| 压缩 | `compact` + `set_auto_compaction` | ✅ 存在 |
| 状态 | `get_state` / `update_state` / `watch_state` | ✅ 存在；`get_state` 新增 `activePresetId` 字段（2026-08-27，preset 可观测） |
| 会话管理 | `new_session` / `switch_session` / `set_session_name` / `get_messages` / `get_entries` | ✅ 存在 |
| bash | `bash` + `abort_bash` | ✅ 存在 |
| 导出 | `export_html` | ✅ 存在 |
| 重试 | `set_auto_retry` / `abort_retry` | ✅ 存在 |
| steering | `steer` / `follow_up` / `set_steering_mode` / `set_follow_up_mode` | ✅ 存在 |
| 提示词 | `reload_prompts` / `get_commands` / `init_context` | ✅ 存在 |
| 统计 | `get_session_stats` / `get_last_assistant_text` | ✅ 存在 |

**真缺口**（pi 确实没有）：
- AskUserQuestion / elicitation：pi 无 canUseTool/permission 回调，无 elicitation 机制。复刻方案见 §5.3。
- 截断续写（truncation-continuation）：M1 不做。

**死字段**（不是缺口，是历史残留）：
- `permissionMode`：前端注释"保留字段兼容，后端已忽略（plan mode 2026-08-21 整体移除）"。turn.js:72 解构但不用。M3 清理。

### 2.3 路径与配置语义（PiRpSrc④⑤ + REPORT 踩坑 2 + 本次核查）

- `--config-dir` / `--settings-file` 按 `join(cwd, 值)` 拼接，**绝对路径拼坏**；`--session-dir` 绝对路径直通（normalizePath）。相对值里带 `..` 会被 join 归一化（worldlines 已验证）。
- `--settings-file` 所在目录**不被**扫描 presets/extensions（help 文案与实现不符，settings-manager.ts:219）。settings 差异走 agent-dir/settings.json（global scope）。
- `PI_CODING_AGENT_DIR` 专用 agent dir 隔离生效；`PI_TELEMETRY=0` 关遥测；RPC 必须 `--approve`（否则 .pi 资源被忽略）；`--no-extensions` 不影响 `-e`。
- pi 0.84.2 内建工具：read / bash / edit / write / grep / find / ls + state_update / get_state + subagent / subagent_profiles（**无 glob**）；settings.json `defaultTools` 白名单可排除 bash/subagent。
- `--system-prompt ""` 语义：`resolvePromptInput("")` → falsy → `undefined` → `hasCustomPrompt=false` → **preset 编译路径激活**（agent-session.ts:680, resource-loader.ts:55-57）。lifecycle 传 `--system-prompt ""` 是正确的。

### 2.4 preset 机制（本次 6 问核查，全文见附录 B）

- **文件库两级**：agentDir/prompt-presets（先）+ cwd/.pi/prompt-presets（后）；同 id 项目覆盖全局（保持全局槽位位置）。
- **选择**：`chooseDefaultPreset` 三级回退——preferredId → 首个 `autoActivate:true` → 首个 `autoActivate !== false` → undefined（落内建 pi-default）。**autoActivate:true 只在启动选默认用；有它在场时缺省 autoActivate 的 preset 不会被自动选中**。
- **激活与恢复**：`_rebuildSystemPrompt` 按 `会话 JSONL 最新 preset_change 条目 ?? settings.json defaultPreset ?? chooseDefaultPreset` 定 `_activePreset`。切换写 session JSONL（`preset_change` 条目，必写）；settings.json `defaultPreset` **只在切到 none/off/default 禁用分支才写**。
- **切换入口**：交互式 `/preset`、CLI `--preset <id>`、RPC `set_preset`（§5.6，源码已有）。
- `--preset <id>` spawn 时经 `setActivePreset(persistSettings:false)` → `_presetExplicitlyActivated=true` → **优先于会话恢复块**（重启换 preset 的语义依据）。
- 格式：items 只有 block / slot 两种，**无继承机制**；13 内置槽（slot-renderers.ts:46-61）；12 内建宏（date/time/cwd/lastUserMessage/tools/selectedTools/activeModel/setvar/addvar/getvar/trim/user，`{{name}}` / `{{name:param}}`）；`hiddenOverrides`（continueText / compaction 文案可覆盖）；扩展 API 有 registerSlot / registerMacro / compilePreset / `on("preset_activated")`，**无 setActivePreset**。
- 编译语义：compileMessages 以 **chat-history 槽为锚点**（槽前 items + `agent.state.messages` 整段 + 槽后 items，squash 同角色）；新增消息默认 role system（compiler.ts:301-320）。
- ⚠️ 坑：agent-dir 或项目里出现 `SYSTEM.md`/`APPEND_SYSTEM.md` 会**短路 preset 编译路径**（resource-loader.ts:1035-1050）——禁止放置；preset 文件被删后恢复块匹配不到 → 停在默认 preset（不回退 chooseDefaultPreset）。
- 新会话也落 preset_change：值 = `settings.defaultPreset ?? chooseDefaultPreset(...) ?? "default"`（sdk.ts:472-476）——agent-dir settings 显式 `defaultPreset` 是双保险。

### 2.5 扩展 API 面（2026-08-27 审计，extensions/types.ts）

- **事件**（`on(event, handler)`）：project_trust / resources_discover / session_start / session_info_changed / session_before_fork / session_compact / session_shutdown / session_before_tree / session_tree / leaf_changed / entry_edited / preset_activated / context / before_provider_headers / after_provider_response / before_agent_start / agent_start / agent_end / agent_settled / turn_start / turn_end / message_start / message_update / message_end / tool_execution_start / tool_execution_update / tool_execution_end / model_select / thinking_level_select / tool_call / tool_result / user_bash / input。
- **注册**：`registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer` / `registerEntryRenderer` / `registerCustomType` / `registerMarkdownTransformer` / `registerProvider` / `registerNativeProvider` / `registerSlot` / `registerMacro`。
- **registerTool 签名**（types.ts:480-530）：`{ name, label, description, promptSnippet?, promptGuidelines?, parameters: TSchema(TypeBox), prepareArguments?, executionMode?, execute(toolCallId, params, signal, onUpdate, ctx), renderCall?, renderResult?, constrainedSampling? }`。
- **AgentToolResult**（agent/types.ts:361）：`{ content: (TextContent|ImageContent)[], details, usage?, addedToolNames?, terminate? }`——content 数组与 MCP CallToolResult 同构。
- **参数 schema 是 TypeBox**（`TSchema`），不是 zod。zod→TypeBox 转换或 `prepareArguments` 透传是簇 B 的技术难点。

### 2.6 adapter（pi-mcp-adapter，M1 过渡态）

- 6 层配置优先级，`.pi/mcp.json`（pi 进程 cwd 下的项目覆盖层）最高；`~/.config/mcp/mcp.json` 等全局层仍被读。
- mcp() / directTools / mcpScript / disableProxyTool **全在 adapter 侧**（pi 核心 No MCP）。
- lifecycle `lazy` 首调才 spawn；requestTimeoutMs 省略/≤0 回落 MCP SDK 默认 60s。
- 安装落点 `<agentDir>/npm/node_modules`（package-manager.ts:2047）；M1 用 registry 版 2.27.0。
- adapter spawn MCP 子进程：**cwd = pi 的 cwd、env = pi process.env 副本**（B1 实测）→ 会话身份走 env 即天然会话级。
- **MCP 层是 M1 过渡态**：pi 有 `registerTool`，MCP 中间商（adapter + standalone.js + mcp.json directTools）在簇 B 删除。

### 2.7 Nodesign 现状关键事实（Map + M1 + 审计）

- workspace = `<PROJECTS_DATA_DIR>/<pid>/shared/` **项目级共享**——不是会话私有。
- `ALWAYS_LOAD_TOOLS`（mcp/index.js:108-141，28 项）是 Nodesign 侧常量。
- 本地真实上游 key 在 `~/.nodesign/.env`（profile.js:62-69）。
- model-table 行字段 `api.wireModel` 与 pi wire id 同构；`--model` 部分匹配已实测。
- **M1 生产提示词状态**：agent-dir 唯一 preset 是 `nodesign-base.json`（`autoActivate: false`，内容只有 M0 探针标记）；settings.json 无 `defaultPreset` → `chooseDefaultPreset` 落空 → **回退 pi 内建 pi-default preset**。Nodesign 平台协议（prelude 32.7KB + 注入族 123KB）一个字没进生产。M2 第一步修复。
- 官方 rpc-client 已存在：pi-rp `packages/coding-agent/src/modes/rpc/rpc-client.ts`（42 方法）；Nodesign 移植版 `server/engine/pi/rpc-client.js` 已封装 setPreset / setThinkingLevel / setModel / getSessionStats / getAvailableModels（M1.5 补齐）。setModel/setThinkingLevel 默认传 `persistSettings:false`（不写共享 agent-dir/settings.json，见 §5.2）。

## 3. 目标架构

```
┌─────────────────────────── Nodesign server 进程 ───────────────────────────┐
│  express / ws broker / EventBus / SQLite run 状态机 / projects·auth·tier    │
│                                                                             │
│  engine/pi/                                                                │
│    rpc-client.js    spawn `pi --mode rpc`，JSONL 读写，请求关联，           │
│                     setPreset/setModel/setThinkingLevel                     │
│    event-bridge.js  AgentSessionEvent → EventBus（前端契约不变）            │
│    lifecycle.js     每会话一个 pi 子进程：起/停/崩溃重启/孤儿回收            │
│    sidecar.js       工具回主进程的桥（emit / tier gate / charge / ask）     │
│    model-map.js     appModel → provider/wireModel 反查                     │
│    pi-jsonl.js      会话转录读取（hydrate / auto-name）                     │
│    mcp-config.js    .pi/mcp.json 幂等写（M1 过渡态，簇 B 删）              │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │ stdin/stdout JSONL (RPC)       │ HTTP sidecar（本地回环，token 鉴权）
                ▼                               ▼
┌───────────────────────────────┐   ┌────────────────────────────────────────┐
│ pi 子进程（每会话一个）        │   │ M1 过渡态：nodesign MCP 子进程         │
│ cwd = <pid>/shared/（项目共享）│   │   standalone.js（McpServer + stdio）   │
│ agent dir = engine/pi/agent-dir│   │   54 工具，ctx 三桥走 sidecar          │
│ --session-dir <dataRoot>/pi-   │   │                                        │
│   sessions/<sid>/（仅 JSONL）  │   │ 簇 B 目标态：pi 扩展 registerTool      │
│ -e providers.ts（上游注册）    │   │   nodesign-tools.ts 直接注册 54 工具   │
│ -e guards.ts（安全闸，M2）     │   │   删 standalone.js + adapter + mcp.json│
│ -e nodesign-tools.ts（簇 B）   │   │   directTools                          │
│ .pi → <pid>/shared/.pi         │   │                                        │
│   prompt-presets/（项目级）    │   │                                        │
└───────────────────────────────┘   └────────────────────────────────────────┘
```

设计决策：

- **每会话一个 pi 进程**，不用 `switch_session` 共享：cwd 绑定（session 0 = 进程 cwd）、preset 装配、崩溃隔离都简单；代价是一次进程启动（~2s，可接受）。
- **配置项目级，身份走 env**：preset 文件库是项目级共享（`<pid>/shared/.pi/`，初始化一次）；会话差异（sid/uid/token/workspace）全在 pi 进程 env。**.pi 内禁止任何密钥，密钥一律走 env**。
- **工具面最终走 pi registerTool**（簇 B）：MCP 层（adapter + standalone.js + mcp.json）是 M1 过渡态。pi 扩展 `registerTool` 直接在 pi 进程内执行，零中间商。sidecar 三桥（emit/gate/charge）保留——工具仍需跟主进程通信。
- **模型路由不进主进程**：ingress 整个删掉（§5.2），上游直连，路由语义由 pi provider/model 配置表达。
- **pi 版本两阶段**（2026-08-27 定案）：开发期跟 PATH（`resolvePiBinary()`：`PI_BIN` env → PATH `pi`），pi-rp 正式发版后 vendor/pin。理由：作者是 pi-rp 维护者，开发期跟源码最顺；发版后 pin 保证可复现部署。

## 4. 删除清单

| 组件 | 去向 | 里程碑 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk`（package.json + 所有 `query()` 引用） | 删 | ✅ M1 |
| `server/lib/model-ingress.js` + `lib/ingress/`（路由/换钥/修补/剥残留） | 删 | M3 |
| `engine/agent/hooks.js` + `hooks/`（注入族 + 事件钩子） | 删，安全闸迁 guards 扩展 | M2 第二步 |
| `engine/agent/isolation.js` + `ops/sandbox-shim/`（bwrap 垫片，CC 专属） | 删 | M2 第二步 |
| `engine/agent/system-prompts.js` + `prompts/nodesign-prelude.md` | 迁 preset 单层文件 | M2 第一步 |
| `engine/agent/session-model.js` / `model-table.js` / `model-context.js`（路由表） | models.json 为唯一真相源，model-table 降级 | M3 |
| `engine/agents/*.md`（子代理提示词） | 迁 pi delegatable presets | M2 第二步 |
| `engine/agent/init-contract.js` | 删（改对 pi `session_start` 的装配断言） | M2 第二步 |
| `engine/agent/memory-config.js` | 迁 preset 文本槽 | M2 第二步 |
| `maxTurns`（默认 100，.env 生效 50） | 丢。循环终止靠 pi 自然结束 + auto-compaction + RPC `abort` | ✅ M1 |
| 订阅通道（三层禁用代码 + 前端锁行文案） | 删干净。pi 无 Claude OAuth 传输路径，订阅行永久移除 | M3 |
| `standalone.js` + `pi-mcp-adapter`（99MB）+ `mcp.json` directTools + `@modelcontextprotocol/sdk` | 删。工具改走 pi 扩展 registerTool | 簇 B |
| `permissionMode` 死字段（turn.js:72 解构 + 前端 api.js 兼容字段） | 删 | M3 |
| hooks/isolation/ingress 的测试 | 删 | M3 |
| **保留**：`engine/mcp/` 工具工厂与测试（buildNodesignTools 零改动复用）、`runs/` 状态机、`projects/`、`auth/`、`tier/`、`ws/`（hydrate 数据源已换 pi-jsonl）、`db/`、`runtime/`、`chatai/`、`browse/`、`perception/`、`motion/`、sidecar 三桥 | — | — |

## 5. 组件设计

### 5.1 pi 子进程生命周期

**版本策略**（2026-08-27 定案）：开发期跟 PATH（`resolvePiBinary()`），pi-rp 正式发版后 vendor/pin 进 Nodesign。当前 PATH 上的 pi 指向开发中的 pi-rp checkout（symlink → dist/cli.js）。dist 已于 2026-08-27 重建（set_preset / persistSettings / activePresetId 均已生效）。

**spawn 参数**（`engine/pi/lifecycle.js`，已实现）：

```js
// ⚠️ --config-dir / --settings-file 传相对 cwd 的值（join(cwd,·) 拼绝对路径会坏）；
// --session-dir 可用绝对路径。cwd = <pid>/shared/（项目共享），相对值由 lifecycle 算。
args = [
  '--mode', 'rpc',
  '--approve',
  ...(provider ? ['--provider', provider] : []),
  ...(model ? ['--model', model] : []),
  ...(presetId ? ['--preset', presetId] : []),
  '--config-dir', '.pi',
  '--session-dir', join(dataRoot, 'pi-sessions', sid),
  '--system-prompt', '',                              // 显式无自定义 prompt → preset 编译路径
  '-e', PROVIDERS_EXT,                                // 上游注册
  '-e', ADAPTER_EXT,                                  // M1 过渡态（簇 B 删）
  // '-e', GUARDS_EXT,                                // M2 第二步
  // '-e', NODESIGN_TOOLS_EXT,                        // 簇 B
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  ...(resume ? ['--continue'] : []),
];
env = {
  PI_CODING_AGENT_DIR: AGENT_DIR,
  PI_TELEMETRY: '0',
  NODESIGN_SID: sid, NODESIGN_WORKSPACE: workspaceDir,
  NODESIGN_MAIN_URL: `http://127.0.0.1:${PORT}/__nd-sidecar`,
  NODESIGN_TOKEN: sidToken(sid),
  NODESIGN_DISABLED_TOOLS: disabledTools.join(','),
  ...loadUpstreamKeys(dataRoot),
};
```

- **preset 默认装配**：`agent-dir/prompt-presets/nodesign.json`（`autoActivate:true`）在启动时被 chooseDefaultPreset 选中（唯一 autoActivate）；不传 `--preset` 即默认它。运行中切换走 RPC `set_preset`，写 session JSONL，`--continue` 恢复。**`--preset` 显式传时优先于一切**（含会话恢复）。
- **agent-dir 内容**：`settings.json`（defaultTools 白名单：read/write/edit/grep/find/ls/state_update/get_state，无 bash/subagent；telemetry off；`defaultPreset: "nodesign"` 双保险）、`prompt-presets/nodesign.json`（M2 第一步填全量平台提示词）。**禁止 SYSTEM.md / APPEND_SYSTEM.md**（短路 preset 编译）。
- **项目级 `.pi/`**（`<pid>/shared/.pi/`，项目初始化写一次，多会话共享）：`prompt-presets/`（项目可选 preset，不带 autoActivate）、`mcp.json`（M1 过渡态，簇 B 删）。
- **就绪判定**：无 hello。`prompt` 应答（`response{id}`）或 `get_state` 往返即就绪；prompt 是排队语义，尽早发不丢。
- **kill 链**：`abort` RPC → 5s → SIGTERM → 2s → SIGKILL；异常退出（agent_settled 未收到）→ run 状态机标记 failed，JSONL 在 session-dir 天然可重连续档。

### 5.2 模型接入

- **多上游路由** → `server/engine/pi/extensions/providers.ts`：读 `NODESIGN_UPSTREAM_*` env，`pi.registerProvider(...)`。清单由 `migrate-models.mjs` 从 model-table.js 生成 `providers-models.json`（commit 进仓库）。改模型改 model-table.js，再跑脚本重新生成。
- **env 全家桶 fallback**（2026-08-27 定案）：`NODESIGN_BASE_URL` + `NODESIGN_KEY` + `NODESIGN_MODEL` 三元组作为 fallback——manifest（providers-models.json）里没有匹配的 provider 时才用。manifest 优先，env 全家桶兜底。适合"我就想指一个自己的上游"的简单部署。
- **默认模型 fail-loud**（2026-08-27 定案）：`defaultModel()` 去掉 `claude-sonnet-5[1m]` 硬编码回退。`NODESIGN_MODEL` 未设时报错（不读 pi settings.json——那是 pi 内部配置，Nodesign 不该耦合）。
- **热换模型**（M1.5）：`set_model` RPC 接线。rpc-client.setModel(provider, modelId) + turn-model-switch 合法路径调用 + session meta 持久化（`.nd/<sid>` 模型记录，重启后 `--continue` 不丢）。`piProviderModelFor` 已有 appModel→provider/wireModel 映射。
- **thinking 档位**（M1.5）：`set_thinking_level` RPC 接线。rpc-client 已封装 setThinkingLevel。加 API endpoint + 前端入口。静态配置（providers-models.json 的 `reasoning` 位）保留作默认。
- **context usage**（M1.5）：`get_session_stats` → `SessionStats.contextUsage` 接线。API endpoint + 前端 ContextMeter。
- **计费/失败连击** → guards 扩展挂 `after_provider_response`（M2 第二步）。
- **models.json 唯一真相源**（M3）：model-table.js 的路由字段（baseUrl/keyEnv/wireModel）与业务字段（tier/cost/switching）拆分。models.json 为唯一真相源，业务层直接读它。model-table.js 降级或删除。

### 5.3 工具面

**M1 过渡态**（当前）：
- `.pi/mcp.json`（项目级）：`{"mcpServers": {"nodesign": {command: "node", args: [standalonePath], directTools: [...], lifecycle: "lazy", requestTimeoutMs}}}`
- `standalone.js`：复用 `buildNodesignTools` 工厂产物挂 `@modelcontextprotocol/sdk` McpServer + StdioServerTransport。54 工具全量注册。
- ctx 跨进程：sidecar 三桥（emit → EventBus / tier gate / charge）。
- 身份：standalone 从 env 取（NODESIGN_SID/UID/TOKEN，adapter spawn 继承 pi env）。

**簇 B 目标态**（单独排期）：
- 写 `nodesign-tools.ts` pi 扩展：`pi.registerTool()` 直接注册 54 工具。
- 删 `standalone.js` + `pi-mcp-adapter`（99MB agent-dir/npm/）+ `mcp.json` directTools + `@modelcontextprotocol/sdk` 依赖。
- `buildNodesignTools`（工具工厂）零改动；`tool-shim.js` 零改动；45+ 工具文件零改动。
- sidecar 三桥保留（工具仍需跟主进程通信）。
- **zod→TypeBox 转换**：pi registerTool 的 parameters 是 TypeBox `TSchema`。最简方案：注册时用宽松 TypeBox schema + `prepareArguments` 透传，让 handler 里的 zod parse 做真校验。
- handler 返回值映射：MCP `{ content, isError }` → pi `AgentToolResult { content, details }`——content 数组同构，映射一行代码。

**AskUserQuestion 复刻**（方案 A，2026-08-27 定案）：
- pi 扩展 `registerTool('ask_user_question', ...)`，工具在 pi 进程内执行，**可以无限阻塞**（无 MCP adapter 超时问题）。
- 流程：agent 调用 → execute 里 HTTP POST 到 sidecar `/ask`（新 endpoint，长轮询）→ sidecar emit `run.ask_user_question` → 前端问题卡片 → 用户答 → POST /answer → sidecar 返回 → execute 拿到 answers → 返回 tool result → agent 继续。
- 阻塞语义和 SDK canUseTool 一模一样。
- sidecar 需加 `/ask` + `/answer` 两个 endpoint。

### 5.4 提示词与 preset

**M2 第一步：prelude 迁移**（最小机械迁移 + 标注待改）：
- prelude 32.7KB 全文进 `agent-dir/prompt-presets/nodesign.json`，`autoActivate: true`。
- settings.json 加 `defaultPreset: "nodesign"` 双保险。
- 工具命名 `mcp__nodesign__<tool>` → 裸名（pi directTools 注册的是裸名）。
- 删 ToolSearch 段（pi 无 ToolSearch，directTools 全量常驻可用）。
- 可疑段落（子代理、自验规则等与注入族耦合的）加注释标记，M2 第二步处理。
- 其余逐字保留——prelude 是实战调过的提示词，逐字迁移风险最低，行为回归可归因。

**M2 第二步：注入族 + guards**：
- 注入族静态部分并入 preset；动态内容（画布上下文、pending-changes、记忆）走 rpc-client 的 prompt 消息装配。
- guards.ts 扩展：tool_call 拦截（canvas-validate / site-validate 语义）、`after_provider_response` 计费与失败连击、`before_agent_start` systemPrompt 装配断言、`session_start` 装配断言（init-contract 去向）、rate-limit 判别。
- 删 hooks/ + isolation + init-contract + memory-config。
- agents/*.md → pi delegatable presets。

**项目可选 preset**：`<pid>/shared/.pi/prompt-presets/*.json`，不带 autoActivate，靠 lifecycle `--preset`（spawn 时）或 RPC `set_preset`（运行中）显式选。

**切换与持久化**：setActivePreset 写 session JSONL `preset_change` 条目 → `--continue` 恢复；`preset_activated` 事件（线上）供前端感知。

### 5.5 事件桥与 turn 关联

- **event-bridge.js**：M0 原型已实现并验收（真实 28 行事件重放逐字节一致；12 合成分支全过）。M1 硬化点见附录 C。
- **映射要旨**：`run.start` ← 首个 agent_start；`run.delta.text/thinking` ← message_update 增量（跨块累积）；`run.delta.tool_use/result` ← tool_execution_start/end；`run.compact_boundary` ← compaction_end；`run.done` ← agent_settled（usage 取 message_end 权威终值）；`run.cancelled` ← abort 受理；`run.error/rate_limit` ← guards 判别。
- **turn 关联**：run 认领从 SDK uuid 回显改为 **RPC prompt 命令 id**——每轮唯一 id，`response{id}` 确认受理，agent_settled 收尾。单飞行约束：每进程同一时刻一个 prompt（busy 报错），排队/合并语义落 rpc-client。
- **hydrate 数据源**：ws/index.js hydrate 读 pi session JSONL（pi-jsonl.js），不再走 SDK getSessionMessages。

### 5.6 pi-rp 侧前置变更

**RPC `set_preset` 命令**（✅ 源码已实现，rpc-mode.ts:678）：
- `{"type":"set_preset","presetId":"<id|none>"}` → 调 `session.setActivePreset(id)`。
- 行为：写 session JSONL `preset_change` 条目、同步工具策略、广播 `preset_activated` 线上事件。
- **dist 已重建**（2026-08-27）：set_preset / persistSettings opt-out / get_state.activePresetId 均在 dist 生效。

**交付节奏**（✅ 全部完成）：pi-rp 重建 dist → Nodesign rpc-client 封装 setPreset → `_probe-preset-live.mjs` 验证切换 + `--continue` 恢复 + preset_activated 事件（GATE PASS，2026-08-27）。

## 6. 里程碑

### M0（✅ 2026-08-26，五验收全绿）
- agent dir 装配（settings 白名单 / adapter 装载 / providers 扩展）
- RPC spawn 文本直连（GMI/MiniMax-M3）、autoActivate 生效、agent dir 隔离
- standalone.js 最小版 4 工具 + .pi/mcp.json directTools 全链路（extension_error=0）
- event-bridge 原型 + 真实事件流还原逐字节一致
- 资产：agent-dir/、extensions/providers.ts、mcp/standalone.js、pi/event-bridge.js、_probe-pi-rpc.mjs 等（已 commit 1c7502d）

### M1 工具面 + 事件桥（✅ 2026-08-27）
1. 【前置】pi-rp `set_preset` 命令（源码）+ Nodesign rpc-client 封装 ✅
2. engine/pi/ 七模块：rpc-client.js、lifecycle.js、event-bridge.js 硬化、sidecar.js、pi-jsonl.js、model-map.js、mcp-config.js ✅
3. standalone.js 全量 54 工具 + sidecar 三桥 + adapter 2.27.0 gate ✅（GATE PASS）
4. session-loop.js 换引擎（严格串行 turn）+ sessions.js 旁路删 + ws hydrate 换 JSONL + turn-relay 串行化 ✅
5. CC SDK 依赖移除（tool-shim.js 替 SDK tool()；package.json + lockfile 清零）✅
6. 模型表迁移脚本（model-table → providers/models JSON，wireModel 对齐）✅

**M1 live 探针**（`server/_probe-m1-live.mjs`，GATE PASS）：minimax-m3 双 turn——turn 1 文本复述 marker（run.done，usage 落库 in=40954/out=30）；turn 2 read_board 工具调用经 pi-mcp-adapter → standalone → sidecar gate 全链路（BOARD_READ_OK）。

**M1 已知缺口修正**（2026-08-27 假缺口审计）：
- ~~热换模型~~ → `set_model` RPC 存在，M1.5 修
- ~~context usage~~ → `get_session_stats.contextUsage` 存在，M1.5 修
- ~~thinking 档位~~ → `set_thinking_level` RPC 存在，M1.5 修
- ~~permissionMode~~ → 死字段（plan mode 08-21 已删），M3 清理
- AskUserQuestion / elicitation → pi 真没有，方案 A 复刻（M2 第二步）
- 截断续写 → M1 不做
- 订阅通道 → 永久禁用，M3 删干净

### M1.5 RPC 接线（簇 A）（✅ 2026-08-27）
1. pi-rp 重建 dist（set_preset 生效）✅
2. 热换模型：rpc-client.setModel + turn-model-switch 合法路径 + session meta 持久化 ✅
3. thinking 档位：API endpoint + 前端入口（rpc-client.setThinkingLevel 已有）✅
4. context usage：`get_session_stats.contextUsage` API endpoint + 前端 ContextMeter ✅
5. 默认模型：`defaultModel()` 去掉 `claude-sonnet-5[1m]` 回退，`NODESIGN_MODEL` 未设时报错 ✅（workspace.js MAIN_MODEL 同步去兜底）
6. env 全家桶：`NODESIGN_BASE_URL` + `NODESIGN_KEY` 作为 fallback（manifest 没匹配时才用）✅

**pre-M2 补强**（✅ 2026-08-27，M1.5 收尾 + M2 前置）：
- pi-rp `set_model`/`set_thinking_level` 加 `persistSettings` opt-out（默认 true 不变；Nodesign 传 false，不写共享 agent-dir/settings.json）。`_probe-m15-live.mjs` 加"settings 未被污染"断言。
- pi-rp `get_state` 加 `activePresetId` 字段（preset 可观测）。
- `set_preset` live 验证：`_probe-preset-live.mjs`（切换 + preset_activated 事件 + --continue 恢复）GATE PASS。session-loop onEvent 直接发 `run.preset_activated`（会话级，bridge per-turn 会漏）。
- 前端热换入口：ModelPicker run 飞行中不再禁用，按 activeRun 分流走 `Turn.setRunModel`（POST /runs/:runId/model）。

### M2 提示词收敛（✅ 2026-08-27）

**第一步：prelude 迁移**：
- prelude 32.7KB 全文进 `agent-dir/prompt-presets/nodesign.json`，`autoActivate: true`；
  生成器 `extensions/migrate-prelude.mjs`（改 prelude 改 md 再跑脚本，prelude-render.test.js 钉新鲜度）。
- settings.json 加 `defaultPreset: "nodesign"` 双保险。
- 工具命名 `mcp__nodesign__<tool>` → 裸名；删 ToolSearch 段；可疑段落加 `{{//M2-待改: ...}}` 注释标记。
- 政策块（`nd:policy:full/min` + `{{ADULT_POLICY}}`）抽成 `{{ndPolicy}}` 宏：
  `policy-render.js`（纯函数，模块级缓存 prelude 块）+ `extensions/prompt-support.ts` 注册宏。
  档位 `NODESIGN_ADULT_LEVEL`（off/loose/strict）spawn env 定 —— 热换模型被通路闸锁在
  同 lane（moderation 旋钮不变），空闲换模型是重启新 env，所以 level 是会话常量。
  **uncensored 不再 spawn 定死**：pi-rp 已把 live model 接进 `PromptRuntime`
  （`runtime.model` = `{provider, id}`，commit a3a5a46a2），宏是 dynamic（static:false）
  每轮重展开，拿 `ctx.runtime.model` 现算 wire key 查**无审查集合**。集合 spawn 时由
  主进程从模型表算好经 env `NODESIGN_UNCENSORED_MODELS`（逗号分隔 wire key）交给子进程。
  会话内 `set_model` 热换到无审查模型，下一轮政策节当场翻成 min 版，不用重启 pi 进程。
  fail-closed：liveKey 缺失 / 不在集合 / 集合为空 → 一律 full（拿不到信息绝不落 min）。
- 验证：`_probe-m2-prelude-live.mjs` GATE PASS（启动即 nodesign preset / 便利贴问答命中 notes/ /
  loose·off·uncensored-min 三档政策在场且互斥 / **Phase 4 同会话 live-flip**：turn 1 真模型
  full 政策在场 → set_model 切 fake 无审查模型 → turn 2 的 system prompt 政策节翻成 min 版，
  full 块特征缺席。fake 上游捕获请求 body.system 断言）。

**第二步：注入族 + guards + AskUserQuestion + 子代理**：
- 注入族：静态部分并入 preset；动态内容（工作区状态块 + pendingSummary）走 `turn-state.js`
  在 runTurn 执行时点装配进 prompt 消息（pendingSummary 从 API 时点挪到执行时点，排队消息不带过期状态）。
  懒注入族（首调注入 / 失败建议 / rate-limit）迁 `inject-rules.js`（纯判据）+ `extensions/inject.ts`（薄壳）。
- guards.ts 扩展（安全闸全集）：`guard-rules.js`（项目边界 / 演出隐私 / canvas+site lint 纯判据）
  + `extensions/guards.ts`（tool_call 拦截 fail-open + session_start 装配断言心跳）。
  装配断言 fail-loud 不 fail-block：发非终态 `run.error code=INIT_CONTRACT`（同时是扩展挂载 + sidecar 通路心跳）。
- AskUserQuestion 复刻（方案 A）：`ask-user.ts`（registerTool）+ `ask-registry.js`（挂起/应答登记，promise 安全）
  + sidecar `/ask`（long-poll）`/answer` + turn.js `/answer` 路由（404 NO_PENDING_ASK / 409 ASK_RUN_MISMATCH）
  + 前端 ask 回路（run.ask_user_question 事件消费 + 答案并行数组回流）。
- 子代理：agents/*.md → 4 个 pi delegatable presets（`nd-explorer` / `nd-vision-checker` /
  `nd-ds-extractor` / `nd-tweak-proposer`，`delegatable:true` `autoActivate:false`），
  schemas 镜像进 agent-dir/schemas/；settings.json defaultTools 启用 `subagent` / `subagent_profiles`；
  prelude 子代理段重写为 pi `subagent { profileId, task }` 同步阻塞语法。
- 删除波：hooks/ + hooks.js + isolation + init-contract + memory-config + auto-mode-rules +
  sandbox-shim + system-prompts + agent-shared + task-events + agents/index.js。
  两处活引用先搬再删：`detectArtifact` → `lib/artifact-target.js`；`MEMORY_DIR_NAME` → `projects/workspace-templates.js`。
  （`nodesign-prelude.md` 保留：policy-render.js 模块级读它当政策块真相源。）
- 验证：`_probe-m2-step2-live.mjs` GATE PASS（扩展健康 / 无 EXTENSION_ERROR / INIT_CONTRACT 心跳 /
  activePresetId=nodesign / AskUserQuestion 全链路 ask→answer→续写→最终文本反映所选）。

**回归**：server 822/822 绿（baseline 778，+44；policy live-model 改造 +4：policy-render
liveKey/集合语义 + lifecycle `NODESIGN_UNCENSORED_MODELS` env）；web 425/431（仅 6 个 ChatDock
预存失败，clean tree 同样失败，与 M2 无关）。顺手修一处 HEAD 潜伏 bug：turn.js 用
`Events.projectActiveSession` 但漏 import（被 try/catch 静默吞，project.active_session 广播
一直失效），补 import。

**顺手修一处 env 全家桶潜伏 bug**（Phase 4 live-flip 探针逼出来的）：`providers.ts` 的 custom
provider 注册只给 `{ id, name }`，pi 的 extension registerProvider 路径（applyExtension）对
model 定义是原样 spread，不像 models.json 路径（modelFromJson）会补默认值 —— `input` 缺了就是
undefined，read.ts 的 `model.input.includes("image")` 当场炸（`Cannot read properties of
undefined (reading 'includes')`）。M1.5 只验过同模型 set_model 往返，没真跑过 env 全家桶模型的
turn，所以一直没炸。补全 `reasoning/input/cost/contextWindow/maxTokens`。

**开放项**（非阻塞，M3/簇 B 复评）：
- bash 工具：pi defaultTools 白名单暂不含（prelude 装包/脚本段加 `{{//M2-待改}}` 注释）。
- TaskCreate/TaskUpdate 任务镜像：pi 无任务工具，黑板镜像功能悬空。
- CLAUDE.md / .claude / Skill 引用：prelude 仍提，pi 无对应物（已注释标记）。
- ~~会话内热换 qwen3.8-27b 不变 uncensored 政策~~ → 已修：pi-rp 接 live model 进 PromptRuntime，
  ndPolicy 宏每轮按 runtime.model 查无审查集合，热换即翻转（见上「政策块」条 + Phase 4 探针）。
- `server/ops/fix-sdk-musl.mjs`（postinstall）：SDK 已删，脚本是 no-op，未列入删除清单，留 M3 复评。

### 簇 B 工具管线重构（单独排期）
- 写 nodesign-tools.ts pi 扩展（registerTool + zod→TypeBox）
- 删 standalone.js + pi-mcp-adapter（99MB）+ mcp.json directTools + @modelcontextprotocol/sdk
- buildNodesignTools / tool-shim.js / 45+ 工具文件零改动
- sidecar 三桥保留

### M3 清理回归
- 删 ingress / sandbox-shim / 旧测试
- 重写保留契约测试（tier、参数校验、事件桥、turn 认领）
- 订阅通道删干净（三层禁用代码 + 前端锁行文案）
- models.json 为唯一真相源，model-table.js 降级
- permissionMode 死字段清理
- **rewind 恢复**（2026-08-27 定案）：走 pi 会话树，不造文件 checkpoint。
  - 对话侧：`navigate_tree` RPC——把叶节点移到目标条目回滚位，`summarize:false` 不走 LLM；旧分支保留在树里，可再导航回去/换分支重来。约束：streaming 中拒绝（与 M1 串行 turn 天然契合）。
  - 文件侧：session-loop finishTurn 每 turn 已 `commitWorkspace`（git，author=agent）——rewind 时 `git revert`/checkout 到目标 turn 之前的 commit。
  - 前端：undo 按钮接新后端（navigate_tree + git 回滚）。
- 前端联调（run.delta.* 契约不变确认 + hydrate 回归 + 换 preset 交互）

## 附录 A M0 验证结果与偏差记录（2026-08-26，已并入正文，保留追溯）

> 16 条偏差中：架构级 1 条（workspace 共享 → 配置项目级/身份 env，§2.7/§3）、M1 增负 3 条（ws hydrate、turn-relay、standalone ctx）、其余为命名/配置修正。全部已并入 §2 与 §5。原文偏差表见 git 历史（docs/engine-pi-rp-migration.md@1c7502d 前身），此处不重复。

## 附录 B preset 机制事实核查（6 问，2026-08-26）

见 §2.4 汇总；逐条文件:行号：
- loader.ts:61-83 chooseDefaultPreset 三级回退；loader.ts:29-51 loadPromptPresets 两级扫描 + 同 id 覆盖
- agent-session.ts:1320-1346 _rebuildSystemPrompt 恢复块；1488-1520 setActivePreset；1610-1630 getPresetInjectMessages
- session-manager.ts:69-72 PresetChangeEntry；1113-1123 appendPresetChange
- settings-manager.ts:96 Settings.defaultPreset；772-791 get/setDefaultPreset
- sdk.ts:472-477 新会话记录默认 preset
- rpc-types.ts RpcCommand 联合；rpc-mode.ts set_preset:678
- config.ts:491 CONFIG_DIR_NAME=".pi"
- cli/args.ts:219-224 --preset；commands/builtins.ts:634-680 /preset
- slot-renderers.ts:46-61 13 槽；macro-engine.ts 12 宏
- compiler.ts:96-160 chat-history 锚点；301-320 addSyntheticMessage role system
- resource-loader.ts:1035-1050 SYSTEM.md/APPEND_SYSTEM.md 短路编译
- extensions/types.ts:703-707 PresetActivatedEvent；1298 on("preset_activated")

## 附录 C event-bridge M1 硬化点（B2 遗留）

- run.start 的 model 由 rpc-client 从 spawn 配置/get_state 传入（message_start 的 model 晚到）
- rate-limit 判别现为文本启发式，对真实 provider 错误面复核
- abort 空转时是否回 success:true 需核实（防误发 run.cancelled）
- compaction 失败（result:null+errorMessage）折进 compactMetadata
- toolcall_delta（参数流式）→ run.delta.tool_input、tool_execution_update → run.tool_progress 留 M1
- 流式 usage 是初始快照：前端实时进度需别的来源
- queue_update → run.queue.depth（排队提示）映射未做
- 多 turn 排队：rpc-client 每 turn 新建 bridge（fresh runId），turn_start 重置累积

## 附录 D 防坑清单（执行时对照）

1. `.pi/` 内禁止密钥（全部 env）
2. env 剔除 NODESIGN_MCP_SERVERS（外部 MCP 仍归主进程）
3. adapter 的 mcp-cache.json 缓存：改 mcp.json 定义后必须删（簇 B 删 adapter 后此条作废）
4. 禁止 SYSTEM.md/APPEND_SYSTEM.md（短路 preset 编译）
5. preset 文件删除后恢复块不回退 chooseDefaultPreset（停在默认），删除前确认
6. 每会话 .pi 不烘焙 <sid>
7. anthropic-messages api 直接拿 model.id 发上游：注册 wire id，勿用本地短名
8. pi 0.84.2 无 glob 工具：需要 glob 语义的工具走 registerTool 或确认工具集
9. session-dir 每会话独立 JSONL 是续档/崩溃恢复的唯一事实源——禁止清理
10. `--system-prompt ""` 是 preset 编译路径的触发条件，不要改成不传或传非空值
11. pi-rp dist 落后源码时 set_preset 不可用——重建 dist 后再测 preset 切换（2026-08-27 已重建）
12. 默认模型回退不能是订阅行（M1 订阅通道禁用后必 403）
13. pi 的 setModel/setThinkingLevel 默认写全局 settings.json——共享 agent-dir 的宿主必须传 `persistSettings:false`（Nodesign rpc-client 已默认），否则一个会话的热切换污染所有会话的默认。会话级持久化靠 session JSONL（model_change/thinking_level_change），不受影响。
14. pi extension `registerProvider` 的 model 定义是**原样 spread**（applyExtension），不像
    models.json 路径（modelFromJson）会补默认值 —— `input`/`cost`/`contextWindow`/`maxTokens`
    缺了就是 undefined，read.ts 的 `model.input.includes("image")` 当场炸。注册自定义模型必须
    给全这些字段（providers.ts env 全家桶已补）。
