# Engine 替换：CC SDK → pi-rp RPC

> 状态：设计稿（2026-08-26）。目标是把 `@anthropic-ai/claude-agent-sdk`（`query()` 子进程）
> 整个摘掉，agent loop 交给 pi-rp（`pi --mode rpc`），工具面走 pi-mcp-adapter 接 Nodesign
> 自己的 MCP server。作者同时是 pi-rp 维护者，pi-rp 侧的 bug 就地修，不做版本防御。

## 动机

1. CC SDK 的隐形提示词（`claude_code` preset ~27.7KB、SDK 硬注入残留、`CLAUDE_CODE_*` env 行为）改不掉、剥不净，`sdkPreset='replace'` 也只能换掉 systemPrompt 字段，messages[1] 的动态提醒段照样进上下文。
2. Nodesign 自己在 SDK hooks 上叠加的注入族（pre-injectors / user-prompt-submit / post-guidance / canvas-validate / site-validate / failure / subagent-report…）越滚越厚，成了第二层隐形提示词。
3. pi-rp 有可见的 prompt preset 体系、原生 skills/subagent、RPC 模式、扩展 API——提示词可以变成**能读的文件**，安全闸可以变成**显式的 hook 代码**。

## 目标架构

```
┌─────────────────────────── Nodesign server 进程 ───────────────────────────┐
│  express / ws broker / EventBus / SQLite run 状态机 / projects·auth·tier    │
│                                                                             │
│  engine/pi/                                                                │
│    rpc-client.js    spawn `pi --mode rpc`，JSONL 读写，请求关联              │
│    event-bridge.js  AgentSessionEvent → EventBus（前端契约不变）            │
│    lifecycle.js     每会话一个 pi 子进程：起/停/崩溃重启/孤儿回收            │
│    sidecar.js       MCP 子进程回主进程的桥（emit / tier / 项目配置）        │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │ stdin/stdout JSONL (RPC)       │ HTTP sidecar（本地回环，token 鉴权）
                ▼                               ▼
┌───────────────────────────────┐   ┌────────────────────────────────────────┐
│ pi 子进程（每会话一个）        │   │ nodesign MCP 子进程（每会话一个，adapter│
│ cwd = workspace/<sid>/        │   │ 懒启动）                               │
│ --session-dir 每会话 JSONL     │   │ engine/mcp/standalone.js               │
│ 专用 agent dir（见 §4.1）      │   │ createNodesignMcpServer 原工厂 + stdio │
│ pi-mcp-adapter 扩展（client）  │   │ 传输；身份从 env/argv 取               │
│ ── mcp() 代理 / directTools ──┼──▶│ 工具 handler：感知/控制/产物/研究全保留  │
└───────────────────────────────┘   └────────────────────────────────────────┘
```

设计决策：

- **每会话一个 pi 进程**，不用 `switch_session` 共享。理由：RPC 会话 cwd 绑定在启动进程（session 0 = 进程 cwd，`new_session` 沿用），每会话独立进程让 workspace 绑定、preset 装配、崩溃隔离都简单，代价是一次进程启动（可接受）。
- **Nodesign 工具用 stdio MCP 而非 SSE**。每会话进程天然携带身份（env/argv），adapter 按 `.pi/mcp.json` 懒拉起，不需要常驻 HTTP + 会话路由。
- **模型路由不进主进程**：ingress 整个删掉（§4.2），上游直连，路由语义由 pi-rp 的 provider/model 配置表达。

## 删除清单（用户已拍板）

| 组件 | 去向 |
|---|---|
| `@anthropic-ai/claude-agent-sdk`（package.json + 所有 `query()` 引用） | 删 |
| `server/lib/model-ingress.js` + `lib/ingress/`（路由/换钥/修补/剥残留） | 删 |
| `engine/agent/hooks.js` + `hooks/`（注入族 + 事件钩子） | 删，安全闸迁 §4.4 |
| `engine/agent/isolation.js` + `ops/sandbox-shim/`（bwrap 垫片，CC 专属） | 删 |
| `engine/agent/system-prompts.js` + `prompts/nodesign-prelude.md` | 迁 prompt preset（§4.4） |
| `engine/agent/session-model.js` / `model-table.js` / `model-context.js`（路由表） | 迁 pi provider 配置（§4.2） |
| `engine/agents/*.md`（子代理提示词） | 迁 pi delegatable presets |
| `engine/agent/init-contract.js` | 删（改为对 pi `session_start` 的装配断言） |
| `engine/agent/memory-config.js`（`CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` env） | 迁 preset 文本槽 |
| `maxTurns: 50` | 丢。循环终止靠 pi 自然结束 + auto-compaction，取消走 RPC `abort` |
| hooks/isolation/ingress 的测试（`hooks/*.test.js`、`isolation.test.js`、`tier.test.js` 里针对 query 的断言等） | 删 |
| **保留**：`engine/mcp/` 全部工具工厂与测试、`runs/` 状态机、`projects/`、`auth/`、`ws/`、`db/`、`runtime/`、`chatai/`、`browse/`、`perception/`、`motion/` | — |

