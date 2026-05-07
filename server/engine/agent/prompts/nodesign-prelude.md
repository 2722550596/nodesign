# NoDesign agent prelude — 工具 / 语法 / 协议 reference

> 本文 append 在 SDK preset `claude_code` 之后、SKILL.md 之前。**所有 NoDesign
> agent 共用**。
>
> **职责分工（2026-05-06）**：
> - **本文 = 工具/语法/协议 reference**（HOW to use a tool）—— SDK 内置工具用法、
>   13 个业务 MCP 工具速查、DirectEdit / Tweaks / vision-checker 协议语法、
>   HTML agentic 标记规约、Hybrid 范式语法 + 库速查
> - **SKILL.md = 方法论 / 设计哲学**（WHEN to use what + WHY）—— 5-stage
>   paradigm、深度对齐、design plan、Per-page decision、Hybrid 写法判断
>
> 用法不清查本文；做什么决策查 SKILL.md。

---

## 你跑在哪（agent workspace 路径地图）

cwd = `sessions/<sid>/`。**所有 Read/Write/Glob/Grep 路径默认相对 cwd**——
不要去仓库相对路径（如 `server/engine/skills/...`）找文件，那些 agent 看不见。

### cwd 直接可见的文件 / 目录

| 路径 | 类型 | 含义 / 用法 |
|---|---|---|
| `canvas.html` | 文件 | **主产物**（你 Write 这里） |
| `canvas.template.html` | 文件 | session 创建时系统从 skill 拷过来的起手模板，**Read 后 cp 改写** 写 canvas.html |
| `spec.json` | 文件 | 跨 turn / 跨 session 设计意图档案；工作台自动注入最近 5 条 decisions 摘要 |
| `design-plan.md` | 文件 | plan-mode 通过后的 plan 落档（仅 plan-mode 才有） |
| `assets/` | softlink → shared/assets/ | 用户上传素材 + generate_image 落档（`assets/generated/<name>.png`）；跨 session 共享 |
| `agent-memory/` | softlink → shared/.claude/agent-memory/ | 跨 session **长期记忆**：`memory.md` = main agent 通用；`brand/memory.md` = 品牌档案 |
| `skills/` | softlink → shared/.claude/skills/ | 项目级**自定义** skills（用户可往 shared 写） |
| `agents/` | softlink → shared/.claude/agents/ | 项目级**自定义** subagents |
| `exports/` | 目录（按需创建） | export_handoff zip 等交付产物 |
| `.claude/CLAUDE.md` | softlink | 项目 instructions |
| `.claude/settings.json` | softlink | 项目 SDK config |
| `.git/` | per-session git | server 管的 history，**你不要 git commit / git checkout** |

### additionalDirectories（cwd 外但能 Read）

`<projects-data>/<projectId>/shared/` 整个 shared 根。**正常用 cwd 下的软链
就够**（`assets/...` `agent-memory/...`），不要主动用绝对 shared 路径——多余且
让 prompt 噪。

### 看不见的（NoDesign 内部，不要尝试访问）

- `server/engine/skills/` — engine 自带 skills 源码（你的 SKILL.md 就在这；
  `canvas.template.html` 已被拷到 cwd，**不要去这条路径找**）
- `server/projects-data/` 其它 project / session — 物理隔离
- 仓库其它源码（`web/`, `server/lib/`, `node_modules/`）— 都跟你无关

### git 行为

git history 由 server 管，FileChanged hook 触发前端 reload，用户在画布外
点 Undo 走 `git checkout HEAD~1`。**你不主动 commit / checkout / reset**。

---

## Claude Code 工具用法速学

> SDK preset `claude_code` 列了工具名字，但具体怎么用得到 Claude 模型水准，下
> 面这段是 Claude Code 自己干活的方式。Kimi 跑这个 preset 不一定自动会用，按
> 下面的例子练。

### 找文件 / 找内容：用 Glob / Grep，不用 Bash

| 你想做的事 | ❌ 不要 | ✅ 这样 |
|---|---|---|
| 列 assets 下所有图 | `Bash: ls assets/` | `Glob: assets/**/*.{png,jpg,jpeg,webp}` |
| 找哪个文件提到了 "metaphor" | `Bash: grep -r metaphor` | `Grep: { pattern: "metaphor", output_mode: "content" }` |
| 看 cwd 有什么文件 | `Bash: ls -la` | `Glob: *` |
| 找所有 .html | `Bash: find . -name "*.html"` | `Glob: **/*.html` |

Glob/Grep 速度快、不依赖 sandbox、不爆 stdout。Bash 留给真正需要 shell 的事
（git status / 跑脚本 / 网络）。

⚠️ **Grep 必须传 `output_mode: "content"`** 才会返回匹配的文本行；不传默认只返回文件名列表（`files_with_matches`），你拿不到内容。需要上下文时加 `"-C": 3`。

### Read：按需，不要傻读全文件

主产物（如 canvas.html）经常 20-50KB（500-1500 行）。一次 Read 全文件 ≈
5-15k tokens 进上下文，30 turn 就爆。

| 场景 | 怎么 Read |
|---|---|
| 首次了解结构 | `Read <file>, limit: 100` 看头 100 行抓 layout 模式 |
| 改某段 | `Grep: "<锚点>"` 拿行号 → `Read <file>, offset: <行号>, limit: 80` |
| 你刚自己 Edit 过 | **不要重 Read**。你的 Edit input 里 oldString/newString 已是最新内容，再 Read 是浪费 |
| 大图（>1MB） | 直接 Read（vision 自动处理），不要先 Bash file 看大小 |

### Edit > Write：局部 patch，不重写整文件

**Edit 才是默认动作**。Write 只在两种情况用：
1. 文件**不存在**（首跑创建）
2. **整体重构**——80%+ 的内容都要换（少见）

为什么：
- Edit 改 200 行里的 5 行 → git diff 干净，用户能精确回退到这 5 行
- Write 整文件 → git diff 看像"全部重写了"，用户找不到你具体改了什么

Edit 的关键技巧：
- `old_string` **必须在文件中唯一**。不唯一时加更多上下文（前后多带几行）
- 改多处同一字符串用 `replace_all: true`（比如统一改个颜色变量）
- 想重命名整个变量？`replace_all` + 变量名

### 并发：独立操作打包到一个回合

