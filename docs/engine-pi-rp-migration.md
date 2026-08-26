# Engine 替换：CC SDK → pi-rp RPC（定稿 v2）

> 状态：**M1 完成**（2026-08-27）——CC SDK 依赖已移除，pi-rp 为唯一执行引擎；live 探针 GATE PASS，
> `npm run test:server` 778/778 全绿。M0 探针全绿（2026-08-26）。M2/M3 待用户放行。
> 目标：把 `@anthropic-ai/claude-agent-sdk`（`query()` 子进程）整个摘掉，agent loop 交给 pi-rp
> （`pi --mode rpc`），工具面走 pi-mcp-adapter 接 Nodesign 自己的 MCP server。
> 作者同时是 pi-rp 维护者：pi-rp 侧的缺口就地补（见 §5.6），不做版本防御。

## 1. 动机

1. CC SDK 的隐形提示词（`claude_code` preset ~27.7KB、SDK 硬注入残留、`CLAUDE_CODE_*` env 行为）改不掉、剥不净，`sdkPreset='replace'` 也只能换掉 systemPrompt 字段。
2. Nodesign 在 SDK hooks 上叠加的注入族（pre-injectors / user-prompt-submit / post-guidance / canvas-validate / site-validate / failure / subagent-report…）越滚越厚，成了第二层隐形提示词。
3. pi-rp 有可见的 prompt preset 体系、原生 skills/subagent、RPC 模式、扩展 API——提示词变成**能读的文件**，安全闸变成**显式 hook 代码**。

## 2. 已验证事实（M0 探针 + preset 机制核查，2026-08-26）

> 来源：M0 四路调研（scout）+ 两波探针（REPORT 于 /tmp/nd-m0-probe/）+ preset 机制 6 问源码核查。全部标来源；与正文冲突处以此节为准。

### 2.1 RPC 协议面（PiRpSrc + REPORT）

- 线上事件是 `AgentSessionEvent`：agent_start / turn_start / message_start / message_update / message_end / turn_end / agent_end / agent_settled / tool_execution_start / tool_execution_update / tool_execution_end / compaction_start / compaction_end / extension_error / error 等。**无 hello 启动消息**；session_start / session_shutdown / session_compact 是**扩展 API 事件，不走 RPC 线上**。
- 所有命令支持可选 `id` 做请求-响应关联（`response{id}`）；**事件不带 id**，靠顺序 + 状态机（agent_settled 收尾）。
- 实测事件序列：`response{id:req-1}` → agent_start → turn_start → message_start/end(user) → message_start(assistant) → message_update{thinking_start/delta/end, text_start/delta/end} → message_end(stopReason, usage) → turn_end → agent_end{willRetry} → agent_settled。
- 思考走 thinking_delta、正文走 text_delta；跨块（contentIndex）累积后与 `get_last_assistant_text` **逐字节一致**（B2 重放 28 行真实事件验证）。
- prompt 命令是排队语义：启动未完成也能缓冲、不丢。
- pi 冷启 1.3–1.8s（无 adapter；带 adapter 时首事件窗口更大）；首消息总耗时 ~8s（其中冷启 ~1.75s）。

### 2.2 路径与配置语义（PiRpSrc④⑤ + REPORT 踩坑 2 + 本次核查）

- `--config-dir` / `--settings-file` 按 `join(cwd, 值)` 拼接，**绝对路径拼坏**；`--session-dir` 绝对路径直通（normalizePath）。相对值里带 `..` 会被 join 归一化（worldlines 已验证）。
- `--settings-file` 所在目录**不被**扫描 presets/extensions（help 文案与实现不符，settings-manager.ts:219）。settings 差异走 agent-dir/settings.json（global scope）。
- `PI_CODING_AGENT_DIR` 专用 agent dir 隔离生效；`PI_TELEMETRY=0` 关遥测；RPC 必须 `--approve`（否则 .pi 资源被忽略）；`--no-extensions` 不影响 `-e`。
- pi 0.84.2 内建工具：read / bash / edit / write / grep / find / ls + state_update / get_state + subagent / subagent_profiles（**无 glob**）；settings.json `defaultTools` 白名单可排除 bash/subagent。

### 2.3 preset 机制（本次 6 问核查，全文见附录 B）