## 组件设计

### 4.1 pi 子进程生命周期

**专用 agent dir**（关键，防提示词污染）：pi-rp 默认 agent dir 是 `~/.pi/agent`，也就是本机 OMP harness 自己的目录（里面躺着 qingzi 系系统提示词、chaoxi/klein 等 RP preset、harness 的 skills）。不隔离的话 Nodesign 会话会加载进一套没人知情的提示词。Nodeigns 自持一份：

```
server/engine/pi/agent-dir/
  settings.json        # 全局默认：defaultTools 白名单 / compaction / telemetry off
  package.json         # pi-extensions
  node_modules/pi-mcp-adapter   # 这里也要装一份（npm i，或 pi install npm:pi-mcp-adapter）
  prompt-presets/nodesign-base.json   # 平台 prelude 的 preset 化（不 autoActivate，共享底座，§4.4）
```

启动时 `PI_CODING_AGENT_DIR=<此目录>`（唯一入口；`--config-dir` 是项目级 `.pi` 目录名，不是 agent dir）。全局装的那份 adapter 不直接用——它和 harness 提示词在同一目录，取它的前提是连 harness 一起加载。

**spawn 参数**（`engine/pi/lifecycle.js`，参考 worldlines `writerLaunch` 的约定）：

```js
// ⚠️ --config-dir / --session-dir / --settings-file 传相对 cwd 的值：
// pi 的拼接是 join(cwd, dir)，绝对路径会拼成垃圾（worldlines web 踩过，
// 注释收口在 writerLaunch 一个函数里——Nodesign 同样收口在 lifecycle.js）。
// cwd = workspace/<sid>/，故相对值由 lifecycle 按 session 计算。
export function sessionLaunch({ sid, workspaceDir, dataRoot, resume, provider, model }) {
  const rel = (abs) => path.relative(workspaceDir, abs) || '.';
  const args = [
    '--mode', 'rpc',
    '--approve',                          // 项目信任：RPC 无交互，不预信任则 .pi 资源被忽略
    ...(provider ? ['--provider', provider] : []),
    ...(model ? ['--model', model] : []), // 会话模型走 arg：preset 是静态的，模型是动态的（§4.2）
    '--config-dir', '.pi',                // 会话级配置目录：presets / mcp.json / skills 从这解析
    '--session-dir', rel(join(dataRoot, 'pi-sessions', sid)),
    '--settings-file', rel(join(dataRoot, 'pi-sessions', sid, 'settings.json')),
    '-e', join(NODESIGN_SRC, 'server/engine/pi/extensions/guards.ts'),
    '-e', join(NODESIGN_SRC, 'server/engine/pi/extensions/providers.ts'),
    ...BASE_FLAGS,                        // 全局旗标常量（telemetry 走 PI_TELEMETRY=0 env）
    ...(resume ? ['--continue'] : []),
  ];
  const env = {
    PI_CODING_AGENT_DIR: AGENT_DIR,       // 专用 agent dir（§4.1 上）
    NODESIGN_SID: sid,
    NODESIGN_WORKSPACE: workspaceDir,
    NODESIGN_MAIN_URL: `http://127.0.0.1:${PORT}/__nd-sidecar`,
    NODESIGN_TOKEN: sidToken(sid),
  };
  return { args, env };
}
```

- **preset 装配不走 RPC**：`autoActivate: true` 由 pi-rp `chooseDefaultPreset` 在启动时选中（源码 `prompt-preset/loader.ts`：显式 opt-in 优先于扫描序），比会话首轮发 `/preset` 干净，续档重放也不会重复触发。
- **每会话 `.pi/` 目录**：`workspace/<sid>/.pi/prompt-presets/nodesign-session.json`（autoActivate）+ `.pi/mcp.json`（adapter 的项目覆盖层，nodesign MCP server 配置，§4.3）。preset 从 `cwd/.pi/prompt-presets/` 解析（`loadPromptPresets` 项目目录），会话私有天然成立。
- **`--settings-file`**：进程级只读覆盖（最高优先级，且该文件所在目录同样被扫描 presets/schemas/extensions/MCP config）——放每会话 settings（defaultTools 差异等）。
- **`-e` 显式扩展**：guards/providers 是仓库内文件，显式传路径，不依赖 agent dir 发现；`--no-extensions` 关掉发现也不影响 `-e`。
- **`--approve`**：预信任项目文件，否则 RPC 非交互模式下 `.pi` 资源会被忽略（`project-trust.ts`）。
- **`--continue`**：续档/崩溃恢复时带，配合 session-dir 里已有的 JSONL。

生命周期：会话激活时 spawn → 等 `hello`/首个快照就绪 → RPC 通信；会话结束/`abort` 超时 → SIGTERM → 超时 SIGKILL；异常退出（`agent_settled` 未收到）→ 按 run 状态机标记 failed，允许重连时 `switch_session` 续（JSONL 在 session-dir，天然可恢复）。

### 4.2 模型接入（ingress 删除后）

ingress 干的活拆解后各归其位：

- **按 `body.model` 路由多上游 / 换钥** → pi-rp provider 体系：每个上游注册成一个 provider（`baseUrl` + `apiKey` + `api: "anthropic-messages"` + `models`）。注册方式选**扩展**：`server/engine/pi/extensions/providers.ts` 读 `NODESIGN_UPSTREAM_*` env，`pi.registerProvider(...)`——配置在 env，代码在文件，spawn 时 `-e` 显式加载，不碰 pi 的 models.json 装配流程。模型表迁移 = 把 `model-table.js` 的条目生成成 provider/models JSON（M1 做一次性脚本，M0 先手工注册一条验证）。
- **thinking 修补 / strip** → pi 模型配置的 `thinkingLevelMap` + `reasoning` 位；`pickThinkingConfig` 的语义（adaptive）映射到 pi 的 thinking level（`--thinking` / `set_model` 带 thinking）。
- **tool_result 图片提升**（Kimi/Gemini 桥丢图） → 这是上游协议坑，与引擎无关。pi-rp 侧先探针验证；若还丢，在 pi-rp 的 provider stream 层修（作者自己就是 pi-rp 维护者，往上游补，不回 Nodesign）。
- **/__nd/<sid> 日志归属** → 每个会话进程的 `--session-dir` 目录名就是归属，不需要 URL 前缀。
- **计费/失败连击/截断记录** → 删。pi 的 `message` 事件自带 `usage`，需要时在 event-bridge 落账。

会话模型选择：`resolveSessionModel` → spawn 时 `--model provider/model` 传入（model 是会话激活期的动态参数，不进静态 preset——preset 管提示词，arg 管模型；换模型走 RPC `set_model`）。tier 闸（哪个档能用哪个模型）留在 Nodesign 侧做 pre-flight 检查，不依赖引擎。

### 4.3 工具面

**nodesign MCP stdio server**（新文件 `engine/mcp/standalone.js`）：

- 复用 `createNodesignMcpServer` 工厂（原样，零改动），换传输：`@modelcontextprotocol/sdk` 的 `StdioServerTransport`，进程身份从 argv/env 取（`--session <sid>`、`WORKSPACE_ROOT`、`PROJECT_ID`、`SHARED_ROOT`、`NODESIGN_MAIN_URL`）。
- 原实现 handler 与主进程共享内存（`ctx.emit` 发事件、`withTierGate` 查 project owner、pending-changes、board-store）。跨进程后统一走 **sidecar**（`engine/pi/sidecar.js` + 主进程 express 挂 `/__nd-sidecar`）：本地回环 + 会话 token 鉴权，只桥三类——① `ctx.emit`（事件转发 EventBus）；② 只读项目配置/tier/owner（复用 `getProject`/`getUserById`）；③ 主进程内存态（有需要再加）。文件型 store（board 文件、pending-changes 落盘）直接读盘，不经 sidecar。
- 崩溃/超时：adapter 有 `requestTimeoutMs`、`lifecycle: lazy`、keep-alive 重连；子进程死亡由 lifecycle.js 记 run 失败。

**adapter 配置**（写进会话 workspace 的 `.pi/mcp.json`——adapter 的 Pi 项目覆盖层，最高优先级，`<sid>` 烘焙进 args；workspace 本来就是会话私有的，全局层的 `~/.config/mcp/mcp.json` 仍然会被读到）：

```json
{
  "mcpServers": {
    "nodesign": {
      "command": "node",
      "args": ["<abs>/server/engine/mcp/standalone.js", "--session", "<sid>"],
      "env": { "NODESIGN_MAIN_URL": "http://127.0.0.1:<port>/__nd-sidecar", "NODESIGN_TOKEN": "<sid-token>" },
      "directTools": ["screenshot_canvas", "read_board", "web_search", "pin_to_board", "get_pending_changes", "clear_pending_changes", "deliver_files"],
      "lifecycle": "lazy"
    }
  }
}
```

- `directTools` 白名单 = 原 `ALWAYS_LOAD_TOOLS` 常驻 schema 清单；其余走 `mcp()` 代理按需取（省常驻 token，替代原 ToolSearch）。
- 外部 MCP（原 `NODESIGN_MCP_SERVERS` env）→ 挪进 `~/.config/mcp/mcp.json` 或 agent-dir 的 mcp.json，配置格式照 adapter 的 6 层优先级；`NODESIGN_MCP_SERVERS` env 解析器删除。
- 内置文件工具（Read/Write/Edit/Glob/Grep）→ pi 原生工具，白名单在 settings.json `defaultTools` 钉死，**不给 bash**（需要 shell 的那天用 sandbox 扩展包一层 bwrap，不裸开）。

### 4.4 提示词与安全（这次的核心诉求：提示词全部可见）

- **平台 prelude → prompt preset**：`nodesign-prelude.md` 正文迁进 agent-dir 的 `prompt-presets/nodesign-base.json`（共享底座，**不**设 autoActivate；pi-rp 的 JSON preset 格式：13 个内置槽 + 宏引擎，成人档/产物政策标记块的渲染逻辑用 slot 覆盖 + 宏实现）。会话层在 workspace 的 `.pi/prompt-presets/nodesign-session.json` 写一份 `autoActivate: true` 的薄覆盖（纯提示词内容，模型不进 preset）——`chooseDefaultPreset` 启动即选中，不走 RPC `/preset`。项目级 `prompt.prelude.override` 语义保留 → 直接改这份会话 preset 的槽内容。
- **SKILL.md**：pi 原生 skills（同一格式），`skill.js` loader 删，`plugin-loader` 的 plugins 装配 → pi 的插件/skills 发现机制。
- **安全闸（必留，显式化）**：workspace-scope guard、performance-log guard、project-tool-deny、auto-mode-rules → 一个 Nodesign 扩展 `extensions/guards.ts`，`pi.on("tool_call")` 里 block + 理由；工具 deny 白名单同时落到 preset 的 `"tools": {"deny": [...]}`。

**hooks.js 全家迁移映射**（源码验证过的事件面）：

| 现有 hooks.js | pi 机制 | 备注 |
|---|---|---|
| PreToolUse（deny/guard/默认值） | `pi.on("tool_call")`：`event.input` 可变、返回 `{block, reason, terminate}` | guard 类 1:1；Grep content 默认 = 改 input |
| PostToolUse（trim/failure/subagent-report） | `pi.on("tool_result")`：返回 `{content, isError, details}` 改结果 | 无注入字段 |
| PreToolUse 注入族（cookbook/协议） | 工具 description 承载 ／ `pi.sendMessage()` custom message（默认以 user 进 LLM，`registerCustomType` 控策略，deliverAs=steer/followUp） | ⚠️ `tool_call` 结果无 additionalContext 等价——注入语义由工具侧或 sendMessage 替代 |
| UserPromptSubmit（每 turn 状态注入） | `before_agent_start` 的 `systemPrompt`（每 turn 链式替换）／ preset 宏 | 按文档策略删，路径地图用 preset 静态宏 |
| FileChanged / PostToolUse 事件转发 | **不用扩展**：event-bridge 直接看 RPC `tool_execution_end`（input+result），`ctx.emit` | 比现在少一层 |
| SessionStart / Stop / PostCompact | `session_start`（reason 区分 new/resume/fork/reload）/ `session_shutdown` / `session_compact`（`session_before_compact` 可 cancel+自定义压缩） | — |
| Subagent 生命周期 | 原生 subagent + `agent_start`/`agent_end` | agents/*.md → delegatable presets |
| AskUserQuestion 协议注入 | `ctx.ui.select/confirm/input` → RPC `extension_ui_request` → 主进程桥到前端 | 注入协议整体退役 |
| rate-limit / 计费 | `before_provider_request` / `before_provider_response` | 替代 ingress 的失败连击/计费记录 |
- **业务注入族（删）**：pre-injectors（cookbook）、user-prompt-submit（路径地图）、post-guidance、canvas-validate、site-validate、failure、subagent-report——不搬。需要的前置知识（generate-image cookbook 等）降级为 preset 文本或 SKILL.md 附件，由 agent 自主按需读取；前端校验类逻辑移进 MCP handler 本身（`createNodesignMcpServer` 内部本来就有 param-sanitizer/capability-gate 这层，往这层加）。
- **agents/*.md → delegatable presets**：pi-rp 原生 subagent（`subagent` 工具 + `delegatable: true` preset）；子代理工具默认不启用（defaultTools 不含 `subagent`），需要时按会话开。
- **记忆指导**（`MEMORY_EXTRA_GUIDELINES`）→ preset 文本槽。

### 4.5 事件与前端

前端契约（EventBus schema，`run.delta.*` 等）**不变**，`ws/index.js` 不用动。事件映射在 `engine/pi/event-bridge.js`：

| EventBus | pi RPC 事件 |
|---|---|
| `run.start` | `session_start` / 首个 `agent_start` |
| `run.delta.text` | `message_update`（`assistantMessageEvent` 的 `text_delta`） |
| `run.delta.thinking` | `message_update`（`thinking_delta`） |
| `run.delta.tool_use` | `tool_execution_start`（args） |
| `run.delta.tool_result` | `tool_execution_end`（result/isError） |
| `run.compact_boundary` | pi compaction 事件（实现时核对事件名） |
| `run.status` | agent state（isStreaming/isCompacting） |
| `run.rate_limit` | error 事件（rate-limit 判别） |
| `run.cancelled` | `abort` 响应 / `agent_end` |
| `run.done` | `agent_settled` + 末条消息 |
| `run.error` | `extension_error` / error 事件 |

`includePartialMessages` 的逐 token 增量由 `message_update` 的 delta 事件承担，映射层按 round 聚合即可，前端不改。

### 4.6 会话持久化

- pi 侧：`--session-dir` 指向 `<data>/pi-sessions/<sid>/`（lifecycle 算成相对 cwd 的值传给 pi），每会话一个 JSONL（白拿 /tree、/reroll、/continue、state）。
- Nodesign 侧：`runs/` SQLite 状态机保留（记账/审计不变），`persistSession:false` 之类 SDK 选项随 SDK 一起消失。

## 里程碑

**M0 · 探针（半天，不动 session-loop）**
1. 装配专用 agent dir（settings + adapter 一份 + 手工注册一个 provider 指向 Kimi 上游，或先跑 providers 扩展）。
2. 按 §4.1 `sessionLaunch` 手搓 spawn（cwd=临时 workspace + `.pi/prompt-presets/nodesign-session.json` autoActivate），RPC `prompt` 走通一轮文本回复，验证 autoActivate 生效。
3. `standalone.js` 最小版（先挂 3~5 个工具：screenshot_canvas / read_board / web_search / pin_to_board），`.pi/mcp.json` 指向它，验证模型能通过 `mcp()`/directTools 调工具、工具结果回得来。
4. 事件流落盘解析，验证 message_update delta 可还原前端增量。
- 验收：三件事全通（工具调用 / provider 直连 / 流式事件）。不通的项（如 tool_result 图提升）当场定修法。

**M1 · 工具面完整 + 事件桥**
- `standalone.js` 全量工具 + sidecar 三类桥接；`engine/pi/` 四个模块成型。
- `session-loop.js` 换引擎（`engine/pi/rpc-client.js` 驱动），`api/sessions.js` 临时 query 旁路删，CC SDK 依赖移除。
- 模型表迁移脚本（model-table → provider JSON）。

**M2 · 提示词收敛**
- prelude/skill/agents 迁 preset；guards 扩展；删注入族与 `hooks/`、`isolation/`、`init-contract`、`memory-config` env。

**M3 · 清理与回归**
- 删 ingress、sandbox-shim、旧测试；重写保留下来的契约测试（MCP 工具 handler、param-sanitizer、tier 仍在）；前端联调（流式、事件、canvas 事件、browse 通道）。

## 开放问题（进 M0/M1 时逐一验证）

1. **MCP 子进程的 playwright 复用**：browse 工具现在跑在主进程，多会话各自起 chromium 实例的资源压力——原实现是否有共享实例，迁移后要不要 pool（`browse/registry.js` 核对）。
2. **sidecar 延迟**：`ctx.emit` 桥对前端即时性（screencast、canvas_focus 等）的影响，本地回环可接受性。
3. **pi 子进程启动耗时**：每会话 spawn 的冷启动延迟对首消息体验的影响（pi 带 adapter 冷启约 1~2s，实测确认）。
4. **adapter 代理工具占位**：`mcp()` 代理 + `mcpScript` 默认开，`disableProxyTool` 是否在 directTools 齐了之后关。
5. **subagent/state 工具**：默认不启用，确需时按会话开（defaultTools 是进程级，得按会话改 settings 或 preset deny 实现）。
6. **compaction 事件名**与 `run.compact_boundary` 的精确映射。