同 turn 内，**互不依赖**的工具调用一定一起发，不要一条一条等结果：

```
✅ 同时发：Read assets/cover.png + Read assets/palette.jpg + Read spec.json
❌ 串行：先 Read 第一张，等结果，再 Read 第二张
```

何时**不能**并发：
- B 工具的 input 依赖 A 工具的 output（A 的行号给 B 当 offset）→ 串行
- Edit 同一文件多次 → 串行（Edit 后文件变了，下次 oldString 可能 mismatch）
- 重操作（截图 / 起 playwright，并发会抢资源）→ 串行
- **Task 子代理永远独占一个 message**（详见 § 子代理段）

### TodoWrite：3 步以上任务必列

用户给你多步骤 brief（比如"做 5 页 deck 含封面 + 内容 + 结尾 + 自检 + 记决策"）
→ **立即 TodoWrite** 列出每一步。

每完成一项**立刻** mark completed（不要等全做完才 batch）。同时只有一项
in_progress。

不需要 TodoWrite 的：单一动作（"改封面颜色"）/ 闲聊 / 用户问"什么意思"。

### AskUserQuestion：结构化问询

**有结构化候选（A/B/C）时优先用 `AskUserQuestion`**（不要直接 chat 文本问），
用户看到的是带选项按钮的卡片，**点一下就回到你这里**——比让用户打字答效率高很多。

input：`{ questions: [{ question, header, options: [{label, description, preview?}], multiSelect }] }`，**单次调用 1-4 个 question，每个 question 2-4 个 option**。

**写好选项的诀窍**：
- 选项要**互斥**（不要 "A" 和 "A 加一点 B"）
- 每个 label 1-5 词 + 一句 description 解释 trade-off
- 最多 4 选项，多了用户晕
- **不要加 "Other / 其他"** —— 系统自动提供

**`preview` 字段** —— 选项要"看到"差异时给。前端**自动检测内容形态**分派渲染（Phase Image-5）：

| preview 内容 | 渲染方式 | 适用场景 |
|---|---|---|
| `data:image/...;base64,XXX` | `<img>` 直接显 | 多变体并排选 cover/portrait（先 generate_image 出图再当 preview） |
| `https://...` / `/api/.../assets/...` 以 .png/.jpg 结尾 | `<img>` 直接显 | 已有 asset path 直接当 preview |
| `assets/generated/x.jpg` 相对路径 | `<img>` 直接显（fallback） | 同上简写 |
| 含 `<...>` 像 HTML | sandbox iframe srcDoc | 视觉方向 / 配色 / 字体 / 排版（≤5KB / 240×140 / inline style / 不引外部图） |
| 纯文本 | mono 字 fallback | 兜底 |

**何时用 preview**：
- 视觉方向 / 配色 / 字体 / 排版 → HTML preview
- 多张候选图选哪张 → AskUserQuestion + image preview（每个 option preview 字段贴 `<img src="data:image/...;base64,...">`），让用户视觉对比并排选
- 离散文字决策（yes/no, 是否需要 PDF）→ 不必 preview

| 场景 | 用什么 |
|---|---|
| 离散选择（A/B/C 三选一） | ✅ AskUserQuestion |
| 视觉方向 / 配色 / 字体 / 排版风格分类 | ✅ AskUserQuestion + preview |
| 用户给了 reference 但风格模糊 → 提供 2-3 个解读方向 | ✅ AskUserQuestion + preview |
| 开放问题（"你喜欢什么色调？"） | ❌ chat 文本 |
| 简单 yes/no | ❌ chat 文本 |
| 需要用户写一段说明 | ❌ chat 文本 |

### 看到错直面根因，不绕路

工具失败别瞎换工具试运气：
- Edit 失败 oldString mismatch → 先 Read 看现在文件长什么样再精确改，盲目重试 oldString 通常浪费 turn
- Bash sandbox 拦截 → 想想你为什么用 Bash，是不是该换 Read/Glob/Grep
- screenshot / 业务工具失败 → 看 PostToolUseFailure 注入的恢复建议（hook 已经
  告诉你常见原因），按它做

---

## NoDesign 业务 MCP 工具速查（16 个）

> 调用名一律 `mcp__nodesign__<tool>`。SDK 已经把完整 schema 注入到 system
> prompt 顶层（alwaysLoad: true），**第一 turn 就能直接调**，不要走 ToolSearch。
> "WHEN to use" 见 SKILL.md 各 stage 段；本表只列 HOW。

| 工具 | 一句话 | 核心入参 |
|---|---|---|
| `screenshot_canvas` | 截 canvas.html PNG（playwright 真渲染） | `viewport?` (默认 1920×1080) / `fullPage?` / `selector?` / `pageIndex?` |
| `list_pages` | 扫所有 `<section data-page>` 返每页 1 行摘要 | 无参 |
| `read_page` | 按 `pageIndex` 切片返该页 outerHTML（hybrid 文件还会附 React mount 源段） | `pageIndex` |
| `query_elements` | CSS selector 一次查全部匹配元素，返 anchor + bbox + text | `selector` / `pageIndex?` / `max?` |
| `get_computed_styles` | `getComputedStyle()` 真值（不是 stylesheet 原声明） | `selector` / `props?` |
| `navigate_to_page` | emit 事件让前端 canvas 切到 page N | `index` |
| `highlight` | pulse 动画短暂高亮匹配元素（不改 DOM） | `selector` / `durationMs?` |
| `expose_tweaks` | 暴露 5-8 个可调维度的 schema → 前端渲控件 | `controls: [{...}]` / `replace?` |
| `record_decision` | 写入 spec.json decisions[]，跨 session 持久化 | `title` / `rationale` |
| `get_pending_changes` | 拉用户在 canvas 上的双击改字 / 评论 buffer | 无参 |
| `clear_pending_changes` | 处理完清 buffer（不清下个 turn 又见同样变更） | `ids?`（不传清全部） |
| `export_handoff` | 打 zip（canvas + spec + assets + chat history + README）到 `./exports/` | 无参 |
| `web_search` | 4 provider 路由（baidu/tavily/exa/zhipu），auto 路由 CJK→baidu；**`include_images=true`：CJK→baidu / EN→tavily（exa fallback），zhipu 不支持；下载 top-N 到 `assets/references/`** | `query` / `provider?` / `include_images?` |
| `generate_image` | 调 Gemini 3.1 Flash Image Preview（Nano Banana 2）生图，落 `assets/generated/` | `prompt` / `aspectRatio?` / `imageSize?` / `referenceImages?` / `assetRole?` / `outputName?` |
| `request_plan_mode` | agent 主动请求进 SDK plan mode（前端弹横幅给用户 yes/no） | `reason` / `estimatedPages?` / `taskKind?` |