- **文件库两级**：agentDir/prompt-presets（先）+ cwd/.pi/prompt-presets（后）；同 id 项目覆盖全局（保持全局槽位位置）。
- **选择**：`chooseDefaultPreset` 三级回退——preferredId → 首个 `autoActivate:true` → 首个 `autoActivate !== false` → undefined（落内建 pi-default）。**autoActivate:true 只在启动选默认用；有它在场时缺省 autoActivate 的 preset 不会被自动选中**。
- **激活与恢复**：`_rebuildSystemPrompt` 按 `会话 JSONL 最新 preset_change 条目 ?? settings.json defaultPreset ?? chooseDefaultPreset` 定 `_activePreset`。切换写 session JSONL（`preset_change` 条目，必写）；settings.json `defaultPreset` **只在切到 none/off/default 禁用分支才写**。
- **切换入口现状**：交互式 `/preset`、CLI `--preset <id>`、SDK `options.preset`——**RPC 层无 preset 命令**（`reload_prompts` 只重扫 prompt 模板）。→ 已定：给 pi-rp 加 RPC `set_preset`（§5.6）。
- `--preset <id>` spawn 时经 `setActivePreset(persistSettings:false)` → `_presetExplicitlyActivated=true` → **优先于会话恢复块**（重启换 preset 的语义依据）。
- 格式：items 只有 block / slot 两种，**无继承机制**；13 内置槽（slot-renderers.ts:46-61）；12 内建宏（date/time/cwd/lastUserMessage/tools/selectedTools/activeModel/setvar/addvar/getvar/trim/user，`{{name}}` / `{{name:param}}`）；`hiddenOverrides`（continueText / compaction 文案可覆盖）；扩展 API 有 registerSlot / registerMacro / compilePreset / `on("preset_activated")`，**无 setActivePreset**。
- 编译语义：compileMessages 以 **chat-history 槽为锚点**（槽前 items + `agent.state.messages` 整段 + 槽后 items，squash 同角色）；新增消息默认 role system（compiler.ts:301-320）。
- ⚠️ 坑：agent-dir 或项目里出现 `SYSTEM.md`/`APPEND_SYSTEM.md` 会**短路 preset 编译路径**（resource-loader.ts:1035-1050）——禁止放置；preset 文件被删后恢复块匹配不到 → 停在默认 preset（不回退 chooseDefaultPreset）。
- 新会话也落 preset_change：值 = `settings.defaultPreset ?? chooseDefaultPreset(...) ?? "default"`（sdk.ts:472-476）——agent-dir settings 显式 `defaultPreset` 是双保险。

### 2.4 adapter（pi-mcp-adapter，Adapter + REPORT）

- 6 层配置优先级，`.pi/mcp.json`（pi 进程 cwd 下的项目覆盖层，`getProjectConfigDirName() = PI_PROJECT_CONFIG_DIR 或 .pi`）最高；`~/.config/mcp/mcp.json` 等全局层仍被读。
- mcp() / directTools / mcpScript / disableProxyTool **全在 adapter 侧**（pi 核心 No MCP）。
- lifecycle `lazy` 首调才 spawn；无 keepAlive 布尔位，重连走 `lifecycle: "keep-alive"`（30s 健康检查）+ `lazy-keep-alive`；requestTimeoutMs 省略/≤0 回落 MCP SDK 默认 60s。
- 安装落点 `<agentDir>/npm/node_modules`（package-manager.ts:2047）；vendored v2.20.1 已验证完整走通 加载→配置发现→stdio connect→元数据缓存→registerTool 直挂→tool_execution_start/end（@earendil-works 旧依赖不影响工具路径）；production 用 registry 版 2.27.0 复跑同款探针全绿再切。
- adapter spawn MCP 子进程：**cwd = pi 的 cwd、env = pi process.env 副本**（B1 实测）→ 会话身份走 env 即天然会话级。

### 2.5 Nodesign 现状关键事实（Map + 本次）

