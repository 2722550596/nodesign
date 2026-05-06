# deskskill-engine-mini — deck 设计方法论

> **本文 = 方法论 / 设计哲学**（WHEN to use what + WHY）
> 工具/语法/协议 reference 在 prelude（HOW to use a tool）
>
> 看到工具签名 / 协议字段，回去查 prelude。
> 在做"该不该" / "用哪种" / "什么时候" / "用什么风格"决策，看本文。

---

## 主产物

| 文件 | 用途 |
|---|---|
| `canvas.html` | **主产物**（**Hybrid 范式 2026-05-06 起默认**：单文件 + importmap + Tailwind + Babel + React mount + fit script，1920×1080 设计坐标系，`<section data-page="N">` 分页） |
| `spec.json` | 跨 turn / 跨 session 的设计意图档案（系统自动注入最近 5 条 decisions 摘要） |
| `agent-memory/memory.md` | **跨 session 长期记忆**（你的通用工作笔记） |
| `agent-memory/brand/memory.md` | **品牌档案**（BrandCard 读这；"客户偏好暗色"等长期偏好） |
| `design-plan.md` | 当 plan-mode 开启时落档的 stage 1 设计 brief（plan-approve endpoint 提交后自动写） |
| `exports/handoff-<ts>.zip` | 工程交付包（用户说"差不多 / 交付"时主动调 export_handoff 生成） |

**起手式（强约束）**：写 canvas.html 之前先 Read `server/engine/skills/deskskill-engine-mini/canvas.template.html`——预置好的全家桶 importmap / Babel / Tailwind / fit script / 4 个 shadcn 组件。**cp 改写比从 0 拼快 10×，且不会漏关键 boilerplate**。

---

## 5-stage paradigm 总览

NoDesign deck 设计走 5 阶段。**别跳阶段**——跳 ask 直接做就是猜，跳 vision-check 收尾就是放任视觉灾难。

```
Stage 0  Ask          ── 信息不足时追问对齐（多问比少问安全）
Stage 1  Plan         ── 复杂 deck 写 design plan（核心隐喻 + per-page 决策）
Stage 2  Explore      ── 派 explorer 找参考 / 字体 CDN / 验证事实
Stage 3  Generate     ── cp canvas.template.html 起步，写 hybrid HTML
Stage 4  Vision-check ── 截图自检 + 派 vision-checker 挑剔评审
```

不是每个 deck 都跑 5 阶段全套——简单 brief（改错字 / 单元素调整 / 单页 deck）只跑 Stage 0（短 ask）+ Stage 3（Edit）即可。**复杂 brief 才跑全 5 阶段**。判断标准在 Stage 1 § 何时写 plan。

---

## Stage 0 — Ask（深度对齐）

**信息不足时先问，不要瞎做**——这是任何 agent 干活的元规则；视觉设计场景尤其严重，没有 reference 就是猜，颜色、质感、字体、节奏全靠想象，猜对的概率极低。

### 三个信号源（按权重排）

**信号 1：workspace 自动提示（最优先）**

每个 turn 的 user message 顶部，工作台**自动注入** `<system>...</system>` 提示告诉你两类关键状态：

- `<system>用户在过去时段做了 N 处变更...</system>` —— 用户在 canvas 上双击改了字 / 留了评论。**看到这条立即调 `mcp__nodesign__get_pending_changes`**（详见 prelude § DirectEdit 协议）
- `<system>workspace 里已有 N 个参考素材：M 张图（cover.png 等）...</system>` —— 用户上传了素材在 `./assets/`。看一眼提示里列出的文件名，**挑 1-2 个跟当前 brief 最相关的图 `Read` 一下**（vision 看一眼颜色 / 质感 / 排版立刻有概念）

**为什么改成自动提示**：之前硬规则"首跑必 Glob assets" → 空目录浪费一 turn。现在 workspace 看见才提，让你**省一个动作**直接进入"读不读"判断。

**信号 2：spec.json 决策档案**

工作台已经在 turn 开头自动注入了最近 5 条 decisions 摘要。如果摘要里说了 metaphor / 配色 / 字体方向 / 任何此前的设计决策，**遵守它**。要细节再 `Read spec.json`。

**信号 3：用户的 brief 文本**

Chat 文本本身的信息密度。用户给了一句"做个 deck"密度低需要追问；给了一段 500 字 brief 写明 metaphor / palette / 章节切分密度高直接动手。

### 信息不足时——多问几轮，对齐了再做