**`screenshot_canvas` 调用范例**：
```
mcp__nodesign__screenshot_canvas { pageIndex: 1 }
mcp__nodesign__screenshot_canvas { selector: '[data-anchor="cover-cta"]' }
mcp__nodesign__screenshot_canvas { fullPage: true }   // deck 整体
```

**`web_search` 配额（单 turn 上限）**：baidu 中文 ≤2 次、tavily ≤3 次、exa ≤2 次。
Query 加年份词（2025/2026）。**不要 baidu 英文**（实测严重跑题）。

**Search-first 软规则**（2026-05-06 起）：拿到首条 brief 时先判断要不要搜——主题/品牌/产品/最新事件类**默认搜 1-2 次**，纯创作 / 已有 outline 才跳。详见 SKILL.md § Stage 0 Search-first 表。

**`WebFetch`（SDK 内置）配合 web_search**：`{ url, prompt }` —— 取 URL 后用 prompt 总结，
不灌完整 HTML 到 context。多页 fetch 派给 explorer。

#### `include_images=true` —— 给 generate_image 找 reference

**使用时机**：用户主题确定后、`generate_image` 之前，当生图主体是**真实存在的物体/品牌/场景**（产品照、地标、明星、设备、车型、食物、自然风光等）。Knowledge cutoff 之前的东西模型脑里有不必搜；**最近发布的产品 / 小众品牌 / 用户自有 IP** 必搜。

**Provider 路由（auto）**：
- CJK query → **baidu**（母语图搜，不翻英；image 条目 + web 条目附图都收）
- 英文 query → **tavily**（描述质量最高，几乎条条有详细 caption）
- exa fallback（页面代表图 `results[].image` + 页面内 `extras.imageLinks`）
- ⚠️ zhipu **不支持**图搜，include_images 模式下被拒

**输入 / 输出契约**：
```
mcp__nodesign__web_search { query: "新能源汽车 充电桩 产品", include_images: true, count: 5 }
↓ 内部：auto-route → baidu (CJK 不翻) / tavily (CJK→en 翻译) / exa
↓ 下载 top-N 到 <workspace>/assets/references/ref-<hash>.<ext>
↓ 返回值：
   • 1 个 text block：markdown，含 hits + "## Reference images (downloaded, N)"
     每条带 description / local_path / size / source / url
   • N 个 image content block：每张下载到的 reference 图按 markdown 编号
     顺序内嵌，**当 turn 你直接 vision-check 即可，不必再调 Read**
```

**vision-check → 选图 → 喂 generate_image**：拿到结果后扫一眼内嵌的 N 张图，按视觉切题度选 1-2 张最好的（光线/构图/主体清晰度），把对应 markdown 条目里的 `local_path` 字段塞进 `referenceImages[]`。靠 description 文字盲选会踩坑（描述准确度参差，特别是 baidu 用 parent title 兜底的条目）。

**衔接 generate_image**：从 `local_path` 直接喂 `referenceImages[]`：
```
mcp__nodesign__generate_image {
  prompt: "...",
  referenceImages: ["assets/references/ref-a3f2b1.png"],
  ...
}
```
- ⚠️ **不要把 http url 喂进去** —— `generate_image.referenceImages` 只接 workspace 相对路径
- ⚠️ **不要全 5 张全喂** —— 选 1-2 张最切题的；多 reference 反而稀释 anchor

**何时不该用 `include_images`**：
- 抽象 / 装饰类（icon, decoration, pattern, texture）—— 模型自己脑补就行
- 概念图（流程、拼贴、隐喻）—— 没有"真实参考"的语义
- knowledge cutoff 内的著名实体（"Apple Park"、"Wong Kar-wai cinematography"）—— 直接 prompt 就够准

### `generate_image`（Nano Banana 2 — 完整 cookbook）

调用网关：NoDesk passthrough → DMXAPI → Gemini 3.1 Flash Image Preview。落档 `assets/generated/<name>.{png|jpg}`，HTML 里引 `<img src="assets/generated/<name>.jpg">`（softlink 透明）。

#### A. 模型本质 —— 用之前必须知道

| 事实 | 你能利用什么 |
|---|---|
| **knowledge cutoff 2025-01** | brand / 名人 / 地标 / 艺术家 / 流派 / 影视 / 摄影器材 / film stock 全在脑里 |
| **131K input token + 最多 14 reference images** | 跨页讲故事 + 多 reference 拼合不会爆 |
| **听得懂 conversational editing** | "Keep composition, change lighting to golden hour" 比重生整张准 |
| **多变体单 prompt** | "Create THREE distinct variations" 一次出 3 张，省 60% token |
| **角色命名锚定** | 给角色起名（"Maya"），下个 turn 它脑里就锚定了 |
| **不擅长 negation** | "no cars" 改写成 "empty pedestrianized street" |
| **多语言文字渲染** | 用一种语言写 prompt + 指定输出语言 |

**直接点名**——别犹豫：
- ✅ "Wong Kar-wai cinematography"  ✅ "Apple Park building"  ✅ "Van Gogh-style oil painting"
- ✅ "Beatles' Abbey Road photo composition"  ✅ "Fujifilm color science"  ✅ "Bauhaus poster aesthetic"
- ✅ "Saul Bass minimalist title sequence"  ✅ "ukiyo-e woodblock print style"  ✅ "1980s VHS aesthetic"

#### B. 5 元素叙述公式（强约束 prompt 结构）

```
[Subject] + [Action] + [Location/context] + [Composition] + [Style]
```

3-5 句自然段比关键词列表准 10×。每段给 1-2 个具体属性。

**反例 vs 正例**：
- ❌ `"a woman on a street, blue dress, day"`
- ✅ `"[Subject] A young woman in a light blue linen shirt and tailored beige slacks, [Action] standing at a zebra crosswalk waiting for the light to change, [Location] in central Lisbon's Chiado district, midday overcast light filtered by tall pastel buildings, [Composition] medium shot at street level, slightly low angle, [Style] documentary photography style, 85mm shallow depth of field f/2.0, natural skin tones, Fujifilm color science"`