- `ws/index.js:19` import SDK `getSessionMessages`（hydrate 数据源，L205-207）；`sessions.js:19` 同——hydrate/fork/rename/delete 全走 SDK session API。**「ws 不用动」不成立**，数据源必须换。
- workspace = `<PROJECTS_DATA_DIR>/<pid>/shared/` **项目级共享**（getSessionWorkspace 里 sessionId 只校验不参与路径）——不是会话私有。
- session-loop 默认 `maxTurns = 100`（`Number(env)||100`），.env `NODESIGN_MAX_TURNS=50` 让生效值=50。
- turn 认领依赖 SDK `--replay-user-messages` uuid 回显（turn-relay.js claimRunByUuid：current/promoted/merged）——pi 无此机制。
- `ALWAYS_LOAD_TOOLS`（mcp/index.js:108-141，28 项）是 Nodesign 侧常量，adapter 侧无对应物。
- `createNodesignMcpServer` 工厂与 handler 深度耦合 SDK（createSdkMcpServer + tools/ 约 37 文件 import SDK tool()，param-sanitizer.test.js 同）——「换传输零改动」不成立。
- 本地真实上游 key 在 `~/.nodesign/.env`（profile.js:62-69；仓库 .env 只有陈旧 NODESIGN_MODEL=kimi-k2.6）。
- model-table 行字段 `api.wireModel` 与 pi wire id 同构；`--model` 部分匹配已实测（注册 `MiniMaxAI/MiniMax-M3`、传 `minimax-m3` 命中）。
- 官方 rpc-client 已存在：pi-rp `packages/coding-agent/src/modes/rpc/rpc-client.ts`（42 方法，id=req_N 关联）；worldlines-rivet `vendor/pi-rp/` 有同构 vendored 副本。

## 3. 目标架构

```
┌─────────────────────────── Nodesign server 进程 ───────────────────────────┐
│  express / ws broker / EventBus / SQLite run 状态机 / projects·auth·tier    │
│                                                                             │
│  engine/pi/                                                                │
│    rpc-client.js    spawn `pi --mode rpc`，JSONL 读写，请求关联，setPreset   │
│    event-bridge.js  AgentSessionEvent → EventBus（前端契约不变，M0 原型已验）│
│    lifecycle.js     每会话一个 pi 子进程：起/停/崩溃重启/孤儿回收            │
│    sidecar.js       MCP 子进程回主进程的桥（emit / tier / 项目配置）        │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │ stdin/stdout JSONL (RPC)       │ HTTP sidecar（本地回环，token 鉴权）
                ▼                               ▼
┌───────────────────────────────┐   ┌────────────────────────────────────────┐
│ pi 子进程（每会话一个）        │   │ nodesign MCP 子进程（每会话一个，adapter│
│ cwd = <pid>/shared/（项目共享）│   │ 懒启动）                               │
│ agent dir = engine/pi/agent-dir│   │ engine/mcp/standalone.js               │
│ --session-dir <dataRoot>/pi-   │   │   （复用 createNodesignMcpServer 工厂  │
│   sessions/<sid>/（仅 JSONL）  │   │    产物 + StdioServerTransport）        │
│ pi-mcp-adapter 扩展（client）  │   │ 身份从 env 取（NODESIGN_SID/UID/TOKEN） │
│ ── mcp() 代理 / directTools ──┼──▶│ tools/ 28 工具（ALWAYS_LOAD_TOOLS）     │
│                                │   │ ctx 三桥：emit→sidecar / tier+项目配置 │
│ .pi → <pid>/shared/.pi         │   │   / 主进程内存态（M1 sidecar.js）       │
│   prompt-presets/（项目级）    │   │                                        │
│   mcp.json（项目级共享）       │   │                                        │
└───────────────────────────────┘   └────────────────────────────────────────┘
```

设计决策：

- **每会话一个 pi 进程**，不用 `switch_session` 共享：cwd 绑定（session 0 = 进程 cwd）、preset 装配、崩溃隔离都简单；代价是一次进程启动（~2s，可接受）。
- **配置项目级，身份走 env**：mcp.json / preset 文件库是项目级共享（`<pid>/shared/.pi/`，初始化一次）；会话差异（sid/uid/token/workspace）全在 pi 进程 env，adapter spawn 继承 → standalone 子进程天然拿到会话身份。**.pi 内禁止任何密钥，密钥一律走 env**。
- **Nodesign 工具用 stdio MCP**：每会话进程天然携带身份，adapter 按 `.pi/mcp.json` 懒拉起，不需要常驻 HTTP + 会话路由。
- **模型路由不进主进程**：ingress 整个删掉（§5.2），上游直连，路由语义由 pi provider/model 配置表达。

## 4. 删除清单（用户已拍板）

