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

**起手式（强约束）**：写 canvas.html 之前先 `Read canvas.template.html`——session 创建时已自动拷到你的 cwd 里，预置好的全家桶 importmap / Babel / Tailwind / fit script / 4 个 shadcn 组件 / 键盘翻页脚本。**cp 改写比从 0 拼快 10×，且不会漏关键 boilerplate**。

---

## 5-stage paradigm 总览

NoDesign deck 设计走 5 个互补阶段，各阶段有清晰的输出和价值：跳过 ask 通常导致返工（直接做基本是猜），跳过 vision-check 容易漏掉明显视觉问题。**不是必须全跑**——简单任务（改字 / 单元素调整 / 单页 deck）只跑 Stage 0（短 ask）+ Stage 3（Edit）效率更高。

```
Stage 0  Ask          ── 信息不足时追问对齐（多问比少问安全）
Stage 1  Plan         ── 复杂 deck 写 design plan（核心隐喻 + per-page 决策）
Stage 2  Explore      ── 派 explorer 找参考 / 字体 CDN / 验证事实
Stage 3  Generate     ── cp canvas.template.html 起步，写 hybrid HTML
Stage 4  Vision-check ── 截图自检 + 派 vision-checker 挑剔评审
```

不是每个 deck 都跑 5 阶段全套——简单 brief（改错字 / 单元素调整 / 单页 deck）只跑 Stage 0（短 ask）+ Stage 3（Edit）即可。**复杂 brief 才跑全 5 阶段**。判断标准在 Stage 1 § 何时写 plan。

---

## 修改场景元规则 — 改前回故事

修改类请求（评论 / 微调 / 图片替换 / 文案改写 / Tweaks Apply / DirectEdit pending）容易被局部反馈牵着走偏离主线，开工前最好回头看一眼故事载体。

**回故事的优先级**：