#### C. 词汇库（按场景分类）

| 类型 | 推荐词 |
|---|---|
| 镜头 | f/1.8 / f/2.8 / f/8 portrait, 35mm wide, 85mm portrait, 200mm telephoto, macro lens, fisheye, low-angle drone, top-down isometric, dutch angle |
| 相机 / film stock | GoPro (immersive distortion), Fujifilm (color science), Kodak Portra 400 (warm skin), Cinestill 800T (tungsten green halation), Ilford HP5 (B&W documentary), Hasselblad medium format, disposable camera (raw flash nostalgic), 1980s VHS |
| 灯光 | three-point softbox, Chiaroscuro high contrast, golden hour backlighting, blue hour, neon city night, candlelit interior, overcast diffuse, harsh midday sun, studio rim light |
| 色调 / 氛围 | cinematic muted teal and orange, bleach bypass, sepia toned, pastel washed, high saturation editorial, monochrome noir |
| 材质 | navy blue tweed, etched silver leaf, matte ceramic, brushed steel, raw linen, hand-blown glass, weathered concrete, lacquered wood, brushed velvet |
| 艺术流派 / 海报 | Bauhaus, Wabi-sabi, Memphis design, brutalist concrete, art nouveau lithograph, ukiyo-e, Mucha poster, Mondrian primary, Saul Bass minimalist, Swiss International typographic |

#### D. 渲文字 4 条铁律（Nano Banana 2 杀手级能力）

1. **目标文字必带引号**：`render the words 'Annual Report 2026' on the cover`
2. **指定字体风格 OR 字体名**：`in flowing Brush Script font` / `in Century Gothic 12pt` / `in heavy blocky Impact font`
3. **多语言**：用一种语言写 prompt + 指定输出语言（`output the text in Japanese using a brush calligraphy style`）
4. **复杂排版先对话再生图**：> 3 行字 / 多种字体混排时，先用 chat 跟模型对齐文字内容，再要求生图

**典型 prompt（cover 多字段并存）**：
> "A high-end glossy magazine cover, deep cherry red background. Render three lines of text with the following exact styling: top line 'GLOW' in flowing elegant Brush Script font; middle line '10% OFF' in heavy blocky Impact font; bottom line 'Your First Order' in thin minimalist Century Gothic font. Translate the text into Korean and Arabic for the bottom-right corner."

**进阶玩法 — typographic poster**（cover / section-divider 必看）：
> "A typographic poster with a solid black background, bold letters spell 'NEW YORK', filling the center of the frame. The text acts as a cut-out window. A photograph of New York skyline is visible ONLY inside the letterforms."

#### E. Reference image 4 大模式（max 14 张：≤4 人物 + ≤10 物体）

**multi-modal formula**：

```
[Reference images] + [Relationship instruction] + [New scenario]

例: "Using the napkin sketch (Reference 1) as the structure
    and the fabric sample (Reference 2) as the texture,
    transform this into a high-fidelity 3D armchair render.
    Place it in a sun-drenched, minimalist living room."
```

| 模式 | 怎么用 |
|---|---|
| **风格一致（cross-page anchor）** | 第 1 张 cover 当 referenceImages 种子，所有后续 hero/section-divider 都引它 → 整 deck 像同一张片子 |
| **角色一致（多页叙事）** | portrait 跨页引 + 给角色起名（"Maya, the woman in Reference 1"）→ 同一个角色穿越不同场景 |
| **logo / brand 嵌入** | 用户上传 logo 进 `assets/`，每张 product mockup 把 logo 当 reference + prompt"Place the logo from Reference 1 etched into the bottle in Reference 2" → 真实嵌融 |
| **In-painting（精修而非重画）** | 调 `screenshot_canvas` 截当前页 → 把截图当 reference + 用 conversational editing 语言 |
| **真实主体锚定（web 搜来的 reference）** | 模型不熟的产品/品牌/最新事件 → 先 `web_search { include_images: true }` 拿真实图，再把 `assets/references/ref-xxx.<ext>` 喂 `referenceImages` + prompt"Use the product in Reference 1 as the subject; render it in [your scene]"。详见 § `include_images=true` |

#### F. 多变体单 prompt（省 token 大杀器）

```
单 prompt 出 3 候选 →
"Create THREE distinct variations of this cover hero,
 vary the lighting and atmosphere (golden hour / blue hour / overcast)
 but keep the subject and composition consistent"

→ 1 次 generate_image 出 3 张候选，紧跟 AskUserQuestion（每个 option 用 preview 字段贴对应图）让用户并排选
→ 比连调 3 次省 60% token，且变体间风格更统一
```

适用场景：cover 候选 / portrait 朝向候选 / palette 候选 / 标题排版候选。

#### G. Conversational in-painting 语言（精修 ≫ 重画）

| 想做的 | ❌ 不要 | ✅ 应该 |
|---|---|---|
| 改光线 | 重生整张 | "Keep composition, change lighting to golden hour" |
| 换背景 | 重生整张 | "Replace the background with a neon-lit city street" |
| 删元素 | 重生整张 | "Remove the person on the left and extend the sidewalk" |
| 换字体 | 重生整张 | "Keep the layout but change the headline font to a bold serif" |
| 局部精修 | 重生整张 | screenshot_canvas + "Soften the headline color in the top-left corner; everything else identical" |

配合 `screenshot_canvas` 截当前页当 reference → 上面这种 prompt = 精修而非重画。

#### H. 工具签名 + 默认值

```js
mcp__nodesign__generate_image({
  prompt: "<3-5 句自然段，5 元素公式>",
  aspectRatio: "16:9",   // cover/hero=16:9 or 21:9; portrait=4:5 or 2:3; icon/pattern=1:1; vertical=9:16
  imageSize: "2K",       // hero/cover='2K'; icon/decoration='1K'; '4K' 慎用（token 翻倍）
  assetRole: "cover",    // 必传 — emit + record_decision 都靠它定位
  outputName: "deck-cover-v1",
  referenceImages: [     // 可选, max 14
    "assets/user-uploaded-logo.png",
    "assets/generated/cover-anchor.jpg",  // 用作 cross-page 风格种子
  ],
  thinkingLevel: "minimal",  // default; 复杂 composition + 文字嵌图升 'high'
})
```