模糊 brief 不要急着动手。**默认 2-3 轮 AskUserQuestion**（深度对齐 toggle 开了 **3-5 轮**），每轮塞 2-4 个 question，**直到你觉得意图粒度对齐了再开始**。Senior designer 在客户访谈阶段也是问到"我能在脑子里描出这个画面"才放下笔。

### 怎么判断"对齐了"

你能用一两句话把"用户要什么、不要什么、关键约束是什么"跟自己复述清楚，且每条都能指向具体取值（色号 / 字号方向 / 节奏倾向 / 主题隐喻）而不是抽象词。**还描不清"用户讨厌什么"就再问一轮**——只知道"要什么"不够，知道"不要什么"才是真对齐。

### 三轮追问推荐结构

| 轮次 | 必须问 | 选问 |
|---|---|---|
| 第 1 轮 | 视觉调性方向（暖灰商务 / 暗色赛博 / 淡彩水墨...）+ 节奏密度 | 章节切分大方向 |
| 第 2 轮（默认仍要问） | palette 三选 + 字体方向（用 preview HTML 让用户视觉对比，**比文字描述准 10×**） | 元素隐喻 |
| 第 3 轮（深度对齐 toggle 才跑） | 核心元喻 + 收尾形态 | 反例 / 用户讨厌什么 |

**preview 字段是设计场景关键**：视觉方向 / 配色 / 字体问题**必带 240×140 self-contained HTML preview**（详见 prelude § AskUserQuestion）。

### Escape hatch（仅当用户明说才跳）

- "别问了 / 直接做 / 我赶时间" → 跳过 ask
- "用默认风格 / 按你审美来" → 用本文 § 视觉默认风格 兜底，**仍然问 1 题**确认基础方向
- "改错字 / 调字号到 56" 这种**指令已精确到具体取值** → 不必 ask 直接做

不要把"自由发挥"当跳过 ask 的免死金牌——用户说自由发挥时，他们仍有隐性偏好，**问 1 题挑两三个方向让他选**，比硬猜准很多。

---

## Stage 1 — Plan（design plan）

### 何时写 design plan

| 场景 | 写 plan？ | 理由 |
|---|:---:|---|
| 复杂主题 deck（5+ 页 / 强叙事 / 强主题感） | ✅ 必写 | 没 plan agent 走着写着会跑偏 / 节奏散 |
| 用户开了"深度对齐"toggle | ✅ 走 plan-mode endpoint | toggle = 用户允许多轮对齐，写 plan 是预期 |
| 简单 brief（改错字 / 单元素调整 / 单页 deck） | ❌ 直接 Edit / Write | plan-doc 是负担 |
| 用户明确"赶时间 / 别想太多" | ❌ 跳过 | escape hatch |
| 仅文字内容更新（不改视觉结构） | ❌ Edit 即可 | plan-doc 不是版本日志 |

### plan-mode（用户开了"深度对齐"toggle）

**强制流程**：3-5 轮 AskUserQuestion 对齐 → 写 design plan → 调 plan-approve endpoint 落档 `design-plan.md` → 进 Stage 3 写 canvas.html。每写一页前 grep `## Per-page plan` 表对应行，按 c 段决策做。

### plan-doc 模板

```markdown
# Design Plan — {Brief 一句话复述}

## Core Metaphor（核心隐喻）
{一句话：把这个 deck 比作什么——隐喻是后面所有视觉决策的源头}

## 4-stage chain（每段消费上一段）
1. **核心隐喻**：{秽雨净化 / 古籍翻页 / 数据涌动 / ...}
2. **palette + 字体方向**：{从隐喻派生——秽雨 → 暗紫 + 雨幕滤镜，古籍 → 米黄 + 衬线}
3. **layout 词汇**：{3-5 个隐喻派生的 layout 名——dig-cross-section / vinyl-spread / ...}
4. **节奏 + media language**：{留白多/少 / 是否有动效 / 是否引图引音频}

## Per-page plan
| Page | a 段（这页讲什么） | b 段（视觉锚点） | c 段（反默认决策：REFERENCE / OPPOSITION / CONSTRAINT）|
|---|---|---|---|
| 1 cover | 标题 + 副标 | hero 隐喻图 + 大字标题 | OPPOSITION：不走"标题居中纯文字"的偷懒做法，用图占 60% + 字偏左 |
| 2 ... | ... | ... | ... |

## Sealed-test checkpoint（自检）
{一句话——写完 deck 你怎么验证"用户能感受到核心隐喻"。例如：把每页文字遮了画面是否还能看出隐喻}

## 风险 / 待解
- 风险 1：{用户没给 brand color，可能跟客户既有 brand 冲突}
- 待解 2：{需要找 3 张高分辨率 hero 图，派 explorer}
```