| 组件 | 去向 |
|---|---|
| `@anthropic-ai/claude-agent-sdk`（package.json + 所有 `query()` 引用） | 删（M1） |
| `server/lib/model-ingress.js` + `lib/ingress/`（路由/换钥/修补/剥残留） | 删（M3） |
| `engine/agent/hooks.js` + `hooks/`（注入族 + 事件钩子） | 删（M2），安全闸迁 §5.4 guards |
| `engine/agent/isolation.js` + `ops/sandbox-shim/`（bwrap 垫片，CC 专属） | 删（M2） |
| `engine/agent/system-prompts.js` + `prompts/nodesign-prelude.md` | 迁 preset 单层文件（§5.4，M2） |
| `engine/agent/session-model.js` / `model-table.js` / `model-context.js`（路由表） | 迁 pi provider 配置（§5.2，M1 迁移脚本） |
| `engine/agents/*.md`（子代理提示词） | 迁 pi delegatable presets（M2） |
| `engine/agent/init-contract.js` | 删（改对 pi `session_start` 的装配断言，M2） |
| `engine/agent/memory-config.js`（`CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` env） | 迁 preset 文本槽（M2） |
| `maxTurns`（默认 100，.env 生效 50） | 丢。循环终止靠 pi 自然结束 + auto-compaction + RPC `abort` |
| hooks/isolation/ingress 的测试（`hooks/*.test.js`、`isolation.test.js`、tier.test.js 里针对 query 的断言等） | 删（M3） |
| **保留**：`engine/mcp/` 工具工厂与测试（standalone 复用产物）、`runs/` 状态机（turn 认领改 prompt id）、`projects/`、`auth/`、`tier/`、`ws/`（透传层留，hydrate 数据源换）、`db/`、`runtime/`、`chatai/`、`browse/`、`perception/`、`motion/` | — |

## 5. 组件设计

### 5.1 pi 子进程生命周期

**运行时 pin**：Nodesign 自持 pi 版本（agent-dir 同级安装或 vendor），不依赖全局 PATH——理由：① 防 harness 目录污染（专用 agent dir）；② §5.6 的 `set_preset` 命令需要 pin 含它的版本；③ 可复现部署。版本对齐：pi-rp 发版后升级，先在测试环境复跑 M0 探针。

**spawn 参数**（`engine/pi/lifecycle.js`，参照 worldlines `writerLaunch` 约定 + M0 实测）：