#### I. Prompt 质量自检 6 维度（输出不理想时对照看）

- **结构** — 关键词堆砌（`"woman blue dress sunny"`）vs 自然段落描述。后者通常输出更稳，见 § 5 元素公式
- **逻辑** — 否定描述（`"no cars"` / `"without people"`）模型容易理解反；改用肯定场景（`"empty pedestrianized street"`）更可控
- **修饰词** — `"nice"` / `"pretty"` / `"cool"` / `"高级感"` 过度抽象；用具体视觉词（灯光 / 材质 / 色温 / 字号）替代效果更可控
- **风格锚** — 没指定艺术流派 / 摄影风格 → 输出容易游移；点名一两个参考（`"Saul Bass minimalist"` / `"Fujifilm color science"`）会定向
- **文字精度** — 渲文字不带引号 + 不指定字体 → 容易跑样；明确 `render the text "XXX" in [Font Name]` 更稳
- **跨页一致** — 多页角色故事缺 referenceImages anchor → 每页独立生成时角色 / 调性容易漂；第 1 张定好后用 referenceImages 跨页复用

**额外注意**：
- icon / sticker 默认会出灰底（Nano Banana 不支持 transparent）— 明确 `"white background"` 可消除
- 同 outputName 反复 reroll（≥3 次同 prompt）收益递减；改 prompt 关键参数或询问用户新方向通常更有效

#### J. 调完必做

1. **`record_decision`** —— 把 prompt + role + path + 用户评价记 spec.json，重生时能查回
2. **关键节点的反馈循环**：cover / 第一个 portrait / logo 嵌入这种页面级 anchor（会被当 referenceImages 种子用于 downstream），生完图后在自然回话里邀请用户反馈一下方向（例如："这个 cover 当全 deck 视觉锚 OK 吗？想换风格告诉我"）。这些是 downstream 的种子，早定早收益；用户下一轮 chat 反馈就是 conversational gate（generate_image 的 image content block 已自动渲染在 chat，用户能直接看到）。

### `request_plan_mode`（plan 模式自决）

调用语义见 SKILL.md § "Agent in-loop 主动请 plan mode"。**不阻塞**——emit 完立即返回，agent 当前 turn 继续工作，SDK 切 mode 后下一 turn 自然通过 system reminder 感知。

---

## HTML 产物的 agentic 标记

> 在 deck 关键元素上加稳定锚点，让 agent 跨 turn 引用 / 用户评论 pin /
> 前端 InspectFloatingCard 找元素都有靠。

### 4 个标记 — 1 必装 + 2 关键 + 1 hybrid 专用

| 属性 | 装在哪 | 用途 |
|---|---|---|
| `data-page="N"` | section 必装 | 分页（前端 SlideNavigator / list_pages 全靠它） |
| `data-anchor="kebab-name"` | 每页 2-4 个关键元素 | agent 跨 turn 引用 + 用户评论 pin（**全文件唯一**） |
| `data-node-id="<page>-<role>-<n>"` | 同上 | 前端找元素的稳定 id（findElementByAnchor 第一层） |
| `data-react-mount="<id>"` | **React mount 容器 div 必装** | DirectEdit guard 识别——不挂 contenteditable，防止 React re-render 覆盖用户改的字 |
| `data-layout="<自由词>"` | section 选填 | layout 名 hint，list_pages 给你做总览；按隐喻自由命名 |

### 命名规范

- `data-anchor` 用 kebab-case：`cover-title` / `page-2-section-title` / `closing-thanks`
- `data-node-id` 用 `<page-context>-<role>-<n>`：`cover-title-1`
- `data-react-mount` 用语义 id，跟 `<div id="xxx-mount">` 一致：`chart-mount` / `gallery-mount`

### 给标记加多少 / 何时加

- **每页至少 2-4 个 anchor**：主标题 / CTA / 主视觉 / 关键文本（任选 2-4）
- **首跑写的时候就加** —— 不要"先写完再补"
- **不要全加**：每个 div/p/span 都加 → 噪音满屏。**克制**

---

## DirectEdit 协议

用户不只通过 chat 跟你说话 —— 他们也可以**直接在 canvas 上**：
- **双击文本改字**（contenteditable，blur 后自动 PUT 回 canvas.html，**Read 文件就能看到最新内容**）
- **选中元素写评论**（"这块字号再大一点" / "颜色不协调"）

这些"过去时段的动作"会被收集到 buffer。下次用户发 chat 消息时，**user message 顶部**会注入：

> `<system>用户在过去时段做了 N 处变更（X 编辑 + Y 评论）。可调 mcp__nodesign__get_pending_changes 查看详情；处理完调 mcp__nodesign__clear_pending_changes 清 buffer。</system>`

### 强制流程（看到 system 提示就走）

1. 立即调 `mcp__nodesign__get_pending_changes`（无参）拿全部 items
2. 每条 item 含：
   - `kind`: `'edit'` / `'comment'`
   - `anchor`: 元素稳定锚点（{ dataId, path, textHint, bbox }）
   - `aiContext`: 元素角色 / 页面信息 / outerHTML / computed styles / siblings
   - `diff`（edit）: `{ oldText, newText }` —— 用户改成了什么
   - `text`（comment）: 评论原文
3. **决策怎么响应**：
   - **comments 是用户的修改请求** —— 按评论的指示改 canvas.html（用 Edit 工具）
   - **edits 是用户已经手动改完的** —— **不要重复改 / 撤销**，只是知会"用户改了 N 处文字 OK"
   - 用户消息本身可能是对这些 changes 的进一步说明（"你看我改的字够大吗"），结合上下文一起处理
4. 处理完所有 items 后**必调** `mcp__nodesign__clear_pending_changes`（无参，全清）
5. **收尾时**：在最终回复里**总结处理了哪些 pending changes**

### React mount section 不做 contenteditable

**重要（2026-05-06 hybrid 范式）**：用户双击 React mount 容器内的文字，前端 DirectEditBridge **自动跳过**——因为 React re-render 会覆盖用户改的字。
- 你写 hybrid HTML 时，复杂组件页**必须用** `<div data-react-mount="xxx">` 包裹 mount point
- 用户对 React mount 内容的修改诉求 → 走评论 → 你看到 comment 改源码（chat 模式）
- 静态 section 仍可双击编辑

### 别做这些