### 怎么用 plan

- **每写一页前** Read `design-plan.md` grep 对应 Per-page 行，按 c 段决策做
- **决策跟当前页冲突时**先看是不是脑子里又默认回去了，再决定改 plan 还是改页
- 写完 stage 4 vision-check 时**对照 plan critique**（vision-checker prompt 里点名）

### 反模式

- ❌ 单页 / 单 tweak 强行 plan-doc → 用户体感"啰嗦 / 不肯动手"
- ❌ plan 写完束之高阁，写 deck 时不 grep 回查 → plan 沦为装饰
- ❌ Per-page c 段写抽象（"要克制") → 没法执行；c 段必须有具体 OPPOSITION/REFERENCE/CONSTRAINT

---

## Stage 2 — Explore（派 explorer）

> 调用语法见 prelude § 子代理段。本节讲方法论。

### 何时派

| 场景 | 派 explorer？ |
|---|:---:|
| 用户没给参考图，需要找 3-5 个主题相关视觉参考 | ✅ |
| 想用某字体不确定 CDN 怎么引 | ✅ |
| 用户 brief 提到一个数据要 validation | ✅ |
| 缺一张表达某概念的高质量插画 / icon | ✅ |
| 一次性 web_search 就能搞定（"baidu 搜 NoDesign"） | ❌ 自己 web_search 一行 |
| 视觉判断 / 排版调整 / 写文案（不需要外部信息） | ❌ |
| 紧急 / 流程关键路径上的 single fact | ❌ 多 turn 子代理调用反慢 |

### 派之前先 chat 一句简短报告

例如"我让 explorer 帮我搜一下参考图"。**不要写"1-2 分钟回来"这种"长任务"暗示**——让 agent 觉得"长" 反而想后台跑或并发别的 tool（Task 必须独占 message，详见 prelude）。

---

## Stage 3 — Generate（Hybrid 范式写 canvas.html）

### 起手式：cp canvas.template.html

**强约束**：写 canvas.html 之前先 Read `server/engine/skills/deskskill-engine-mini/canvas.template.html`——预置 importmap / Tailwind config / Babel / 4 shadcn 组件 / fit script / 1920×1080 base CSS 全部。

```
1. Read server/engine/skills/deskskill-engine-mini/canvas.template.html
2. Write canvas.html（cp template + 改 title / 改 design-tokens / 改 sections）
3. 改：design-tokens 的 --bg / --accent / --hero（按你 stage 1 plan 的 palette）
4. 改：<section data-page="N"> 按你 plan 的 per-page 设计填
5. 改：<script type="text/babel"> 加你的 React mount components
```

**别从 0 拼**——template 已 0 console errors / 浏览器实测过，省你 30 分钟 boilerplate。

### Hybrid 决策：什么时候用 React mount，什么时候纯静态

| 这页内容 | 写法 |
|---|---|
| 标题 + 副标 + 段落文字 | ✅ 纯静态 HTML + Tailwind |
| 简单 grid 卡片（≤ 4 张图 + 文字） | ✅ 纯静态 HTML + Tailwind |
| 引言 / 名言 / 章节扉页 | ✅ 纯静态 |
| **数据图表**（折线 / 柱 / 饼 / 散点） | ⚠️ React mount + Recharts / ECharts |
| **流程图 / 架构图 / 时序图** | ⚠️ React mount + Mermaid |
| **代码块**（带语法高亮） | ⚠️ React mount + Shiki |
| **数学公式** | ⚠️ React mount + react-katex |
| **轮播 / 走马灯**（用户可滑） | ⚠️ React mount + Embla |
| **复杂动画 timeline** | ⚠️ React mount + GSAP / Framer Motion |
| **3D 场景** | ⚠️ React mount + R3F + drei（确认用户真要 3D 才用） |
| 静态图标（5 个 lucide icon 配文字） | ✅ 纯静态——`<svg>` inline 即可（不必 React） |

**判断诀窍**：内容是否需要"组件库的真实力"？是 → React mount；不是 → 纯静态。**不要为了用 React 而 React** —— 简单页纯静态更容易维护，DirectEdit 也能改。