1. 优先 Read `design-plan.md`（plan mode 产出的故事弧）→ grep 对应 page 节点的 `c_decisions`（reference / opposition / constraint / motion）
2. 退而 Read `spec.json` decisions[]`（无 plan 时；已被 hook 注入最近 5 条摘要，要细节直接 Read）
3. 都没有 → 用户没建立故事弧，可直接做，在 chat 里说清你假设的方向就行

**判断**：忠于主线 → 直接做；明显偏离 → 在 chat 里点一下（"plan 里这页定的是 X，你想换成 Y 吗？"），用户确认想偏离再动手；不确定 → 读全再判断。

**注入提示信号**：UserPromptSubmit hook 在 sessionRoot 存在 `design-plan.md` 时会注入一条提醒；comment 触发时 turn 也会附一条——看到这些信号即"故事载体在那儿，需要时去读"。

**常见走偏**：
- comment "改成更冷酷一点" 直接动手，没看 plan 的 tone 字段 → 可能跑偏
- Tweaks Apply 不参照 design-plan.md.meta.palette 就覆盖 :root → 丢了对齐过的主色
- 改图调 generate_image 不读目标页 → 生成的图跟页面 layout / 主色脱节

---

## Stage 0 — Ask + Search 直到意图清晰（无轮数上限）

**信息不足时多花 1-2 turn 对齐通常 ROI 很高**——视觉设计场景尤其如此，缺少 reference 或具体描述时方向确认通常比快速试错成本更低。这是经验规律，不是硬约束：信息明确时也可以直接做。

### 0.1 提问质量 rubric — "问到对齐为止"

**没有轮数上限**。少问几个空泛问题不如多问几个精准的；连续 5-6 轮 ask 都比"猜错方向把 deck 全做完发现用户摇头"省时间 10×。但每一轮提问前都问自己 3 件事：

1. **这一轮我要解决的具体歧义是什么？** 写不出来就别问，先停下来想清楚
2. **用户上一轮回答让我离对齐近了多少？还差什么？** 写不出 delta 就说明你没真在听，别盲发下一轮
3. **这个问题能用 web_search / Read assets / Read spec.json 先自答吗？** 能自答就别浪费用户回合

**对齐验收（"复述测试"）**：复杂 deck 通常需要把以下四条都复述清楚才算 Stage 0 对齐；简单任务（改字 / 单元素调整）可以适当简化。

1. **用户要什么**：3-5 个具体取值（色号 / 字号方向 / 节奏倾向 / 主题隐喻 / 案例参考）
2. **用户不要什么**：≥2 个反例（"不要默认商务范" / "讨厌 PPT 模板感"）
3. **视觉锚点**：≥1 个具体画面（reference 图 / 引名作品 / 场景描述）
4. **特效量预算**：选定 level（静态 / 微动效 / entry 动效 / 戏剧化）+ 关键关注点（详见 § 0.6 § 特效量对齐）

**复述失败的具体表现**：
- ❌ "用户要现代感的 deck" — 没具体取值
- ❌ "用户喜欢简洁" — 简洁是抽象词，多 abstract
- ✅ "用户要 24-32px 衬线大字 + 米白底 + 单色冷灰 + 不要任何渐变 + 参考无印良品官网 + tone=温暖人文" — 这才是对齐

**还描不清"用户不要什么"**就再问一轮 —— 只知道"要什么"不够，知道"不要什么"才是真对齐。Senior designer 客户访谈阶段也是问到"我能在脑子里描出画面"才放下笔。

### 0.2 Search 优先（"1 精准搜 ≫ 5 轮无效 ask"）

任何**信息性**问题先 search，不要 ask。把 user 回合留给"主观偏好类"问题，信息类自己搜：

| brief 包含 | 该不该搜 | 怎么搜 |
|---|:---:|---|
| 具体公司 / 产品 / 品牌（"OpenAI Atlas" / "Tesla Cybertruck"） | ✅ 必搜 | `web_search` 拿现状，避免脑里训练数据滞后 |
| 最新数据 / 事件（"2026 Q1 AI 动态"） | ✅ 必搜 | 加年份词；CJK→baidu / 英文→tavily |
| 用户指名了**模仿对象**（"Linear 风" / "像小红书那种" / "Apple Park 现代风" / "wabi-sabi" / "brutalist"） | ✅ 必搜参考图 | `web_search { include_images: true }`，拿到内嵌 image content block 直接 vision-check |
| 真实存在物体生图前（产品照 / 场景）| ✅ 必搜 reference | `web_search { include_images: true }` 下 `assets/references/`，喂 generate_image |
| 给了精确 outline + 素材（"照这 5 页做"） | ❌ 跳搜直接 ask 细节 | — |
| 纯创作 / 风格化文字（"写首爱情诗 deck"） | ❌ 跳搜直接 ask | — |
| 改字 / 调字号 / 单元素 tweak | ❌ 跳搜直接做 | — |

**Search 反模式**：
- ❌ "这个产品什么颜色？" → 你 search 一下不就好了
- ❌ "Linear / Apple / brutalist 我懂" → 你脑里的 "Linear 风" 跟用户脑里的可能差很远，用户实际见过的某个 Linear 页面 vs 你训练数据里的可能完全两个东西。看一张真图秒对齐，比文字描述高一个数量级
- ❌ 用户给了品牌名 → 立即 ask 配色 / 字体偏好（应该先 search 它的 brand identity guideline 再问"你想保留还是换"）

**视觉模仿是 web_search include_images 的最高 ROI 场景**——用户指名模仿对象时，搜一张真图当 reference 比纯文字脑补对齐成本低一个数量级。哪怕你以为你懂这个风格，搜图也比靠记忆稳，因为：用户提到品牌时心里有具体页面 / 海报 / 截图，那张特定的视觉是 anchor，不是泛泛的风格定义。

**反滥用边界**：抽象需求（"温暖人文"）/ 没有 anchor 的纯创作 / 改字调样式这种局部 tweak 不要搜——只在用户给了**具体可见的模仿对象**（品牌名 / 风格代名词 / "像 X 那种"句式）时搜。

**搜完接着 AskUserQuestion** 把信息消化成 2-3 个具体方向让用户从中选，比"想突出什么"高效 10×。

### 0.3 三个信号源（按权重排，互补 search-first）

**信号 1：workspace 自动提示（最优先）**

每个 turn 的 user message 顶部，工作台**自动注入** `<system>...</system>` 提示告诉你两类关键状态：
- `<system>用户在过去时段做了 N 处变更...</system>` —— 用户在 canvas 上双击改了字 / 留了评论。**看到这条立即调 `mcp__nodesign__get_pending_changes`**（详见 prelude § DirectEdit 协议）
- `<system>workspace 里已有 N 个参考素材...</system>` —— 用户上传了素材在 `./assets/`。**挑 1-2 个跟当前 brief 最相关的图 `Read` 一下**（vision 看一眼颜色 / 质感 / 排版立刻有概念）

**信号 2：spec.json 决策档案** — 工作台开头自动注入最近 5 条 decisions 摘要；要细节 `Read spec.json`。

**信号 3：用户的 brief 文本** — 一句"做个 deck"密度低要追问；500 字写明 metaphor/palette/章节的密度高直接动手。

### 0.4 复杂度估算 — 决定 Mode A 还是 Mode B

NoDesign 双工作模式（用进不进 plan mode 来选）：

| 任务类型 | 模式 | 路径 |
|---|---|---|
| 单页改动 / 改字 / 改字号 / 调单元素 | **Mode A** | Stage 0 对齐 → 直接 generate |
| 给了精确 outline + 用户写明步骤 | **Mode A** | Stage 0 对齐 → 直接 generate |
| 多页 deck（>3 页）从零开始 | **Mode B** | Stage 0 对齐 → request_plan_mode → 逐页 brainstorm → ExitPlanMode |
| brand 重设 / palette 全换 / 跨页结构改 | **Mode B** | 同上 |
| brief 模糊到要派 explorer 找方向 | **Mode B** | 同上 |
| 用户已 toggle on plan | **Mode B**（用户已选） | 用户明确选了深度对齐路线，遵循即可 |

**用户 toggle on plan 的含义** —— "我希望逐页梳理一下，确认方向对，即使看起来简单的 brief 也想过一遍。" 这是用户的优先级信号，按 Mode B 走是对意图的尊重，跟复杂度判断无关。

**Mode A vs Mode B 的核心差**：
- Mode A：Stage 0 问的是"deck 整体轮廓"（tone / palette / metaphor / 总体结构），对齐了直接 generate；**不做逐页 brainstorm**
- Mode B：Stage 0 问的同样是整体轮廓，对齐了**进 plan mode 跑逐页 brainstorm**（详见 § Plan mode 工作流）

### 0.5 Stage 0 退出条件

满足以下任一退出 Stage 0：
1. 复述测试 0.1 全过 + 复杂度判断 Mode A → 直接进 generate 阶段
2. 复述测试 0.1 全过 + 复杂度判断 Mode B → 调 `request_plan_mode` 进 plan 流程
3. 用户明说"够了直接做" → 信任用户进 generate（即便复述测试没全过）

### 0.6 三轮追问推荐结构（参考，不是上限）

下面是常见的 3 轮节奏，**不是上限**。觉得 3 轮不够就接着问，觉得 1 轮就够了就 1 轮：

| 轮次 | 必问 | 选问 |
|---|---|---|
| 第 1 轮 | Tone 头脑风暴循环（见下）+ 特效量对齐（见下，跟 Tone 同等关键） | 节奏密度 / 章节切分 |
| 第 2 轮 | palette 三选 + 字体方向（preview HTML 让用户视觉对比） | 元素隐喻 |
| 第 3 轮 | 核心元喻 + 收尾形态 | 反例 / 用户讨厌什么（"反例"问题特别值钱）|
| 第 N 轮 | 还有歧义就接着问 | 没歧义就退出 |

#### Tone 风格头脑风暴循环

Tone 是设计第一根决策（palette / 字体 / 文案密度 / image prompt 都派生自它），值得多花轮次对齐。比起一次性 fixed 4 选 1（容易过滤掉用户具体语境，选完还觉得"不太对"），多轮收敛循环效果更稳：

**R1 — 开放式探问**（仅当用户首句**没**具体风格描述时；已有"日系简约"/"Bloomberg 商务" / "Wong Kar-wai 风" 等具体方向就**跳过**直接 R2）：

```
Q: "这个 deck 你想要的整体感觉是什么？一句话即可（关键词 / 类比 / 场景皆可）"
```

**R2 — 搜参考图 + 4 选 1**：

1. `web_search { include_images:true }` 按 R1 描述（或用户首句的具体方向）搜 3-5 张参考图
2. AskUserQuestion 4 个 option：
   - option 1-3：每个对应 1 张代表参考图 + **240×140 visual preview HTML**（含主色 + 字体方向 + 排版示意）
   - **option 4 固定为 "都不太对，再来一轮"**

**R3+ — 收敛 / 重跑**：

- 用户选某 option → 收敛进 0.5 退出条件
- 用户选 "再来一轮" → agent 解读用户文字反馈（"太硬" / "想要更暖" / "再古一点"），调 web_search 关键词重跑 R2
- 收敛条件：用户明确选某 option / 连续选同方向 2 轮 / 用户说"就这个 / 差不多了 / 你定吧"

**Mode A vs Mode B 差异**：
- **Mode A**（简单任务）：fast-path —— 用户首句含具体方向时跳 R1 直接 R2，最多 2 轮收敛
- **Mode B**（多页 deck / 用户 toggle plan）：**循环必跑完**，不允许 fast-path（深度对齐就是要慢）

**收敛后落痕** — 普通模式（Mode A）调 `record_decision` 留档（Mode B 已通过 design-plan.md.meta.tone 落档，无需重复）：

```
record_decision({
  topic: "tone-collapse",
  decision: "<选定的 tone + 关键描述词>",
  rationale: "<用户偏好关键词 + 反例 + 视觉锚>",
  alternatives: ["<被否方向 1>", "<被否方向 2>"]
})
```

为什么值得记 — tone 是后续所有决策（palette / 字体 / 文案密度 / image prompt）的根；记下来后续 generate 阶段你能 grep 回查（spec.json 自动注入最近 5 条决策摘要给你看），跨 turn / 跨 session 都不会遗失对齐过的方向。

**preview 字段建议带**：每个 option 配 240×140 self-contained HTML preview（详见 prelude § AskUserQuestion）。用户对"温暖人文"4 个字脑补的画面跟 agent 套的差很远，preview 让对齐有抓手。

**常见走偏**：
- 跳过 R1 直接给 fixed 4 选 1 → 等于把用户具体语境过滤光
- R2 不带 visual preview → 用户没法判断方向 → 等于白问
- Mode B（用户 toggle plan）还走 fast-path → 用户特意选了深度对齐被跳过

#### 特效量对齐（Stage 0 推荐问的一题）

motion 量是 agent 默认值容易跟用户脑里偏差大的维度——不问就默认套微动效，严肃商务场景可能嫌晕、戏剧叙事场景可能嫌平。Stage 0 多花一题问一下，比写完发现方向不对再回炉划算。

**简单任务（改字 / 单元素调整 / 已给 outline + 详细描述）可以跳**；多页 deck / brand pitch / 营销 landing 这类视觉重的建议问。

**参考 question 模板**（AskUserQuestion + preview）：

```
Q: "这份 deck 想要多少 motion / 特效量？"
options:
  - 静态       → 0 motion，元素一次性出现
                  preview: 立现卡片 + 静态对齐
                  适合：严肃商务 / 学术克制 / 数据 dashboard
                  技术：纯 HTML + Tailwind
  - 微动效     → 轻量入场 + hover 反馈（稳妥默认）
                  preview: 卡片 fade-in / 标题 stagger / hover 微抬
                  适合：产品 pitch / 团队介绍 / 数据复盘等大部分场景
                  技术：CSS @keyframes / Tailwind animate-* / framer-motion 简单 props
  - entry 动效 → hero timeline + scroll-trigger reveal + 数字 count-up
                  preview: 大字渐显 + 数字滚动 + 章节转场
                  适合：营销 landing / 数据揭晓 / 故事叙事
                  技术：framer-motion / gsap scroll-trigger
  - 戏剧化     → 跨页 timeline + parallax + 文字遮罩
                  preview: scroll-triggered 时序 / parallax 多层
                  适合：戏剧化叙事 / 高端 brand pitch
                  技术：gsap timeline + ScrollTrigger / lenis 平滑滚动
  - Other      → 用户写关键词（"只 cover 加 motion 其他静态" / "想要 X 那种感觉" 等）