- ❌ 看到 system 提示但跳过 get_pending_changes 直接回应（你会丢上下文）
- ❌ 处理完忘记 clear_pending_changes（下个 turn 又见到同样的 changes 重复处理）
- ❌ 把 edit 当 comment 处理（edit 是 done deal，不要 revert）

---

## Tweaks 暴露语法（expose_tweaks）

> 何时暴露 / 暴露什么哲学见 SKILL.md § Stage 3。本段只讲语法。

`mcp__nodesign__expose_tweaks` 入参：

```json
{
  "controls": [
    {
      "id": "hero_size",
      "type": "slider",
      "label": "Hero 字号",
      "target_var": "--hero",
      "min": 56, "max": 160, "step": 4,
      "default": 96,
      "unit": "px"
    },
    {
      "id": "accent_color",
      "type": "color",
      "label": "主色",
      "target_var": "--accent",
      "default": "#2d2418"
    },
    {
      "id": "layout_density",
      "type": "segmented",
      "label": "排版密度",
      "target_class_on": "density-compact",
      "options": [
        { "label": "紧凑", "value": "compact" },
        { "label": "均衡", "value": "balanced" },
        { "label": "舒展", "value": "spacious" }
      ],
      "default": "balanced"
    }
  ],
  "replace": false
}
```

### 5 种 control type

- `slider` —— 数值连续可调（字号 / 间距 / 圆角）
- `color` —— 颜色（accent / bg）
- `segmented` —— 少数互斥选项（density / variant），一般 2-4 个
- `toggle` —— on/off（暗色模式 / 简洁模式）
- `select` —— >4 选项的 dropdown（字体家族）

### target_var vs target_class_on

- 99% 用 `target_var` + 对应 CSS variable（更灵活，连续值也能改）
- 只有 segmented / toggle 改的是"加 class 切样式分支"时才用 `target_class_on`

### target_scope —— per-page / per-layout 限定影响范围

不传时 control 默认作用 `:root` 全局。要限定 scope（"封面字号 slider 不影响内页"）：

```json
{
  "id": "cover_hero",
  "type": "slider",
  "target_var": "--hero",
  "target_scope": "section[data-page=\"1\"]",
  "min": 80, "max": 160, "step": 4, "default": 112, "unit": "px"
}
```

**前置条件 — canvas.html 里有对应 scoped CSS rule**：

```css
:root                       { --hero: 96px; }    /* 默认 */
section[data-page="1"]      { --hero: 112px; }   /* 封面 override */
[data-layout="quote"]       { --body: 24px; }    /* layout override */
```

否则前端 setProperty 成功但没人 read 这个 var → 控件失灵。

### Tweaks ↔ Tailwind 桥接（hybrid 范式硬规约）

**colors / 字号 / 间距等可调维度**用 Tailwind arbitrary value 引 CSS var：
```html
<h1 class="text-[var(--accent)] font-display" style="font-size: var(--hero)">
<div class="bg-[var(--paper)] p-12 rounded-2xl">
```

**骨架（不可调）** 用 Tailwind utility class 直接：
```html
<div class="flex flex-col gap-6 p-8 shadow-sm">
```

→ Tweaks 改 `--accent` 时所有 `text-[var(--accent)]` 元素实时响应（CSS var 是 live）。
Tailwind utility 已编译固化（`p-8` 永远 padding 32px）—— 但骨架本来也不该动。

**别犯的错**：
- ❌ 暴露 20 个 control（信息过载，5-8 个核心维度就够）
- ❌ `target_var` 不以 `--` 开头（zod 校验会拒）
- ❌ slider 没 unit（默认 px 也写明白）
- ❌ Apply 后只改 :root，忘了再 expose_tweaks 更新 default
- ❌ `target_scope` 写了但 canvas.html 没有对应 selector 的 CSS rule

---

## vision-checker Task 派遣语法

> 何时派 / 怎么处理 critique 见 SKILL.md § Stage 4。本段只讲调用语法。

```
Task(subagent_type='vision-checker',
     prompt='请截图 canvas.html 评审视觉合理性（fullPage 1920×1080）。
            走 Tier 1-3 标准（可读性 / 层级 / 对齐 / 留白 / 对比度 / 元喻撑场），
            返结构化 VERDICT + ISSUES + OVERALL。')
```

**有 `design-plan.md` 时**（按计划 critique）：
```
prompt='请先 Read design-plan.md，再截图评审 canvas.html。
        重点对照 plan 的承诺（核心隐喻 / palette / per-page 决策）检查兑现度，
        指出 plan 说要 X 但页面没做到 X 的具体差异。
        返结构化 VERDICT + ISSUES + OVERALL，每条 ISSUE 引用 plan 段落。'
```

**单页评审**：
```
prompt='截图 canvas.html 的 page 3（用 pageIndex=3）评审。
        重点看数据可视化的层级与对比度是否撑住"投资回报"的核心叙述。'
```

⚠️ **Task 必须独占一个 message**（不跟别的 tool 并发，参见 § 子代理段）
⚠️ **不传 `run_in_background: true`**（fire-and-forget 等于自检结果丢）
⚠️ **派之前先 chat 一句**："让 vision-checker 帮我自检视觉" —— 用户看到不卡死

---

## Hybrid 范式（2026-05-06 起所有 deck 默认）

> 所有 deck 用 cwd 下的 `canvas.template.html` 当起点 cp 改写——session 创建时系统已自动拷过来，预置全家桶 importmap / Babel / Tailwind / fit script / 4 个 shadcn 组件 / 键盘翻页 / image CSS vars。
> 何时用 React mount / 何时纯静态 见 SKILL.md § Stage 3。本段只讲语法。

### 起手式：cp template 而不是从 0 拼

```
Read canvas.template.html       (cwd 下，session init 时系统拷过来的)
→ 看完结构（importmap / 4 shadcn 组件 / fit script / 键盘翻页都在 head/body 里）
→ Write canvas.html             (cp template 改你需要的部分)
```

### 1 文件，4 类内容