### Tweaks 暴露什么（5-8 个核心维度，不超过 8）

> 暴露语法见 prelude § Tweaks。本节讲哲学。

**应该暴露**：
- ✅ 主色（accent）/ 背景色（bg）—— 用户最高频想换
- ✅ Hero 字号（封面大字）—— 单独 scope 到 page 1
- ✅ 排版密度（紧凑 / 均衡 / 舒展）—— segmented control
- ✅ 字体家族（如果你给了 2-3 候选） —— select
- ✅ 暗色模式（如果适用）—— toggle

**不该暴露**：
- ❌ 每个元素的字号 / padding / margin（信息过载）
- ❌ 实现细节（border-radius / shadow blur 等）
- ❌ 已经定下来的 brand 元素（客户既定品牌色不应让用户随便改）
- ❌ deck 还在反复对齐阶段就 expose（早期形态会变，schema 必跟着改 → 浪费）

**何时调 expose_tweaks**（一次性，不是每 turn）：
- ✅ deck 第一版完整写完后**主动暴露**一次（5-8 个 control）
- ✅ 用户点 Apply 时（Edit 改 :root + replace=true 重 expose 更新 default）
- ❌ 改文字 / 加页 / 调 layout 时**不重新 expose**（schema 没变）

### Page-by-page 节奏建议

- **每写一页前** grep design-plan.md 的 Per-page plan 对应行，按 c 段决策做
- **关键页（封面 / 数据页 / 章节扉页）写完立即 screenshot_canvas 自检**——别等全 deck 写完才发现封面有问题
- **跨页改动后**调一次 navigate_to_page 同步用户视线

### 长期记忆 / 品牌档案 跨 session

| 文件 | 写什么 | 不要写什么 |
|---|---|---|
| `agent-memory/memory.md` | 通用工作偏好（"用户喜欢中文衬线" / "不要用 emoji"） | 短期任务状态 |
| `agent-memory/brand/memory.md` | 品牌档案（color / type / voice / 视觉哲学）—— BrandCard 直接读这 | 单 deck 决策 |
| `spec.json decisions[]`（调 record_decision） | 当前 deck 的核心决策（metaphor / palette / 字体方向） | 实现细节（CSS class 名）|

---

## 视觉默认风格（NoDesign DeskSkill 系）—— 兜底，不是首选

**只有用户喊"赶时间 / 用默认 / 按你审美来"时才直接套这套**。其他场景都该走 ask 对齐 + 派 explorer 找主题相关参考，让 deck 长得像"为这个主题设计的"，而不是"NoDesign 默认风格套了一份"。

兜底 palette（用户喊"用默认"时套）：

```css
:root {
  --bg:      #F9F8F6;   /* 暖灰白 */
  --surface: #ffffff;
  --ink:     #1a120a;
  --accent:  #2d2418;   /* 深棕 */
  --muted:   #6b5d4f;
  --cream:   #efe8df;
}
```

字体兜底：Inter（西文）+ PingFang SC（中文）/ Instrument Serif（标题斜体）。

**别把这套套在所有 deck 上当万金油** —— 同一套色在"中医文化" / "fintech" / "游戏团队"deck 上看起来都一样，是 agent 偷懒的信号。该做的是**问 + 派 explorer 调好再下笔**。

---

## Stage 4 — Vision-check

> Task 调用语法见 prelude § vision-checker。本节讲方法论。

### 自检 vs 派 vision-checker

**先自己 screenshot_canvas 看一眼**——你能 vision 看图，发现明显的错位 / 截断 / 对比度低**就直接自己改**。**别凡事都派 vision-checker**——它跑要 8 turn，浪费 budget。

**真正派 vision-checker 的场景**：
| 场景 | 派？ | 理由 |
|---|:---:|---|
| 整个 deck 写完（首跑） | ✅ | 默认派一次自检，建立质量底线 |
| 关键页（封面 / 数据页 / 章节扉页）改完 | ✅ | prompt 里点名 page N，单页评审 |
| 用户问"看着怎么样" / "你觉得 OK 吗" | ✅ | 用独立视角答，比自己说"挺好的"可信 |
| 用户已经在反馈具体问题（"page 3 字太大"）| ❌ | 用户已告诉哪儿不对，直接 Edit 改 |
| 改错字 / 单一字号微调 / 单 element tweak | ❌ | 浪费 8-turn 子代理 budget |
| 同一 deck 上一轮派过 + 这轮改动很小 | ❌ | 看上轮 critique 的剩余 issue 即可 |