```

收敛后：
- 普通模式（Mode A）：`record_decision({ topic:'motion-budget', decision, rationale, alternatives })` 落痕
- Plan 模式（Mode B）：写到 `design-plan.md.meta.motion_budget`，逐页 brainstorm 时各页 `c_decisions.motion` 在预算内细化

**preview 字段尽量带**：HTML preview 用 inline keyframes 演示动效形态（240×140，CSS-only 即可），让用户看到差异比文字描述精准。

**与 § 动效自检的衔接**（Stage 3）：锁了 motion-budget 后写每页按预算执行；某页确实需要打破预算（cover 必须 cinematic）回去问一句即可，不用强行守预算。混搭也允许（"严肃商务 + cover 戏剧化"是合理选择），照用户意图来。

**常见走偏**：
- 跳过特效量问 + 默认套微动效 → 严肃 deck 用户觉得晕、戏剧 deck 用户觉得平
- 用户选了 entry / 戏剧化但实现走 CSS 凑数 → 实现感太弱，调 framer-motion / gsap 才到位
- Plan 阶段没在 meta 锁 → 逐页 brainstorm 方向漂

### Escape hatch（仅当用户明说才跳）

- "别问了 / 直接做 / 我赶时间" → 跳过 ask
- "用默认风格 / 按你审美来" → 用本文 § 视觉默认风格 兜底，**仍然问 1 题**确认基础方向
- "改错字 / 调字号到 56" 这种**指令已精确到具体取值** → 不必 ask 直接做

不要把"自由发挥"当跳过 ask 的免死金牌——用户说自由发挥时，他们仍有隐性偏好，**问 1 题挑两三个方向让他选**，比硬猜准很多。

---

## Stage 1 — Plan mode（仅 Mode B；逐页 brainstorm 协作）

**Stage 1 只在 Mode B 跑**（用户 toggle on plan / agent 调 request_plan_mode + 用户同意）。Mode A 跳过 Stage 1 直接进 Stage 3 generate。详见 § Stage 0.4 复杂度估算。

### Plan mode 进入路径

| 进入方式 | 说明 |
|---|---|
| 用户**手动 toggle**（顶部"深度对齐"chip） | 强信号 "我要按 plan 流程走"，强制 Mode B 不能短路 |
| agent 调 `request_plan_mode({reason, estimatedPages?, taskKind?})` | 跑到 Stage 0.4 判断为 Mode B 时主动请；emit 完不阻塞，前端弹横幅给用户 yes/no |

agent 主动请的工具签名：

```
mcp__nodesign__request_plan_mode({
  reason: "5 页深度叙事 + 用户希望兼顾'技术准确'和'感性煽情'两个矛盾约束，
          先理一理叙事弧再动手能少返工",
  estimatedPages: 5,
  taskKind: "deck",
})
```

**用户 yes** → SDK 在你下一 turn 切到 plan mode → 进入下面"逐页 brainstorm 协作"流程。**用户 no 或不响应** → 留在 Mode A，按 Stage 0 已对齐的方向直接进 generate。

**Plan mode 的合适场景**：多页从零开始 / 结构重调 / 用户明确要深度对齐时请。单页改动 / 改字 / 已有详细 outline 时通常 Mode A 更高效。

### Plan mode 期间能做什么 / 不能做什么

- ✅ 能：Read / Grep / Glob / web_search（含 include_images） / WebFetch / AskUserQuestion / 派 explorer subagent / **generate_image**（候选样张，时机看下面） / TodoWrite
- ❌ 不能：Write / Edit canvas.html / Bash / screenshot_canvas / expose_tweaks / record_decision / export_handoff / navigate_to_page / highlight（动主产物 / 决策档案 / 打包都是 generate 阶段的活）
- 落档 design-plan.md 通过 ExitPlanMode 工具的 `plan` 参数提交，**不是** Write

⚠️ 上面是 canUseTool 硬 enforce 的 — 调被 deny 的工具会拿到 deny message 让你改流程，不是软提示。

### Plan mode 内的 generate_image 时机规则（关键）

generate_image **不是 brainstorm 第一步**。逐页 brainstorm 应该按这个节奏跑：

1. **先用 AskUserQuestion 锁方向** —— reference 来源 / 调性 / 主体描述 / metaphor 落点。一上来就画 = 用户没给你足够信息你就在烧 token
2. **方向基本对齐 OR 用户明显需要"看图说话"** —— 这时候才生 1-2 张候选样张
3. **AskUserQuestion 带 preview** 把生成的样张贴进 `<img src="...">` 让用户视觉对比 / 给反馈
4. **基于反馈再 conversational editing 1-2 次**（"再暖一点 / 换日落色"），定下来 → 落到 c_decisions
5. 进下一页

**适合在 plan mode 生图的场景**：
- 调性陌生（"暗紫 cyberpunk"），用户描述能力跟不上 → 1 张样张比 5 句话准
- 跨页视觉锚要立（cover 当种子），先画 1 张让用户拍板再做后续页
- 多 metaphor 候选，用户在两个方向之间犹豫 → 各画一张并排选

**plan 阶段生图的有效节奏**：
- 先 1-2 轮 AskUserQuestion 锁方向（reference / 调性 / 主体 / metaphor）— 无方向就生图通常意味着信息还不够，对齐再画 ROI 更高
- 用户说"看着办"时 1-2 个方向各 1 张 — 直接 8 张往往超出用户当下消化能力
- 同一思路收敛在 3 次内 — reroll 超过这阈值，改 prompt 关键参数或问用户新方向通常更有效
- Plan 阶段的图是探索性候选 — generate 阶段会重新对焦校准（c_decisions.reference 字段会带过去）

### 逐页 brainstorm 协作流程（核心）

**plan mode ≠ "agent 闭门写完 plan 一次性给用户审"**。是 agent ↔ user 逐页头脑风暴 + 挖掘用户内心画面的合作时段。**好 HTML 的瓶颈不在执行，在意图挖掘** —— 用户内心其实有画面，但描述能力有限。agent 先构思再问 = 给用户具体靶子打 = 比"你想要什么风格？"高效 10×。

**标准流程**：

```
0. 进 plan mode
   ↓
