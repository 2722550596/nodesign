# NoDesign

> agent 驱动的设计工作台 —— 一张空间画布桌面，chat 一句 brief，agent 在任务
> 文件夹里做出 deck / 网站等产物，实时直播在画布上；用户直接在产物上改字、
> 留评论、拖 Tweaks，导出 PDF / PPTX / 整站 zip / 工程包。

---

## 这是什么

NoDesign 把"做设计"从**人手工拼图层**变成**跟 agent 协作的空间工作台**：

- **一张桌面**：项目 = 一张空间画布，任务 = 文件夹（工作区），agent 的每一步
  （写代码 / 跑命令 / 生图）实时直播成画布上的舞台卡，产物写完即上墙
- **多形态产物，平等共存**：一个任务文件夹可以装多个产物 ——
  deck（单文件 HTML，`<section data-page>` 分页 + fit script）、
  站点（手写或构建型，产物根自动认定，响应式三档取景预览）、
  单页；形态由文件证据认定（`kinds/` 注册表），不用声明
- **直接操作产物**：deck 和站点同一套 —— 双击改字（写回源文件）、单击元素留
  评论（带页面 path 进 pending buffer，agent 下轮主动拉）、Tweaks 参数面板
- **agent 有眼睛**：截图自检（回传 console 错误 + 加载失败资源 + beforeShot
  滚动触发动画）、DOM 雷达（query_elements / computed_styles）、外站截图找
  视觉参考（explorer 子代理用眼睛看，不靠文本转述想象）
- **跨 session 长期记忆**：项目品牌档案 / 通用偏好，agent 跨会话续做不忘
- **模型可选**：输入框旁 picker 切 Sonnet / Opus（session-config 为真相源，
  空闲时无损重启 query 生效，对话与画布不丢）

详见 skills：[deck 守则](server/engine/plugins/nodesign/skills/deskskill-engine-mini/SKILL.md)
/ [站点方法论](server/engine/plugins/nodesign/skills/site-craft/SKILL.md)。

---

## 快速开始（dev）

```bash
# 1. 装依赖
npm install
cd web && npm install && cd ..
npx playwright install chromium

# 2. 配 .env（敏感值不入 git）
cp .env.example .env
# 按注释配模型接入（Claude 订阅 OAuth 或 API gateway）、NODESIGN_AUTH_PASSWORD（公网必配）

# 3. 起 dev server
npm run dev           # 后端 :4001（hot reload）
cd web && npm run dev # 前端 :5174（Vite）

# 4. 访问 http://localhost:5174
```

生产部署（pm2 + nginx + Cloudflare）看 [DEPLOY.md](DEPLOY.md)。

⚠️ **Cloudflare 前置时的坑**：CF 对 `.css/.js/.png` 等扩展名按后缀边缘缓存，
`/api` 路径也不放过，源站 `no-cache` 会被改写成浏览器 4 小时 TTL、404 同样缓存。
产物 serving 路由必须发 `no-store`（`server/api/assets.js` 的 artifact-file 已处理，
新加按扩展名可访问的路由要想到这条）。

---

## ⚠️ 开发约束：Linux 是 source of truth

NoDesign 部署目标是 **Linux 服务器**（Ubuntu / Debian），Mac 只是 dev 便利。
**任何"我本地能跑"都不算数** —— 必须在 Linux 上验证过才算 working。

### 4 条铁律

1. **路径**：永远 `os.homedir()` + `path.join` + `path.sep`，绝不硬编码 `/home/...` 或 `/Users/...`
2. **跨平台决策**：所有跟 OS / 工具 / 外部状态相关的决策（CLAUDE_CONFIG_DIR、sandbox、preflight、凭据黑名单）**只在 [`server/runtime/platform.js`](server/runtime/platform.js) 里做**。业务文件 `import { platform }` 用结果，不要自己拼 env
3. **状态显式声明**：外部状态（OAuth token、cache、env）在启动时 `platform.dump()` 打日志，运维一眼能看到
4. **Loud fail，不 silent fallback**：失败默认 `throw`，需要降级用显式开关；工具失败按名字暴露，不拿静默兜底掩盖

### 已知跨平台陷阱（踩过的）