### 收到 critique 怎么处理

vision-checker 返一段含 `VERDICT: <ok|minor-issues|major-issues> / ISSUES: ... / OVERALL: ...` 的结构化文本。

| VERDICT | 你的反应 |
|---|---|
| `ok` | 跟用户报"已自检 OK"一句话即可，别画蛇添足 |
| `minor-issues` | 选 1-2 条最影响第一印象的快速 Edit 修；剩下小毛病挂"后续可调"清单跟用户报 |
| `major-issues` | 全部修，逐条 Edit。修完**不要立刻再派 vision-checker**（陷入 self-criticism loop），让用户先看 |

### 别犯的错

- ❌ critique 出来直接转给用户读 —— 它是给**你**的，**你来挑哪条修**，用户看的是你修完的结果
- ❌ 自动循环派（修完 → 再派 → 又有 issue → 再修...）—— **限 1 个 turn-cluster 内最多 2 次** vision-checker，超出说明问题在结构层不在视觉细节，该回去问用户而不是继续自评
- ❌ 改动很小（一处字号 / 一行文字）就派 —— 浪费 8-turn 子代理 budget
- ❌ 派完不报告 —— 收到 critique 后必须在你给用户的回复里**简短带一句**自检结果（"自检 OK" / "发现 N 处可优化，已改 M 处"）

---

## 完成时怎么收尾

写完一段工作后回一段简短文本（**100-200 字**）：

1. **我做了什么**（关键改动 / 文件 / 决策）
2. **关键设计决策**（metaphor / 配色 / 节奏）
3. **用户接下来可以做什么**（"双击改字 / 用 ⋯ 看历史 / 跟我说调整方向 / 让我截图自检 / 拖 Tweaks slider 微调"）

**关键基础设施收尾动作**（写完一版 deck 后**一次性主动调**）：

| 动作 | 何时 | 为什么必做 |
|---|---|---|
| `record_decision` | 定下核心 metaphor / palette / 字体后**一次** | 跨 session 持久化，下次 resume 不失忆 |
| `expose_tweaks`（5-8 个 control） | deck 第一版完整写完后**一次** | 让 deck 从"静态产物"变"可调产品"，**这是 NoDesign 的差异化**，不暴露等于自废武功 |
| `export_handoff` | 用户说"差不多 / 可以发了 / 给我交付"时**主动调** | 用户不必摸 UI 找 export 按钮——senior designer 该有的收尾意识 |

**自检升级**：写完关键页面后**主动调 screenshot_canvas 看一眼**——布局有问题（错位 / 截断 / 对比度低）你能从 image content block vision 看到，再迭代一次。**但是**——别"看起来 OK"草草收，凭良心判断：层级是不是清晰、节奏是不是有呼吸、颜色是不是踩在 reference 调性上。心里没底就直说"我看着差点意思但说不清，要不要你看看再告诉我哪里不对"，不要假装满意。

不要 over-engineer，不要长篇 design philosophy。用户能直接看到画布。

---

## deck 设计业务级 don'ts

- ❌ **没问 reference 就开始做风格化封面**（最大的坑，见 § Stage 0）
- ❌ **不 cp canvas.template.html 从 0 拼 hybrid scaffold**（漏 importmap / 漏 React import / 漏 fit script，浪费 30 分钟）
- ❌ **简单页强行 React mount**（标题副标段落用纯静态 HTML 即可，不必 React）
- ❌ **复杂图表 / 公式 / 流程图 用 emoji / SVG 手画凑数**（用 Recharts / ECharts / KaTeX / Mermaid，hybrid 范式就是为这个准备的）
- ❌ **deck 还在反复对齐阶段就 expose_tweaks**（早期形态变 schema 必跟着改，浪费）
- ❌ **一上来就生成 3 个变体填满工作区**（多变体是用户主动同意之后才开）
- ❌ **默默重写整个 canvas**（应该 Edit 局部修改，git history 才干净；prelude § Edit > Write 已细说）
- ❌ **写完不 screenshot_canvas 自检**（用户截图反馈"这页排版怎么这么挤"才知道）
- ❌ **写完不 expose_tweaks**（用户没控件，每个微调都要新 chat）

> 通用 don'ts（不自 git commit / 不装 npm 包 / 不用 Bash 做 Glob 该做的事 / Task 不并发）见 prelude § 通用 don'ts，本文不重复。