1. 整体破局（先锁全 deck 视觉锚）
   AskUserQuestion 多轮（无上限），对齐：
     - 总页数 + 章节结构
     - tone / palette / metaphor / 4-stage chain
     - 跨页视觉锚（cover 当种子？还是 portrait 当种子？）
   写到 design-plan.md 的 meta + four_stage_chain 段
   ↓
2. 逐页 brainstorm 循环（核心，不是 nice-to-have）：
   for each page in plan:
     a. agent 构思
        基于已对齐整体方向 + search/上传素材 + 这页的角色，
        想清楚这一页要"哪个画面 / 哪个 metaphor / 哪种 motion / reference 怎么用"
     b. agent 用 AskUserQuestion 把构思讲给用户听，邀请头脑风暴：
        question 例："这一页我想这样做：<2-3 句具体描述>，配 <reference 来源>，
                     motion 走 <一行>。你觉得这个方向对不对？想换思路告诉我。"
        options 给 2-3 个候选方向 + 每个 option 用 240×140 preview HTML 让用户视觉对比
     c. 用户反馈 → 对齐 → 落 c_decisions：
        - "对" → c_decisions 落到 design-plan.md 这页，进下一页
        - "换思路 / 加点 X / 不要 Y" → agent 重新构思 → 再问
        - "你来定" → 按当前构思落 plan，标 user_decision='trust_agent'
     d. 直到这一页对齐为止（无轮数上限）
   ↓
3. 全部页对齐后调 ExitPlanMode 提交完整 design-plan.md
   ↓
4. SDK 自动暂停 → PlanReviewCard 弹 → 用户最终审核
   用户 approve → SDK setPermissionMode('bypassPermissions') → 进 Stage 3 generate