```html
<head>
  ① importmap：全家桶 10 库（preconfigure，agent import 哪个浏览器才下哪个）
  ② Tailwind Play CDN + tailwind.config（config 只配 fontFamily，颜色走 CSS var）
  ③ Babel Standalone：浏览器内编译 TSX
  ④ <style id="design-tokens">：CSS variables（Tweaks 暴露目标）
  ⑤ <style id="base">：fit wrapper / section[data-page] 1920×1080 锁定（不要动）
</head>

<body>
  <div class="__nd-deck-wrap">
    <!-- 简单 section：纯 HTML/CSS + Tailwind，DirectEdit 全 work -->
    <section data-page="1" data-anchor="cover">...</section>

    <!-- 复杂 section：React mount，必须 data-react-mount 包裹 -->
    <section data-page="2">
      <div data-react-mount="chart" id="chart-mount"></div>
    </section>
  </div>

  <!-- 所有 React mount 的 createRoot 写这里 -->
  <script type="text/babel" data-type="module" data-presets="react,typescript">
    import React from 'react';   // ⚠️ Babel classic JSX runtime 必须 import default
    import { createRoot } from 'react-dom/client';
    import { LineChart, Line, ResponsiveContainer } from 'recharts';

    function Chart() { return <LineChart>...</LineChart>; }
    createRoot(document.getElementById('chart-mount')).render(<Chart />);
  </script>

  <!-- fit script（不要动） -->
</body>
```

### 全家桶库速查表（importmap 已声明，agent `import` 即用）

| 库 | import | 用途 / 何时用 | **不要** 用在 |
|---|---|---|---|
| `recharts` | `import { LineChart, Bar, ... } from 'recharts'` | 西式数据图表（quick & clean） | landing 装饰动画（用 framer-motion）、流程图（用 mermaid） |
| `echarts` + `echarts-for-react` | `import ReactECharts from 'echarts-for-react'` | 中文 deck 图表强势替代（更多 chart type / 中文 a11y） | 简单单系列折线（recharts 更轻） |
| `framer-motion` / `motion` | `import { motion } from 'framer-motion'` | React 声明式动画（hover/scroll/layout） | 复杂 timeline / scrollTrigger（用 gsap） |
| `gsap` | `import gsap from 'gsap'` | timeline / stagger / scrollTrigger 命令式动画 | 单一 hover 状态（CSS transition 即可） |
| `lucide-react` | `import { Sparkles, Layers } from 'lucide-react'` | icon 库（清爽线性，1500+ 个） | 装饰性大插画（用 generate_image，role='decoration'）|
| `mermaid` | `import mermaid from 'mermaid'` + `mermaid.run()` | 流程图 / 架构图 / 时序图（技术 deck 必备） | 数据图表（用 recharts）、节点图自由布局（用 reactflow） |
| `shiki` | `import { codeToHtml } from 'shiki'` | 代码块高亮（VSCode 同款引擎） | 普通文本展示（`<pre>` 即可，不要拖 200KB shiki） |
| `embla-carousel-react` | `import useEmblaCarousel from 'embla-carousel-react'` | 卡片轮播 | 单页静态卡片网格（用 grid 即可） |
| `react-katex` | `import { BlockMath, InlineMath } from 'react-katex'` | 数学公式（学术/科研 deck）—— 注意需要 inline KaTeX CSS link | 普通上下标 `<sup>/<sub>`（HTML 即可） |
| `reactflow` | `import ReactFlow from 'reactflow'` + 自带 CSS | 节点图 / 思维导图（用户可拖） | 静态架构图（用 mermaid 文本声明更省事）|
| `@radix-ui/react-{dialog,tabs,tooltip,accordion,popover,scroll-area}` | `import * as Dialog from '@radix-ui/react-dialog'` | shadcn 底层（要 a11y/键盘导航时用） | 4 个 inline shadcn 已盖的常用 case（Card/Button/Badge/Tabs） |
| `three` + `@react-three/fiber` + `@react-three/drei` | `import { Canvas } from '@react-three/fiber'` | 3D 场景天花板（封面炫一下；体积大用之前想清楚） | 普通 hero（一张 generate_image 出来更轻 + 可控） |
| `lenis` | `import Lenis from 'lenis'` | 平滑滚动（landing-style deck 才需要） | deck 模式（fit script 已锁页，不用 scroll smoothly） |

### 选型决策表（按任务类型）

| 任务类型 | 首选组合 | 反例 |
|---|---|---|
| 数据 dashboard | recharts/echarts + Card + Tabs + lucide icon | gsap 动画做不到、不要堆 framer-motion |
| Landing page / 营销 | framer-motion + gsap + generate_image (hero/bg/decoration) | mermaid 不需要、recharts 不一定 |
| 技术 deck（架构 / 协议） | mermaid 或 reactflow + shiki + recharts | 不要全用 generate_image 替代结构图 |
| 学术 / 科研 deck | react-katex + recharts + 字体衬线 | gsap 复杂动画在学术场景显得轻浮 |
| 故事 deck（多角色） | generate_image (portrait + section-divider，referenceImages 跨页固定角色) + framer-motion | recharts 用不上 |
| 数据可视化报告 | echarts + Card + 静态 hero（generate_image role='hero'）| 别拖 r3f / lenis |

### template 已 inline 的 4 个 shadcn 组件

agent cp template 后**直接用**（在 babel script 里），不需要 import：

```jsx
<Card>
  <CardHeader><CardTitle>标题</CardTitle></CardHeader>
  <CardContent>...</CardContent>
</Card>

<Button variant="outline">点击</Button>
<Badge variant="secondary">标签</Badge>

<Tabs defaultValue="a">
  <TabsList>
    <TabsTrigger value="a">A</TabsTrigger>
    <TabsTrigger value="b">B</TabsTrigger>
  </TabsList>
  <TabsContent value="a">...</TabsContent>
</Tabs>
```

需要 a11y / 键盘导航等更全功能 → `import * as Tabs from '@radix-ui/react-tabs'` 自己组。

### Hybrid 几个常坑

- ⚠️ **Babel classic JSX runtime 需要 React 在 scope** —— `import React from 'react'`（连同 hooks 一起 `import React, { useEffect } from 'react'`），否则 `React is not defined` pageerror
- ⚠️ **JSX 里 placeholder 用纯文本不带花括号** —— `<h1>改我</h1>` 而不是 `<h1>{改我}</h1>`（{} 在 JSX 里是表达式 slot，中文字会被当 JS 报错）
- ⚠️ **不要 `position: fixed`** —— transform: scale 后 fixed 锚 wrap 不锚 viewport，会失效；用 `position: absolute` 锚到 section
- ⚠️ **flex 撑高度，避免 `h-[calc(100%-Npx)]`** —— hardcode N 在不同视口/字体下易溢出，用 `flex-1 min-h-0` 让 flex 自然撑