| 陷阱 | 现象 | 解决 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` per-session | SDK list/fork/delete 找不到 jsonl | 统一全局 → `platform.claudeConfigDir` |
| bwrap 不解析 symlink | Glob/Read 看不到 `assets/` `tasks/`（指向 shared 的软链） | sandbox 默认关 + 拓扑重排 |
| WebFetch preflight | `DomainCheckFailedError`，gateway key 模式 100% 复现 | `skipWebFetchPreflight: true` |
| Mac 残留 OAuth token | "我本地能跑啊"幻觉，服务器 non-root user 100% 炸 | docker / CI 早测 Linux |

---

## 核心概念

### 任务模型

**会话 = 对话通道，任务 = 文件夹 = 产出的家，一对一绑定。**

```
projects-data/<projectId>/
├── shared/                     跨 session 共享
│   ├── tasks/<任务名>/         一个任务文件夹（agent 按需自建，目录名即任务名）
│   │   ├── canvas.html         deck（顶层每个 .html 各是一份平等的 deck）
│   │   ├── index.html          站点入口（有它 = 整个目录是一个站，子页同目录加）
│   │   ├── dist/               构建型站点产物根（dist/out/build/_site/public 自动认）
│   │   ├── v1/ v2/             无根站时，带 index.html 的子目录各是一个平行站点
│   │   ├── _drafts/*.html      独立单页，各自一张卡
│   │   ├── assets/             任务本地素材（站内相对引用，导出零改写）
│   │   └── .nd-task.json       marker（sessionId 绑定 / root 显式覆盖，机器不猜时才用）
│   ├── assets/                 项目级素材（生成图 / 上传）
│   └── .claude/agent-memory/   长期记忆（memory.md + brand/memory.md）
└── sessions/<sid>/             per-session 工作区（tasks/ assets/ 软链指向 shared）
```

**多产物平权**（2026-07-29 起）：没有"主产物 / 试作"等级，`kinds/` 注册表按
文件证据把任务解析成 `artifacts[]` 平等列表，画布一条一卡。工具寻址默认打
**最近碰过的那份**，多产物时显式传 path。

### 空间画布

- 桌面固定 1360 逻辑宽，任务工作区自动纵向堆叠，聚焦的文件夹占满一屏
- **避让系统**：交互中的卡有路权（最近摸过的不动），被压的卡最小位移让位、
  连锁传递、拖走弹回；刷新错位由框内收容自愈
- **舞台层**：agent 的 Edit/Write 逐字节流式直播、终端卡、生图 shimmer、
  AskUserQuestion 直接在画布上答
- deck / 站点卡两态：收起条 ↔ 内嵌渲染；✏️ 开最大化窗（DeckWindow letterbox
  缩放 / SiteWindow 真实设备宽取景 desktop 1440 / tablet 834 / mobile 390）

### 直接编辑 + 评论

`DirectEditBridge` 是通用 iframe 桥，deck 窗和站点窗共享同一套：
双击改字（整页序列化写回该文件 + 进 pending buffer）、单击选元素留评论
（带页面 path）。agent 通过 `get_pending_changes` 拉 buffer，改完 `clear`。
构建型站点的编辑落在产物上，agent 负责同步回源再重建。

---

## 导出

| 格式 | 适用形态 | 实现 |
|---|---|---|
| 自包含 HTML | deck / 站点单页 | 单文件内联 |
| PDF（矢量） | deck | playwright `page.pdf()` |
| PPTX | deck | playwright 截图 + pptxgenjs（位图，文字不可编辑） |
| 整站 zip | 站点 | 产物根打包，`.ndignore` + 硬忽略清单，资源引用归一 |
| 工程交付包 | 全部 | JSZip：源 + assets + README |
| deliver_files | 任意文件 | agent 挑着推进浏览器下载列表 |

导出格式按产物形态守卫（`formatAllowed`），点错会得到明确的 400 而不是静默错。

---

## 架构概览

```
浏览器 (Vite :5174 dev / nginx+CF :443 prod)
  ┌ ChatPanel ─────┐ ┌ BoardCanvas（桌面）───────────────┐
  │ 对话 / 子代理   │ │ 任务工作区(避让/收容/舞台层直播)     │
  │ 时间轴 / 模型   │ │  ├ DeckWindow（letterbox + 编辑全家）│
  │ picker         │ │  └ SiteWindow（设备宽取景 + 编辑）   │
  └────────────────┘ └───────────────────────────────────┘
        │ HTTP /api            │ WS /ws
        ▼                      ▼
NoDesign server (:4001, pm2 单实例)
  ├ express API：projects / sessions / canvas / assets(artifact-file, no-store)
  │              exports / board / pending-changes / memory / turn
  ├ WS broker：EventBus per project
  └ Engine
     ├ session-loop.js   每个活跃 session 一个 long-running SDK query
     │                   （streamInput；后台自发 turn 铸造 runId）
     ├ lib/kinds/        产物形态注册表（deck / site；manifest = artifacts[] 平权）
     ├ lib/artifact-target.js  寻址（路径 → 所属产物 → kind + 产物根）
     ├ 20 个业务 mcp 工具（screenshot_canvas 带诊断回传 / screenshot_url /
     │   read_page / query_elements / generate_image / remove_background /
     │   web_search / pin_to_board / deliver_files / …）
     └ 4 个 subagent：explorer（可外站截图）/ vision-checker /
                       ds-extractor / tweak-proposer

server/db/nodesign.db   SQLite（projects / runs metadata）
```

---

## 文档导航

| 文档 | 内容 |
|---|---|
| **README.md**（本文） | 项目入口 / 速览 |
| [DEPLOY.md](DEPLOY.md) | 生产部署 SOP（pm2 + nginx + 故障排查） |
| [HANDOVER.md](HANDOVER.md) | 完整交接：产品定位 / 架构决策 / 阶段历史 |
| [server/engine/agent/prompts/nodesign-prelude.md](server/engine/agent/prompts/nodesign-prelude.md) | agent 通用 prelude |
| [server/engine/agent/prompts/tools/site-reference.md](server/engine/agent/prompts/tools/site-reference.md) | 站点目录约定 / 产物认定规则（多产物平权口径） |
| [server/engine/plugins/nodesign/skills/](server/engine/plugins/nodesign/skills/) | deck / 站点两份 SKILL（方法论化：形态从问题长出来，不预设范式） |

---

## 当前状态

**空间工作台版**（`main` @ 2026-07-29）。5 月的 v0.1-mvp 之后主线演进：

- 空间画布桌面化（任务=文件夹、舞台层直播、避让系统、文件夹收纳）
- 站点成为一等产物（响应式取景 / 整站导出 / 构建型支持），随后**多产物平权**
- 直接编辑 + 评论泛化到站点；失败舞台卡自动收束
- 感知工具升级：截图诊断回传 + beforeShot、screenshot_url、后台回合 AskUserQuestion
- 模型选择器（Sonnet / Opus 5）；订阅 OAuth 接入 + token 瘦身（起步上下文 ~35k）

已知限制：

- **单实例 only**（in-memory state，多 pm2 instance 会数据错乱）
- **重启丢活跃 session**：agent 跑着时 `pm2 restart` 会让当前 turn 死，重发即恢复（jsonl resume）
- **PPTX 文字不可编辑**（位图嵌入）
- **单用户视角**：多用户共编的并发未做
- 产物只能是纯静态（无常驻进程，SSR/带后端的 app 不行）

---

## 技术栈

- **后端**：Node.js 20+ / Express / WebSocket / better-sqlite3 / @anthropic-ai/claude-agent-sdk
- **前端**：React 19 / Vite 6 / lucide-react / 纯 inline style（无 CSS framework）
- **playwright**：截图 / PDF / PPTX 图片源 / e2e 验证
- **pptxgenjs / JSZip**：PPTX 拼装 / zip 打包
- **rembg**（可选）：常驻抠图服务（unix socket，`server/.venv-rembg/`）

native 依赖：`better-sqlite3`、`playwright` 需要 OS 系统库（Linux `npx playwright install-deps chromium`）。

---

## License

私有项目，不公开发布。

---

> 部署 / 运维问题看 [DEPLOY.md](DEPLOY.md)。
> 开发 / 设计决策看 [HANDOVER.md](HANDOVER.md)。