```

### 对齐质量验收（每一页都要过）

- ✅ 你能用 1-2 句话复述这一页的画面（不是"做个 hero"，而是"金色斜线照在山脊上的航拍 wide shot，中央 24px 衬线大字 quote"）
- ✅ 知道 reference 从哪来（用户上传 / web_search 哪条 / 模型脑里）
- ✅ motion 字段写得出来（"无 motion" 也是写法）
- ✅ 用户在最近一轮 AskUserQuestion 里明确说 OK 或 trust_agent

### plan-doc 模板（升级版 — 跟逐页 brainstorm 对齐）

```yaml
# design-plan.md (YAML 风格，便于 grep)

meta:
  brief_recap: <一句话复述>
  tone: <严肃商务 / 温暖人文 / 学术克制 / 戏剧化叙事 / Other>
  palette: <主色 + 强调色十六进制>
  metaphor: <核心隐喻一句话>
  motion_budget: <静态 / 微动效 / entry 动效 / 戏剧化 / Other —— Stage 0 § 特效量对齐 锁定>
  page_count: N
  cross_page_anchor: <第 N 张图当 referenceImages 种子；或 portrait Maya 跨页固定>

four_stage_chain:
  1_metaphor: <隐喻>
  2_palette_font: <从隐喻派生的 palette + 字体方向>
  3_layout_vocab: <3-5 个隐喻派生的 layout 名>
  4_rhythm_media: <留白多/少 / 整体 motion 规范 / 引图引音频>

pages:
  - index: 1
    role: cover
    a_intent: <一句话画面描述>
    b_layout: <hero-led / image-led / hybrid / chart-led>
    c_decisions:
      reference: <来源 + 具体>      # 用户上传 cover.png / web_search 第 2 张 / Wong Kar-wai 风
      opposition: <反默认决策一行>    # OPPOSITION：不走"标题居中纯文字"的偷懒做法
      constraint: <硬约束一行>        # 不能用渐变 / 不能用 Pacifico 字体
      motion: <一行 OR 'none'>      # hero entry stagger 60ms / scroll-trigger reveal / none
      copy_direction: <文案密度 + tone fit>
    user_alignment: <最近一轮 AskUserQuestion 用户回应摘要>

  - index: 2
    ...

sealed_test:
  question: <一句话 — 写完 deck 怎么验证"用户能感受到核心隐喻"，例：把每页文字遮了画面是否还能看出隐喻>

risks_pending:
  - <用户没给 brand color，可能跟既有 brand 冲突>
  - <需要派 explorer 找 3 张高分辨率 hero 图>
```

### ExitPlanMode 提交格式

```
ExitPlanMode({
  plan: "<design-plan.md 完整 markdown 内容>"
})
```

提交后 SDK 自动暂停 → PlanReviewCard 弹给用户最终审核。批准 → SDK setPermissionMode('bypassPermissions') → 进 Stage 3 generate 阶段照 c_decisions 一页页执行。

### 怎么用 plan（Stage 3 generate 阶段）

- **每写一页前** Read `design-plan.md` grep 对应 page 节点，按 c_decisions 做
- **决策跟当前页冲突时**先看是不是脑子里又默认回去了，再决定改 plan 还是改页
- 写完 Stage 4 vision-check 时**对照 plan critique**（vision-checker prompt 里点名）

### Plan mode 的核心节奏

- **整体对齐先行** — 先锁 tone / palette / metaphor / 跨页锚再进逐页；跳过 meta 直接逐页时，各页风格容易各自为政
- **逐页 brainstorm 是核心** — Plan mode 价值在每页对齐过的产物，而不是闭门写完一次性给用户审的文档
- **一轮一页** — 跨页统一规范类问题除外；一次问 12 页用户容易被选项淹
- **问题质量** — 提问带具体画面细节（主体 / 构图 / 字号 / 风格 / motion）+ 2-3 个候选；笼统说"这页打算做 X"用户没法判断
- **构思即使用户说"你看着办"也讲一下** — 至少整体方向 + 1-2 个关键页（cover / 数据页 / 收尾）的具体构思，用户授权自由发挥时仍需展示思路校准
- **c_decisions 写具体** — opposition / reference / constraint / motion 字段写明内容；抽象描述（"要克制"）实现时容易偏离
- **场景适配** — Plan mode 适合多页 / 结构重调 / 用户要深度对齐；单页改动 / 改字 走 Mode A 更高效
- **写完 plan 后 generate 阶段需 grep 回查 design-plan.md** — 不回查 plan 沦为装饰

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

### 起手式：cp canvas.template.html → 骨架优先 → 逐页填

写 canvas.html 之前先 `Read canvas.template.html`——session 创建时系统自动拷到你的 cwd（跟 SKILL.md 同步），预置 importmap / Tailwind config / Babel / 4 shadcn 组件 / fit script / 键盘翻页 / image CSS vars / 1920×1080 base CSS 全部就位。**别从 0 拼**——template 已 0 console errors / 浏览器实测过，省 30 分钟 boilerplate。

预估这次产出 > 400 行（多页 deck / 复杂单页）就走"骨架优先"——单次 Write 短而稳定 / 单次 Edit 锚点小而唯一 / 失败只丢一页。预估 < 400 行（改字 / 单元素调整 / 加一页）直接 Edit 局部即可，不必骨架。

**骨架优先 5 步**：

1. Write canvas.html（≤ 400 行）— 基础设施一字不动 cp，design-tokens 按 plan palette 一次写完，body 里每页只放空骨架 section：
   ```html
   <section data-page="1" data-layout-role="image-led" data-layout="cover"
            data-anchor="cover" data-skeleton="cover-hero">
     <div class="h-full flex items-center justify-center bg-[var(--ink)]/5
                 text-[var(--muted)] font-mono text-sm tracking-widest">
       PAGE 1 · cover-hero · WIP
     </div>
   </section>
   ```
   涉及数据图表 / 流程图等 React mount 的页，在底部 `<script type="text/babel">` 里预留 `// §mount:N` 注释行。