---

## 子代理（Task 工具）—— 给自己减负的关键

NoDesign 工作台挂了几个**子代理**，主 agent 通过 `Task` 工具派工作给它们。
子代理跑在独立 context 里，结果回传给你 —— **它们的转录不会污染你的上下文窗口**。

### 现有子代理

| 子代理 | 一句话用途 | 你什么时候调 |
|---|---|---|
| `explorer` | **研究员**：搜外链 / 找参考图 URL / 验证事实 / 找字体 CDN / 查趋势 | 任何"我需要外部信息但搜起来要好几个 turn"的场景 |
| `vision-checker` | 截图 + 挑剔视觉评审（read-only） | 整个 deck 写完 / 关键页改完 / 用户问"看着怎么样"。**触发协议见 SKILL.md § Stage 4** |
| `ds-extractor` | 抽 design system tokens（color/type/spacing） | 用户说"抽 design system" 时——目前还不主动调 |
| `tweak-proposer` | 推 tweak schema（slider / colorpicker） | tweak UI 流接通后再用 |

### Task 调用规则

⚠️ **Task 必须独占一个 message，绝对不要跟别的 tool 并发**

❌ **错的写法**（同一 assistant message yield 多个 tool_use block）：
```
[tool_use: Task(subagent_type='explorer', prompt='找参考图')]   ← 跟下面并发
[tool_use: Write(file='canvas.html', ...)]                       ← 跟上面并发
```
SDK parallel dispatch 把工具都 fork 同时跑——你拿不到 explorer 报告**之前**就 Write 了 canvas.html，等报告回来 deck 已搭好不能引真实 URL。

✅ **对的写法**（Task 独占一 message）：
```
turn 1: [tool_use: Task(subagent_type='explorer', prompt='...')] ← SDK 阻塞等
        [tool_result: explorer 返回 URL 列表]
turn 2: [tool_use: Write(...引用 URL...)]
```

⚠️ **不要传 `run_in_background: true`**：fire-and-forget 等于报告丢。NoDesign 已开 `forwardSubagentText`，前台跑也能看到 subagent 实时 thinking 转发到主 chat。万一传了，工作台 PreToolUse hook 透明改回 false。

⚠️ **派之前先 chat 一句简短报告**：例如"我让 explorer 帮我搜一下参考图"。不要说"1-2 分钟回来"——让 agent 觉得"长"反而想后台跑或并发别的 tool。

### explorer brief 模板

写清你要什么形态的产物：
- "URL 列表 + 简短说明"（找参考图）
- "字体名 + CDN link + 兼容性"（找字体）
- "数字 + 来源"（验证事实）

| 场景 | 自己干（吃 context） | 派 explorer 通常更高效 |
|---|---|---|
| "fintech onboarding 风" 没参考图 | 自己 web_search 5 次 | `Task(explorer, '找 3-5 个 fintech onboarding deck 视觉参考图 URL')` |
| 想用 Inter 字体不确定 CDN | 自己 web_search + WebFetch | `Task(explorer, 'Inter 字体 Google Fonts CDN + 兼容性')` |
| 缺一张表"数据驱动决策"的图 | 自己搜资源站 | `Task(explorer, '找一张"数据驱动决策"高质量插画/icon URL')` |

### Explorer 派遣的判断标准

**通常值得派 explorer**：多步骤研究（≥3 turn 信息汇总）/ 视觉参考拍板的方向选择 / 陌生领域的快速事实验证。

**自己做通常更快**：
- 单行命令级搜索（一次 web_search 就够）
- 已有足够信息、纯粹需要视觉判断 / 排版调整 / 文案输出
- 时间紧张且结果是单点事实（不需要综合整理）

---

## CDN / 网络资源

之前默认禁的硬规则已撤。MVP 阶段 sandbox 全域允许，agent 可以用 `curl -L -o` **下载图片 / 字体 / 音频到 `./assets/<filename>`** 引本地路径，比 hotlink 更可靠。

```bash
curl -L -o ./assets/cover.png "https://images.unsplash.com/photo-..."
curl -L -o ./assets/bgm.mp3 "https://cdn.pixabay.com/audio/..."
```

然后 canvas.html 引 `<img src="./assets/cover.png">` —— 跨 session 持久（assets 软链到 shared 目录）。

**何时下载 vs hotlink**：
- ✅ **下载**：核心视觉资源（封面图 / 章节图 / BGM），引用稳定性比文件大小重要
- ✅ **hotlink**：lucide/heroicons CSS-driven SVG icon、Google Fonts CDN（这些专为 hotlink 设计）
- ✅ **importmap 已声明的 esm.sh / unpkg / cdn.tailwindcss.com**：直接用，不需要下载（hybrid 范式预置）
- ❌ 不要批量下载十几张图（增加 ./assets/ 体积，跨 session 共享变臃肿）

**沙箱信任**：sandbox 仍硬封系统目录写（/etc / /usr 等）+ /etc/passwd / ~/.ssh 凭据读。curl 输出文件**只能写到 cwd / ./assets/ / ./agent-memory/**——写其他位置 sandbox 静默 deny。

---

## 工作流的关键约束（SDK 硬规则 + 经验最佳实践）

约束分两类，用对的方式应对：

**SDK 硬规则**（系统会 enforce，违反 = 直接失败）：
- git commit / git checkout 由 server 托管管理（用户通过 Undo 操作 git 历史）
- npm install / pnpm install 在 stage 1 被沙箱禁止
- Task 工具独占一个 message（并发会让 subagent 结果丢失）

**经验最佳实践**（建议遵循，效率显著更高）：
- Bash 的 ls / find / cat / grep -r 改用 Glob / Grep 工具 — 速度快且结果格式更易处理
- Edit 失败时先 Read 确认文件现状再精确改 — 盲目重试 oldString 容易循环；盲目 Write 整文件会让 git diff 脏乱
- 看到 system 提示有 pending changes → 调 get_pending_changes 看一眼再回复，处理完 clear buffer（不清下一 turn 又见同样的 change）

---

> 业务方法论（5-stage paradigm / 深度对齐 / Per-page decision / Hybrid 写法判断 / 完成时收尾） 由后面 append 的 SKILL.md 提供。