```js
// ⚠️ --config-dir / --settings-file 传相对 cwd 的值（join(cwd,·) 拼绝对路径会坏）；
// --session-dir 可用绝对路径。cwd = <pid>/shared/（项目共享），相对值由 lifecycle 算。
export function sessionLaunch({ sid, workspaceDir, dataRoot, resume, provider, model, presetId }) {
  const rel = (abs) => path.relative(workspaceDir, abs) || '.';
  const args = [
    '--mode', 'rpc',
    '--approve',
    ...(provider ? ['--provider', provider] : []),
    ...(model ? ['--model', model] : []),
    ...(presetId ? ['--preset', presetId] : []),       // 会话/项目显式指定时（§5.4）
    '--config-dir', '.pi',                             // 项目级配置目录（presets / mcp.json）
    '--session-dir', join(dataRoot, 'pi-sessions', sid), // 绝对路径直通；不含 .pi
    '-e', join(NODESIGN_SRC, 'server/engine/pi/extensions/guards.ts'),
    '-e', join(NODESIGN_SRC, 'server/engine/pi/extensions/providers.ts'),
    ...BASE_FLAGS,                                     // --system-prompt "" --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
    ...(resume ? ['--continue'] : []),
  ];
  const env = {
    PI_CODING_AGENT_DIR: AGENT_DIR,                    // 专用 agent dir（唯一入口）
    PI_TELEMETRY: '0',
    NODESIGN_SID: sid, NODESIGN_WORKSPACE: workspaceDir,
    NODESIGN_MAIN_URL: `http://127.0.0.1:${PORT}/__nd-sidecar`,
    NODESIGN_TOKEN: sidToken(sid),
    ...loadUpstreamKeys(dataRoot),                     // ~/.nodesign/.env 的 NODESIGN_UPSTREAM_*（hosted 从部署 env）
  };
  return { args, env };
}
```

- **preset 默认装配**：全局 `agent-dir/prompt-presets/nodesign.json`（`autoActivate:true`）在启动时被 chooseDefaultPreset 选中（唯一 autoActivate）；不传 `--preset` 即默认它。运行中切换（§5.6）写 session JSONL，`--continue` 恢复。**`--preset` 显式传时优先于一切**（含会话恢复）——重启换 preset 的语义。
- **agent-dir 内容**：`settings.json`（defaultTools 白名单：read/write/edit/grep/find/ls/state_update/get_state，无 bash/subagent；telemetry off；`defaultPreset: "nodesign"` 双保险）、`package.json`（pi-mcp-adapter 声明）、`npm/node_modules/pi-mcp-adapter`（正规安装，gitignore）、`prompt-presets/nodesign.json`（M2 填全量平台提示词）。**禁止 SYSTEM.md / APPEND_SYSTEM.md**（短路 preset 编译）。
- **项目级 `.pi/`**（`<pid>/shared/.pi/`，项目初始化写一次，多会话共享）：`prompt-presets/`（项目可选 preset，不带 autoActivate，靠 lifecycle `--preset` 指定或 RPC set_preset 切换）、`mcp.json`（§5.3，项目级共享）。
- **就绪判定**：无 hello。`prompt` 应答（`response{id}`）或 `get_state` 往返即就绪；prompt 是排队语义，尽早发不丢。
- **kill 链**：`abort` RPC → 5s → SIGTERM → 2s → SIGKILL；异常退出（agent_settled 未收到）→ run 状态机标记 failed，JSONL 在 session-dir 天然可重连续档。

### 5.2 模型接入（ingress 删除后）

- **多上游路由 / 换钥** → `server/engine/pi/extensions/providers.ts`：读 `NODESIGN_UPSTREAM_*` env，`pi.registerProvider(...)`（api: "anthropic-messages" + baseUrl + models）。M0 已验：GMI 直连、wire id 注册（`MiniMaxAI/MiniMax-M3`）、`--model` 短 id 部分匹配命中、鉴权双头兼容（x-api-key/Bearer）、baseUrl 不带 `/v1`。
- **模型表迁移**：M1 一次性脚本，把 model-table.js 条目（`api.wireModel`、baseUrl、keyEnv）生成 providers 扩展的模型清单；Nodesign 侧继续传短 id。
- **thinking 修补 / strip** → 模型配置的 `thinkingLevelMap` + `reasoning` 位（静态留模型配置）；运行时调档走 RPC `set_thinking_level`（`set_model` 无 thinking 参数）。
- **计费/失败连击** → guards 扩展挂 `after_provider_response`（`before_provider_response` 不存在；实际是 before_provider_request / before_provider_headers / after_provider_response）。

### 5.3 工具面（MCP）

- **`.pi/mcp.json`（项目级）**：`{"mcpServers": {"nodesign": {command: "node", args: [standalonePath], directTools: [...ALWAYS_LOAD_TOOLS 28 项], lifecycle: "lazy", requestTimeoutMs}}}`——M0 已验 directTools 全白名单位直挂裸名工具全链路。lifecycle 值 M1 定（倾向 lazy；keep-alive 是 30s 健康检查+自动重连，会话短命场景收益小）。
- **standalone.js**（M0 版已探通 4 工具：screenshot_canvas / read_board / web_search / pin_to_board）：复用 `createNodesignMcpServer` 工厂产物（纯描述对象）挂 `@modelcontextprotocol/sdk` McpServer + StdioServerTransport；M1 扩展全量 28 工具。**ctx 跨进程**：tier 闸/emit/身份由 sidecar 三桥替代（M1）：
  1. `ctx.emit` → sidecar → EventBus（事件富化 runId/sessionId/ts 对齐 AgentContext.emit）；
  2. 只读项目配置 / tier / owner（复用 getProject / getUserById）；
  3. 主进程内存态（按需）。文件型 store（board 文件、pending-changes 落盘）直接读盘，不经 sidecar。
- **身份**：standalone 从 env 取（NODESIGN_SID/UID/TOKEN，adapter spawn 继承 pi env）；不安全数据统一经 sidecar 校验。
- **MCP 配置注入**：探针/生产 env 必须剔除 `NODESIGN_MCP_SERVERS`（避免把 Nodesign 的 MCP 外部配置带进 pi）；外部 MCP（`external.js`，NODESIGN_MCP_SERVERS）仍由主进程管理，不改。
- **adapter 版本 gate**：M1 第一道——正规安装 `pi-mcp-adapter@2.27.0`（替换 vendored symlink）→ 复跑 M0 同款 MCP 工具探针 → 全绿再继续；vendored 2.20.1 为回退。

### 5.4 提示词与 preset（单层模型）

- **一个完整 preset = 全部提示词**：`agent-dir/prompt-presets/nodesign.json`（autoActivate:true）= Nodesign 平台默认，唯一 autoActivate。内容 = nodesign-prelude 全量 + 原注入族静态部分（M2 并成一份）。13 槽 / 12 宏随用；prelude 内容放 chat-history 槽之前（编译时槽前items + messages 整段 + 槽后items）。
- **项目可选 preset**：`<pid>/shared/.pi/prompt-presets/*.json`，不带 autoActivate，会话要用靠 lifecycle `--preset`（spawn 时）或 RPC `set_preset`（运行中）显式选。
- **切换与持久化**：setActivePreset 写 session JSONL `preset_change` 条目 → `--continue` 恢复；`preset_activated` 事件（线上）供前端感知。settings `defaultPreset` 只在禁用分支写，Nodesign 用 agent-dir settings 显式设 `defaultPreset: "nodesign"` 双保险。
- **动态内容不进 preset**：画布上下文、pending-changes、记忆等 CC 时代注入族每次拼的内容 → rpc-client 的 prompt 消息装配（M2 迁注入族时定接口，project.prelude 风格 override 或 steer 消息）。
- **guards 扩展**（guards.ts）：迁移安全闸——tool_call 拦截（等价 PostToolUse/PreToolUse 的校验与 site-validate/canvas-validate 语义）、`after_provider_response` 计费与失败连击、`before_agent_start` systemPrompt 装配断言、`session_start` 装配断言（init-contract 去向）、rate-limit 判别（error 事件 + auto_retry 耗尽，M1 复核真实 provider 错误面）。
- **子代理**：`engine/agents/*.md` → pi delegatable presets（M2）。Settings 白名单已排除 subagent；确需时按 preset `tools.allow` 开。

### 5.5 事件桥与 turn 关联

- **event-bridge.js**：M0 原型已实现并验收（真实 28 行事件重放逐字节一致；12 合成分支全过：compaction 成功/失败、工具成败、extension_error→run.error、auto_retry 耗尽 429→run.rate_limit / 5xx→run.error、prompt 受理失败→run.error、abort→run.cancelled 且不再发 run.done、text+thinking round-trip、stopReason=error→run.error）。M1 硬化点见附录 C。
- **映射要旨**：`run.start` ← 首个 agent_start（auto-retry 重复 agent_start 只发一次）；`run.delta.text/thinking` ← message_update 增量（跨块累积）；`run.delta.tool_use/result` ← tool_execution_start/end（toolCallId→blockId 配对去重，双路径 toolcall_end/tool_execution_start 已处理）；`run.compact_boundary` ← compaction_end（compaction_start 发 run.status 代理 isCompacting）；`run.done` ← agent_settled（usage 取 message_end 权威终值——流式 usage 是初始快照不更新）；`run.cancelled` ← abort 受理；`run.error/rate_limit` ← §5.4 guards 判别。
- **turn 关联**：run 认领从 SDK uuid 回显改为 **RPC prompt 命令 id**——每轮唯一 id，`response{id}` 确认受理，agent_settled 收尾；turn-relay.js claimRunByUuid 改造。单飞行约束：每进程同一时刻一个 prompt（busy 报错），排队/合并语义落 rpc-client。
- **hydrate 数据源**：ws/index.js hydrate 改读 pi session JSONL（解析 assistant 消息 / tool 结果还原历史），不再走 SDK getSessionMessages；sessions.js 的 fork/rename/delete 同时改造（M1）。

### 5.6 pi-rp 侧前置变更（M1 阻塞项，作者就地修）

**RPC `set_preset` 命令**：`{"type":"set_preset","presetId":"<id|none>"}` →
- 调 `session.setActivePreset(id)`（复用 `/preset` 命令逻辑，builtins.ts:634-680；`persistSettings` 保留「仅禁用分支写 settings」语义不变）；
- 行为：写 session JSONL `preset_change` 条目、同步工具策略（_syncActiveToolPolicy）、广播 `preset_activated` 线上事件；
- 响应：`response{id, success}`；未知 id → success:false + error；agent 运行中（单飞行）时行为与排队语义由实现定，M1 验证；
- 配套：rpc-types.ts 命令联合 + modes/rpc 处理 + rpc-client.ts 加 `setPreset` 方法（Nodesign 移植版同步）。

**交付节奏**：pi-rp 合并发版 → Nodesign pin 新版本（§5.1 运行时 pin）→ rpc-client 封装 `setPreset` → 探针验证切换 + `--continue` 恢复 + preset_activated 事件。在发版前，lifecycle 先支持 `--preset`（spawn 时选择）不阻塞主线。

## 6. 里程碑（M0 ✅；M1 ✅ 2026-08-27；M2–M3 待用户放行）

### M0（✅ 2026-08-26，五验收全绿）
- agent dir 装配（settings 白名单 / adapter 装载 / providers 扩展）
- RPC spawn 文本直连（GMI/MiniMax-M3）、autoActivate 生效、agent dir 隔离
- standalone.js 最小版 4 工具 + .pi/mcp.json directTools 全链路（extension_error=0）
- event-bridge 原型 + 真实事件流还原逐字节一致
- 资产：agent-dir/、extensions/providers.ts、mcp/standalone.js、pi/event-bridge.js、_probe-pi-rpc.mjs 等（已 commit 1c7502d）；REPORT 于 /tmp/nd-m0-probe/

### M1 工具面 + 事件桥（✅ 2026-08-27）
1. 【前置】pi-rp `set_preset` 命令（§5.6）+ Nodesign pin 版本 ✅
2. engine/pi/ 四模块：rpc-client.js、lifecycle.js、event-bridge.js 硬化、sidecar.js ✅（+ pi-jsonl.js、model-map.js、mcp-config.js）
3. standalone.js 全量 54 工具 + sidecar 三桥 + adapter 2.27.0 gate ✅（GATE PASS：read_board 往返，extension_error=0）
4. session-loop.js 换引擎（严格串行 turn）+ sessions.js 旁路删 + ws hydrate 换 JSONL + turn-relay 串行化 ✅
5. CC SDK 依赖移除（tool-shim.js 替 SDK tool()；createSdkMcpServer/createNodesignMcpServer 删除；package.json + lockfile 清零）✅
6. 模型表迁移脚本（model-table → providers/models JSON，wireModel 对齐）✅

**M1 live 探针**（`server/_probe-m1-live.mjs`，GATE PASS）：minimax-m3 双 turn——turn 1 文本复述 marker（run.done，usage 落库 in=40954/out=30）；turn 2 read_board 工具调用经 pi-mcp-adapter → standalone → sidecar gate 全链路（BOARD_READ_OK）。事件流：run.query.start / run.start / delta.thinking / delta.text / tool_use / tool_result / run.done / queue.depth / query.end 全在。

**M1 已知缺口**（代码内注释留档，M2/M3 处理）：AskUserQuestion/elicitation、rewind、热换模型、截断续写、background turns、context usage 事件、permissionMode 同步、maxTurns、ingress usage、hooks/isolation/plugins/systemPrompt 组装（M2）、thinking 档位配置。订阅通道 M1 整体禁用（三层防御：turn.js 403 / session-loop init 抛错 / selectableModelsFor 锁行）。

### M2 提示词收敛
- nodesign.json 单层完整 preset（prelude 全量 + 注入族静态部分并档）+ 项目可选 preset
- guards 扩展（安全闸全集：工具拦截 / 计费 / 失败连击 / 装配断言 / rate-limit）
- 删注入族 hooks/；删 isolation / init-contract / memory-config
- agents/*.md → delegatable presets；动态注入接口定（§5.4）

### M3 清理回归
- 删 ingress / sandbox-shim / 旧测试（hooks×7、isolation、ingress、tier 中 query 断言）
- 重写保留契约测试（tier、参数校验、事件桥、turn 认领）
- 前端联调（run.delta.* 契约不变确认 + hydrate 回归 + 换 preset 交互）
- **rewind 恢复（用户决策 2026-08-27）**：走 pi 会话树，不造文件 checkpoint。
  - 对话侧：`navigate_tree` RPC（rpc-mode.ts:863，注释原话 "used by the writer process to rewind"）——
    把叶节点移到目标条目回滚位，`summarize:false` 不走 LLM；旧分支保留在树里，可再导航回去/换分支重来。
    约束：streaming 中拒绝（须等 turn 结束，与 M1 串行 turn 天然契合）；目标 id 用 `get_tree` 的条目 id。
  - 文件侧：session-loop finishTurn 每 turn 已 `commitWorkspace`（git，author=agent）——
    rewind 时 `git revert`/checkout 到目标 turn 之前的 commit，数据已在，pi 无需参与。
  - 前端：M1 期间 undo 按钮保留（点击 → 501 toast），M3 联调时一并接新后端。
    已知毛刺：pi-jsonl 映射的 uuid 是 UUID 形态，`canRewindMessage` 门控仍放行 → 按钮可见但必失败。

## 附录 A　M0 验证结果与偏差记录（2026-08-26，已并入正文，保留追溯）

> 16 条偏差中：架构级 1 条（workspace 共享 → 配置项目级/身份 env，§2.5/§3）、M1 增负 3 条（ws hydrate、turn-relay、standalone ctx）、其余为命名/配置修正。全部已并入 §2 与 §5。原文偏差表见 git 历史（docs/engine-pi-rp-migration.md@1c7502d 前身），此处不重复。

## 附录 B　preset 机制事实核查（6 问，2026-08-26）

见 §2.3 汇总；逐条文件:行号：
- loader.ts:61-83 chooseDefaultPreset 三级回退；loader.ts:29-51 loadPromptPresets 两级扫描 + 同 id 覆盖
- agent-session.ts:1320-1346 _rebuildSystemPrompt 恢复块（preset_change ?? settings.defaultPreset ?? chooseDefaultPreset）；1488-1520 setActivePreset（persistSettings 仅禁用分支）；1610-1630 getPresetInjectMessages
- session-manager.ts:69-72 PresetChangeEntry；1113-1123 appendPresetChange；1045-1072 落盘 JSONL
- settings-manager.ts:96 Settings.defaultPreset；772-791 get/setDefaultPreset
- sdk.ts:472-477 新会话记录默认 preset；509-519 options.preset
- rpc-types.ts RpcCommand 联合（无 preset 命令）；reload_prompts:102；rpc-mode.ts:921-926
- config.ts:491 CONFIG_DIR_NAME=".pi"；512-514 getProjectConfigDir；539-545 getAgentDir
- cli/args.ts:219-224 --preset；commands/builtins.ts:634-680 /preset
- slot-renderers.ts:46-61 13 槽；macro-engine.ts 12 宏；types.ts PromptPresetItem（无 inherit）
- compiler.ts:96-160 chat-history 锚点；301-320 addSyntheticMessage role system
- default-stack.ts pi-default（autoActivate:true）
- resource-loader.ts:1035-1050 SYSTEM.md/APPEND_SYSTEM.md 短路编译
- extensions/types.ts:703-707 PresetActivatedEvent；1298 on("preset_activated")；361-368 registerSlot/registerMacro；1585-1589 compilePreset

## 附录 C　event-bridge M1 硬化点（B2 遗留）

- run.start 的 model 由 rpc-client 从 spawn 配置/get_state 传入（message_start 的 model 晚到）
- rate-limit 判别现为文本启发式，对真实 provider 错误面复核（上游可能无 429/'rate_limit' 字样）
- abort 空转时是否回 success:true 需核实（防误发 run.cancelled），必要时加「turn 活跃」门控
- compaction 失败（result:null+errorMessage）折进 compactMetadata，M1 定是否单独 run.error
- toolcall_delta（参数流式）→ run.delta.tool_input、tool_execution_update → run.tool_progress 留 M1
- 流式 usage 是初始快照：前端实时进度需别的来源（provider 自报或 message_end 后补发）
- queue_update → run.queue.depth（排队提示）映射未做
- 多 turn 排队：rpc-client 每 turn 新建 bridge（fresh runId），turn_start 重置累积

## 附录 D　防坑清单（M1-M3 执行时对照）

1. `.pi/` 内禁止密钥（全部 env）；mcp.json 对代理可见，不放敏感配置
2. env 剔除 NODESIGN_MCP_SERVERS（外部 MCP 仍归主进程）
3. adapter 的 mcp-cache.json 缓存：改 mcp.json 定义后必须删（否则 direct tools 不刷新）；属 agent-dir 运行时状态，与 auth.json/models-store.json 同待遇（已 gitignore）
4. 禁止 SYSTEM.md/APPEND_SYSTEM.md（短路 preset 编译）
5. preset 文件删除后恢复块不回退 chooseDefaultPreset（停在默认），删除前确认
6. 每会话 .pi 不烘焙 <sid>——已有任何此类残留代码立即清理
7. anthropic-messages api 直接拿 model.id 发上游：注册 wire id，勿用本地短名
8. pi 0.84.2 无 glob 工具：需要 glob 语义的工具（glob tool 前端）走 standalone MCP 或确认工具集
9. session-dir 每会话独立 JSONL 是续档/崩溃恢复的唯一事实源——禁止清理
10. 探测性改动只增文件直到 M1 换引擎；session-loop 改造前先出基线 commit（已完成 1c7502d）