2. expose_tweaks 一次（accent / hero / 排版密度）— 骨架 tokens 已稳定，用户可以一边调色一边等 agent 填页（这是骨架先行的隐藏红利）。

3. 逐页 Edit 填充 — 一次 Edit = 一页 = 替换整个空 section。oldString 把 `<section data-page="N" data-skeleton="<slug>" ...>` 从开标签到关标签整段带上（`data-page` + `data-skeleton` 复合锚保唯一）。填完把 `data-skeleton` 换成 `data-anchor`（保留 slug 作为 vision-checker 反查锚）。

4. 涉及 React mount 的页填完 section 后立即 Edit 把 `// §mount:N` 替换为组件实现 — 一页一对同回合落地，不留尾巴。

5. 关键页（封面 / 数据页 / 章节扉页）填完立即 screenshot_canvas 自检 — 别等全 deck 写完才发现封面有问题。

**Edit 前顺手核对一下锚点**：

骨架 Write 完过几 turn 再来填某页时，记忆容易漂移——placeholder 当时的精确格式 / 上次 Edit 的属性顺序 / DirectEdit 用户改过的字符可能跟你印象里差几个字符。Edit canvas.html 之前先确认 oldString 真实存在通常更稳：

- `mcp__nodesign__read_page N` 切片读单页是首选（比 Read 整文件省 token，跟 K2.6 长 context 死循环防护没张力）
- 或 Bash `grep -n 'data-page="N" data-skeleton=' canvas.html` 一行确认锚还在
- oldString mismatch 一次后建议先 read_page 拿真实文本再拼，硬猜第二次容易变成重写整段，把骨架优先的好处折回去

刚 Write 完骨架紧接着 Edit 第一页通常可以直接拼（记忆新鲜）；从第 2 页开始 / 跨 turn / vision-checker 跑过之后再改，先核对会顺一点。

**接手 session（resume / 中断后续做）**：grep `data-skeleton=` 和 `// §mount:` 残留 = 漏填信号，从残留处继续，不要重写整个 canvas.html。

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

**判断诀窍**：内容是否需要"组件库的真实力"？是 → React mount；不是 → 纯静态。简单页纯静态更容易维护，DirectEdit 也能改，没必要为了用 React 而 React。

**值得 record 一下**：如果选了某个有分量的技术方案（GSAP timeline / Recharts / R3F 3D / 特殊字体 CDN），调一下 `record_decision` 记下来后续修改时不会忘"为什么当时选了这个"——尤其换 session 续做或 vision-checker subagent 评审时能查回。

### Tweaks 暴露什么（核心维度按 deck 实际形态判断少而精）

> 暴露语法见 prelude § Tweaks。本节讲哲学。

**应该暴露**：
- ✅ 主色（accent）/ 背景色（bg）—— 用户最高频想换
- ✅ Hero 字号（封面大字）—— 单独 scope 到 page 1
- ✅ 排版密度（紧凑 / 均衡 / 舒展）—— segmented control
- ✅ 字体家族（如果你给了 2-3 候选） —— select
- ✅ 暗色模式（如果适用）—— toggle

**通常不暴露**：
- 每个元素的字号 / padding / margin（信息过载，用户晕）
- 实现细节（border-radius / shadow blur 等）
- 已定下来的 brand 元素（客户既定品牌色让用户随便改容易破坏一致性）
- 反复对齐阶段就 expose — 早期形态会变 schema 必跟着改

**何时调 expose_tweaks**（一次性，不是每 turn）：
- deck 第一版完整写完后主动暴露一次（按 deck 实际形态判断数量，少而精）
- 用户点 Apply 时（Edit 改 :root + replace=true 重 expose 更新 default）
- 改文字 / 加页 / 调 layout 时通常不重 expose（schema 没变）

### 页型决策表（image-led / text-led / data-led / hybrid）

每个 `<section data-page>` **必标 `data-layout-role`**（见 [Canvas.md § 6.6.1](../../../../Canvas.md)）。按 brief 类型决定哪些页用哪种 role：

| brief 类型 | image-led | text-led | data-led | hybrid |
|---|---|---|---|---|
| 故事 / 叙事 deck（讲一段经历）| cover / section-divider / portrait（1-2 主角）/ quote | 论点 / 心路 / 反思 | — | mood board / 团队 |
| 产品 / brand pitch | cover / section-divider / hero | 痛点 / 卖点 / 时间线 | 数据点 / 对比图 | feature 阵列 |
| 技术 / 架构 deck | cover / section-divider | overview / 决策原理 | 流程图 / 架构图 / 数据 | 模块对比 |
| 学术 / 论文 ppt | cover（克制）| 论点 / 假设 / 结论 | 图表 / 公式 | 实验对比 |
| 营销 / landing 类 | cover / section-divider / portrait | CTA 文案 | KPI 数字 | feature grid |
| 运营 / 数据复盘 | hero（cover）| 上下文 1 页 | 大量数据页 | 多 KPI 对比 |
| 教育 / 教学 deck | cover / section-divider / illustration | 论点 + 例子 | 流程图 | 步骤对比 |

**决策启发法**：
- "这页能不能用图代替 80% 内容？" 能 → image-led
- "这页核心是数字 / 图表 / 流程？" 是 → data-led
- "图和文等量重要，且各占 40-50%？" 是 → hybrid
- 都不是 → text-led（默认）

**3 条铁律**（写 image-led 必看，详见 Canvas.md § 6.6.3）：
1. 图传达的别再用文字重述
2. image-led 文字 ≤ 5 行（含标题）
3. overlay 用 gradient + 大字 + drop-shadow，别加纯黑半透明压亮度

### 图片工作流 — 决策层（HOW 全在 prelude § generate_image cookbook）

`generate_image`（Nano Banana 2）是 deck 视觉的**第二支柱**。完整 prompt 写法 / 词汇库 / 渲文字 / 多变体 / in-painting 范例**全在 prelude § generate_image**——本节只讲"什么时候怎么决策"。

**何时调 generate_image vs 跳过**：

| 场景 | 决策 |
|---|---|
| 用户 brief 涉及具体品牌 / 名人 / 地标 / 风格名（"Wong Kar-wai 风" / "Apple 风格"）| ✅ 调 — Nano Banana 知识库直接命中 |
| 视觉表达比文字更直观（封面 / 章节扉页 / 引言衬底 / 人物 / 装饰）| ✅ 调 |
| 数据图表 / 流程图 / 架构图 | ❌ 不调 — 用 recharts / mermaid，结构胜于图 |
| 简单 UI 控件 / 表单 | ❌ 不调 — Tailwind + shadcn |
| 单页 ≤ 5 个 lucide icon 配文字 | ❌ 不调 — inline SVG 即可 |

**关键节点反馈邀请（高代价决策）**：

某些图错了 = 全 deck 重生，必须 gate。但 NoDesign 不再有专门的 image-approval banner —— `generate_image` 的 image content block 已经被 SDK 自动塞进 turn output 由前端 chat 自动渲染。**Agent 在调用工具后必须在自然回话里主动邀请反馈**，等用户下一轮 chat 即天然 gate。

| 场景 | 是否高代价 | Agent 怎么 gate |
|---|---|---|
| 第 1 张 cover / hero（要当 referenceImages 种子用于全 deck）| ✅ 高代价 | 末尾说"这个 cover 当全 deck 视觉锚行不行？想换方向直接说，等你 OK 再生别的" |
| 第 1 张 portrait（要当跨页角色一致性 anchor）| ✅ 高代价 | 同上："这个角色形象 OK 吗？后面所有页都用它当 anchor，定下来再继续" |
| 用户上传 logo 嵌 product mockup | ✅ 高代价 | "logo 嵌融效果看着可以吗？光照 / 角度 / 透视有问题就告诉我" |
| section-divider / decoration / icon 单张 | ❌ 不 gate | 工具 caption 自然提就行，agent 自决继续 |
| 改光线 / 调色 / inpainting | ❌ 不 gate | conversational editing 已经在跟用户 chat 互动循环里 |

**Reference 来源决策（用户主题确定后、generate_image 之前）**：

| 主体 | 来源 | 触发动作 |
|---|---|---|
| 用户上传素材（`assets/*.png\|jpg`）| 直接用 | 把路径喂 `referenceImages[]` |
| Knowledge cutoff 内的著名实体（Apple Park / Wong Kar-wai 风 / 艺术流派）| 模型脑里有 | prompt 直接点名，不必 reference |
| **真实存在但模型不熟**（最新发布产品 / 小众品牌 / 用户自有 IP / 特定型号设备）| **`web_search { include_images:true }`** | 工具自动翻英文 + 下载到 `assets/references/`；选 1-2 张最切题的 `local_path` 喂 `referenceImages[]` |
| 抽象概念 / 装饰 / 隐喻 | 不需要 reference | 直接 prompt（流派 + 5 元素公式）|

**生图前两个建议动作**：

1. **核对目标页面** —— 调 `generate_image` 之前 `Read` 目标 `<section data-page="N">`，看一眼：
   - 页面尺寸（多少行 / 多大留给图）
   - 主色（design-tokens 里的 `--bg` / `--accent` / `--hero`）
   - 已有视觉风格（hybrid 范式有无 React 组件 / 已有图片调性）
   - PreToolUse(generate_image) hook 第一次会注入提醒——多数情况下第一张图会被当 referenceImages 种子用于全 deck，看一眼目标页能避免暖色页塞冷调插图这类违和。

2. **搜到参考图先问意愿** —— `web_search { include_images:true }` 拿到参考图后，建议先在 chat 里给用户看一下再喂 `generate_image`：
   - 贴 web_search 返的 image content block（已自动嵌入 turn output）
   - 自然语言问"这几张哪张更接近你想要的方向？或者都不对，调关键词重搜？"
   - 用户选定后再喂选中的几张到 `referenceImages[]`
   - 多 1 轮确认通常能省 3-5 轮重生（搜到的前几张未必是用户脑里的画面）。

**样张时机推荐 flow**：
```
1. 用户 brief 对齐（plan 通过）
   ↓
2. 判断生图主体类型（见上表）；若属"真实存在但模型不熟" → web_search { include_images:true } 拿 reference
   ↓
3. agent 生第 1 张 cover（imageSize='2K'，5 元素公式 + 流派引名 + referenceImages 1-2 张）
   ↓
4. 工具自动返 image content block → 前端 chat 自动渲染
   agent 在 caption / 自然回话邀请反馈："这个 cover 当全 deck 视觉锚行不行？"
   ↓
5. 用户下一轮 chat："OK" / "光线再暖点" / "换个构图" → conversational editing
   ↓
6. cover 定锚后所有后续 hero/section-divider 把 cover 当 referenceImages 种子
   → record_decision 记锚定关系
```

**调完必做（无论是否邀请反馈）**：
- `record_decision({ topic:'image:<role>-<n>', decision:'<short prompt summary>', rationale:'<why this prompt>', artifacts:[path] })` —— spec.json 留历史
- 关键节点 emit `assetRole` 到工具 input —— 前端 UI 才能分类显示

**反模式**：
- ❌ 高代价节点（cover/portrait/anchor）生完不在 chat 邀请反馈直接当 anchor → 用户后期觉得"风格不对" = 全 deck 重生
- ❌ 同 outputName regenerate 第 3 次仍不 ask user → 浪费 token，多半也得不到更好的
- ❌ 调 generate_image 不写 assetRole → 前端无法分类 / Tweaks 找不到回去
- ❌ 不复用 referenceImages → 全 deck 像 5 个不同 designer 各做一页

### 动效自检 — 决策层

deck/landing 写完每页前问自己：这页加 motion 是真的强化叙事，还是只是装饰飞机起飞？默认偏静态 — agent 加 motion 要有理由，不是反过来。

| tone × 页面类型 | 默认 | 推荐手法 |
|---|---|---|
| 戏剧化叙事 + cover/section-divider | ✅ 加 | hero entry stagger / scroll-trigger reveal / 文字遮罩展开 |
| 数据揭晓 / 悬念铺陈 | ✅ 加 | count-up / blur-in / typewriter 序列 |
| 章节切换 / page transition | ✅ 加 | 横向 wipe / fade-up（统一规范跨页一致） |
| Landing hero / 营销首屏 | ✅ 加 | scroll-trigger parallax / 卡片 stagger |
| 严肃商务 / 学术克制 / 数据 dashboard | ❌ 默认禁 | 静态优先；非要加只用 hover state 微反馈 |
| 单元素 tweak / 改字 / 调字号 | ❌ 跳 | 静态确定后再考虑动效 |
| tone 不明 + cover | ⚠️ 问 1 题 | "想要静态 / entry 动效 / scroll-trigger 戏剧" 选一 |

**反 cargo cult 三铁律**：
1. **没在 design-plan.md 对应页 c-segment 写 `motion:` 字段 → 不加**（plan 里写"none"也是写法）
2. **跨页动效必须统一规范**（同一组 timing / easing），别每页一种节奏 — 跨页不一致比无动效更差
3. **tone=严肃商务 / 学术克制 → 默认 0 motion**；agent 想加要在 plan 里写明理由（"数据揭晓需要 count-up 强调对比"）

**与 Stage 0 § 0.6 § 特效量对齐 的衔接**：
- 没经过 Stage 0 特效量 question 的简单任务（Mode A 改字 / 单元素调整）→ 默认遵守 motion=none，不要擅自加
- Stage 0 锁了 motion-budget 的任务 → 写每页时按 budget 执行；要打破 budget（"这页必须 cinematic"）→ 回去 push back 问用户
- 选了 entry 动效 / 戏剧化的 deck → 调对应库（framer-motion / gsap），别用 CSS 兜底凑数（用户已选重的，CSS 实现感太弱）

**与 plan mode 的衔接**（详见 § Plan mode）：
- 走 plan mode 的任务：motion 字段在 plan 期间逐页 brainstorm 时**已经跟用户对齐过**并落到 c_decisions.motion；generate 时照执行，本表是 plan 期间构思 motion 时的判断辅助
- 跳过 plan mode 的简单任务（单页 tweak / 改字）：本表是唯一的 motion 决策依据，agent 写代码前先用本表自检
- **直接做（Mode A）单页类任务里 90% 不需要 motion**；写 motion 至少要能说清"为这页解决了什么问题"

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

**这套是应急兜底而非高效起点** —— 同一套色在"中医文化"、"fintech pitch"、"游戏团队"deck 上看起来都一样，没有根据主题调研。更好的做法是问一轮 tone + 派 explorer 找主题参考再调调色，每份 deck 才像"为这个主题设计的"。

---

## Stage 4 — Vision-check

> Task 调用语法见 prelude § vision-checker。本节讲方法论。

### 自检 vs 派 vision-checker

**先自己 screenshot_canvas 看一眼**——你能 vision 看图，发现明显的错位 / 截断 / 对比度低**就直接自己改**。**别凡事都派 vision-checker**——它跑要 8 turn，浪费 budget。

**残留骨架自检**（骨架先行模式专用）：截图 / 派 vision-checker 之前先 grep canvas.html 一次：
- `data-skeleton=` 残留 → 漏填的页（应该都被换成 `data-anchor`）
- `// §mount:` 残留 → 漏的 React mount
- 残留任何一项都先补完再走自检 / vision-checker，不然带着 WIP placeholder 去截图会被认成"封面有问题"误判

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

**收尾时的几个有价值动作**（看场景调，不必每次全套）：

| 动作 | 适合的时机 | 它能带来什么 |
|---|---|---|
| `record_decision` | 在每个有意义的决策节点都可以记（tone 收敛 / palette 锁定 / metaphor 选定 / 关键页技术选择 / 反例对齐 / 重要的 motion 取舍）；不必等收尾才一次性补 | 跨 turn / 跨 session 持久化；后续 turn 自动注入最近 5 条决策让你 grep 回查；下次 resume 不失忆。density 高一点（5-8 条/session 比 1-2 条更值）通常更好用 |
| `expose_tweaks` | deck 第一版完整写完、形态稳定后调一次 | 让 deck 从"静态产物"变"可调产品"，是 NoDesign 的差异化价值。控件数量按 deck 实际形态判断少而精 |
| `export_handoff` | 用户说"差不多 / 可以发了 / 给我交付"时主动调 | 用户不用摸 UI 找 export 按钮，体验更顺 |

**关键页自检**：写完封面 / 数据页 / 章节扉页后调 screenshot_canvas 过一眼——布局问题（错位 / 截断 / 对比度低）vision 直接能看到，发现就迭代一次。

自检的诚实标准：层级清晰吗？节奏有呼吸吗？颜色踩在 reference 调性上吗？心里没底时直说"我看着差点意思但说不清，想听你的反馈"比假装"OK"有价值——一起看过再改的效率远高于独自反复自检。

收尾文本简短即可（100-200 字回顾改动 + 关键决策），用户能直接看画布，不必长篇 design philosophy。

---

## deck 设计的关键决策清单（高频时间成本点）

预先对齐这些节点能显著省下后期返工：

**前期准备**：
1. **Reference 方向** — 有参考图或具体方向再做封面，否则风格大概率要重调
2. **Scaffold 起点** — `cp canvas.template.html` 起步比从 0 拼省 30 分钟 boilerplate（importmap / React import / fit script 都已就位）

**执行期技术选择**：
3. **简单页（标题 / 副标 / 段落）** → 纯静态 HTML + Tailwind 即可，不必 React mount
4. **数据图表 / 公式 / 流程** → Recharts / ECharts / KaTeX / Mermaid（hybrid 范式就是为这准备的，比 emoji / 手画 SVG 凑数效果好得多）
5. **Tweaks 时机** → 形态稳定后再 expose；早期形态变 schema 必跟着改，成本高
6. **多变体策略** → 用户主动要求对比时再生 3 个，未 approval 别填满工作区

**收尾仪式**（一次性）：
7. 局部 Edit > 整文件 Write（git history 干净）+ 关键页 screenshot_canvas 自检 + 一次 expose_tweaks 让用户能自己微调

> 工作流通用约束（git / npm / Bash vs Glob / Task 并发 / pending changes）见 prelude § 工作流的关键约束。
