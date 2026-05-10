# generate_image 完整 cookbook（Nano Banana 2）

> 此文件由 PreToolUse(mcp__nodesign__generate_image) hook 在 agent 首次调用工具时
> 注入。SKILL.md 已含精简版核心要点，本文是深度参考——agent 看完后可拿出更稳的 prompt。

调用网关：NoDesk passthrough → DMXAPI → Gemini 3.1 Flash Image Preview。落档
`assets/generated/<name>.{png|jpg}`，HTML 里引 `<img src="assets/generated/<name>.jpg">`
（softlink 透明）。

## 0. Reference 来源策略（生图前先决定从哪儿拿 reference）

| 主体 | 来源 | 触发动作 |
|---|---|---|
| 用户上传素材（`assets/*.png\|jpg`）| 直接用 | 把路径喂 `referenceImages[]` |
| Knowledge cutoff 内的著名实体（Apple Park / Wong Kar-wai 风 / 艺术流派）| 模型脑里有 | prompt 直接点名，不必 reference |
| **真实存在但模型不熟**（最新发布产品 / 小众品牌 / 用户自有 IP / 特定型号设备）| **`web_search { include_images:true }`** | 工具自动翻英文 + 下载到 `assets/references/`；选 1-2 张最切题的 `local_path` 喂 `referenceImages[]` |
| 抽象概念 / 装饰 / 隐喻 | 不需要 reference | 直接 prompt（流派 + 5 元素公式）|

### `include_images=true` 用法

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

**关键页例外 — 让用户挑而不是 agent 默选**：cover / 跨页 anchor / portrait 这种**会被当 referenceImages 跨页种子**复用的页型，agent 默选错一张全 deck 漂。这些页的 reference 选择**主动调 AskUserQuestion + image preview**：每个 option 贴一张候选图（用 `local_path` 转 base64 或用 markdown image url），让用户视觉对比挑哪张当种子。装饰 / 普通页 agent 自选即可不必问。

**衔接 generate_image**：从 `local_path` 直接喂 `referenceImages[]`：
```
mcp__nodesign__generate_image {
  prompt: "...",
  referenceImages: ["assets/references/ref-a3f2b1.png"],
  ...
}
```
- ⚠️ **referenceImages 只接 workspace 相对路径** —— 喂 http url 会被拒
- ⚠️ **选 1-2 张最切题的** —— 全 5 张全喂反而稀释 anchor，模型不知道该锚哪张

**何时不该用 `include_images`**：
- 抽象 / 装饰类（icon, decoration, pattern, texture）—— 模型自己脑补就行
- 概念图（流程、拼贴、隐喻）—— 没有"真实参考"的语义
- knowledge cutoff 内的著名实体（"Apple Park"、"Wong Kar-wai cinematography"）—— 直接 prompt 就够准

## A. 模型本质 —— 用之前先看一眼

| 事实 | 你能利用什么 |
|---|---|
| **knowledge cutoff 2025-01** | brand / 名人 / 地标 / 艺术家 / 流派 / 影视 / 摄影器材 / film stock 全在脑里 |
| **131K input token** | 跨页讲故事 + 多 reference 拼合不会爆 |
| **reference cap：4 character + 10 object（共 14）** | 超过 4 char ref 模型会 blur 角色 identity；按角色/物体细分预算更稳 |
| **听得懂 conversational editing** | "Keep composition, change lighting to golden hour" 比重生整张准 |
| **多变体单 prompt** | "Create THREE distinct variations" 一次出 3 张，省 60% token |
| **角色命名锚定** | 给角色起名（"Maya"），下个 turn 它脑里就锚定了 |
| **不擅长 negation** | "no cars" 改写成 "empty pedestrianized street" |
| **多语言文字渲染 + in-image localization** | 不止翻文字，还能换 props / 文化语境（详见 § D）|
| **Thinking 永远在跑** | `thinkingLevel: minimal\|high` 是预算不是开关；thinking tokens 永远计费即便不返回 |
| **Aspect ratio 严格遵守（NB2 改进）** | 传啥比例就出啥，prompt 里不必再"in 16:9 widescreen format"重复 |

**直接点名**——别犹豫：
- ✅ "Wong Kar-wai cinematography"  ✅ "Apple Park building"  ✅ "Van Gogh-style oil painting"
- ✅ "Beatles' Abbey Road photo composition"  ✅ "Fujifilm color science"  ✅ "Bauhaus poster aesthetic"
- ✅ "Saul Bass minimalist title sequence"  ✅ "ukiyo-e woodblock print style"  ✅ "1980s VHS aesthetic"

**别让 NB2 干这些（不是它的活）**：

| 想做的事 | 别叫 NB2 干，改叫 |
|---|---|
| 调工具 / function calling | 主 agent 自己（NB2 不支持 tool use）|
| 返结构化 JSON | 主 agent + AskUserQuestion 或自己解析 |
| 执行代码 / 算公式 | 主 agent 用 Bash 跑 Python |
| 抓 URL / 浏览网页 | `mcp__nodesign__web_search` |
| 用 file search / 读文档 | 主 agent Read，重要文档用 `referenceImages` 喂 PDF（见 § K）|
| Maps grounding | 不支持 |
| 持久 context caching | 不支持，每次请求自带需要的 reference |
| 语音 / 视频输入输出 | NB2 仅吃 text + image + PDF，输出仅 image + text |

## B. 5 元素叙述公式（强约束 prompt 结构）

```
[Subject] + [Action] + [Location/context] + [Composition] + [Style]
```

3-5 句自然段比关键词列表准 10×。每段给 1-2 个具体属性。

**反例 vs 正例**：
- ❌ `"a woman on a street, blue dress, day"`
- ✅ `"[Subject] A young woman in a light blue linen shirt and tailored beige slacks, [Action] standing at a zebra crosswalk waiting for the light to change, [Location] in central Lisbon's Chiado district, midday overcast light filtered by tall pastel buildings, [Composition] medium shot at street level, slightly low angle, [Style] documentary photography style, 85mm shallow depth of field f/2.0, natural skin tones, Fujifilm color science"`

## C. 词汇库（按场景分类）

| 类型 | 推荐词 |
|---|---|
| 镜头 | f/1.8 / f/2.8 / f/8 portrait, 35mm wide, 85mm portrait, 200mm telephoto, macro lens, fisheye, low-angle drone, top-down isometric, dutch angle |
| 相机 / film stock | GoPro (immersive distortion), Fujifilm (color science), Kodak Portra 400 (warm skin), Cinestill 800T (tungsten green halation), Ilford HP5 (B&W documentary), Hasselblad medium format, disposable camera (raw flash nostalgic), 1980s VHS |
| 灯光 | three-point softbox, Chiaroscuro high contrast, golden hour backlighting, blue hour, neon city night, candlelit interior, overcast diffuse, harsh midday sun, studio rim light |
| 色调 / 氛围 | cinematic muted teal and orange, bleach bypass, sepia toned, pastel washed, high saturation editorial, monochrome noir |
| 材质 | navy blue tweed, etched silver leaf, matte ceramic, brushed steel, raw linen, hand-blown glass, weathered concrete, lacquered wood, brushed velvet |
| 艺术流派 / 海报 | Bauhaus, Wabi-sabi, Memphis design, brutalist concrete, art nouveau lithograph, ukiyo-e, Mucha poster, Mondrian primary, Saul Bass minimalist, Swiss International typographic |

## D. 渲文字 4 条铁律（Nano Banana 2 杀手级能力）

1. **目标文字必带引号**：`render the words 'Annual Report 2026' on the cover`
2. **指定字体风格 OR 字体名**：`in flowing Brush Script font` / `in Century Gothic 12pt` / `in heavy blocky Impact font`
3. **多语言**：用一种语言写 prompt + 指定输出语言（`output the text in Japanese using a brush calligraphy style`）
4. **复杂排版先对话再生图**：> 3 行字 / 多种字体混排时，先用 chat 跟模型对齐文字内容，再要求生图

**典型 prompt（cover 多字段并存）**：
> "A high-end glossy magazine cover, deep cherry red background. Render three lines of text with the following exact styling: top line 'GLOW' in flowing elegant Brush Script font; middle line '10% OFF' in heavy blocky Impact font; bottom line 'Your First Order' in thin minimalist Century Gothic font. Translate the text into Korean and Arabic for the bottom-right corner."

**进阶玩法 — typographic poster**（cover / section-divider 必看）：
> "A typographic poster with a solid black background, bold letters spell 'NEW YORK', filling the center of the frame. The text acts as a cut-out window. A photograph of New York skyline is visible ONLY inside the letterforms."

### In-image localization（已有图本地化，不只是翻文字）

NB2 会本地化**整个视觉文化语境**——文字翻译只是其中一项，还能换 props / 货币 / 着装 / 食物 / 场景文化语境。规则：保留品牌身份 + 主体构图，调整其他即可：

> "Localize this ad for the Japanese market.
>  Translate the headline exactly to Japanese: '〜こだわりの一杯〜'.
>  Adapt background props, packaging context, and lifestyle cues for Tokyo consumers.
>  Keep the product, logo, composition, and brand colors unchanged."

适合：跨地区营销素材 / 多语言 deck 版本 / 品牌 global → local 适配。

## E. Reference image 4 大模式（max 14 张：≤4 character ref + ≤10 object ref）

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
| **In-painting（精修而非重画）** | 调 `screenshot_canvas` 截当前页 → 把截图当 reference + 用 conversational editing 语言（详见 § G semantic masking）|
| **真实主体锚定（web 搜来的 reference）** | 模型不熟的产品/品牌/最新事件 → 先 `web_search { include_images: true }` 拿真实图，再把 `assets/references/ref-xxx.<ext>` 喂 `referenceImages` + prompt"Use the product in Reference 1 as the subject; render it in [your scene]" |

### 进阶 edit modes（reference 工作流的高级用法）

#### Multi-image composition（product-on-model / element-transfer）

NB2 高保真合成的官方杀手能力。模板：

```
Image 1 = [object/product/garment/logo]
Image 2 = [person/environment/surface]
Instruction: "Take [element from Image 1] and place it on/with [element from Image 2].
              Preserve [protected details] exactly.
              Adjust lighting, shadows, perspective, and material interaction naturally."
```

具体例：
> "Take the blue floral dress from Image 1 and put it on the woman in Image 2.
>  Preserve her face, hair, pose, and the cafe background exactly.
>  Match lighting and shadow direction to the cafe scene; render fabric drape naturally."

适合：服装上身 mockup / 产品上场景 / logo 烙印物体 / 标牌嵌建筑。

#### Style transfer（保构图，只换 style）

不只是"梵高风"——关键是 **preserve composition / placement / silhouette**，只换 rendering style：

> "Transform this product photo into a Bauhaus poster illustration.
>  Preserve the product shape, orientation, and composition.
>  Change only the rendering style: flat geometric forms, primary color blocks,
>  clean vector edges, 1920s Bauhaus poster design."

#### Sketch-to-final（线稿/wireframe → polished）

用户给草图 / 线稿 / wireframe → 你输出 polished 视觉，**保留几何结构**：

> "Turn this rough wireframe into a polished 16:9 SaaS product hero visual.
>  Keep the layout, card hierarchy, and main dashboard geometry from Reference 1.
>  Add premium glassmorphism UI, soft blue studio lighting, and realistic depth.
>  Leave top-right negative space for HTML title overlay."

适合：用户上传草图想要 hero / 产品 mockup / 概念图。

#### Character bible（多视角 + 跨页一致）

对于跨多页出现的角色 / mascot / 关键产品，先建 identity sheet：

```
Step 1: 生成"identity sheet"（front view + 关键服装/装备特写）
Step 2: 后续每个角度（3/4 / profile / back / action pose）都把 identity sheet 当 reference
Step 3: 给角色起名锚定（"Maya, character from Reference 1"）
        outfit / hairstyle / silhouette / 关键材质锚点 不允许跨页变
```

适合：deck 主角跨多页出现 / 品牌 mascot / 产品多视图说明。

## F. 多变体单 prompt（省 token 大杀器）

```
单 prompt 出 3 候选 →
"Create THREE distinct variations of this cover hero,
 vary the lighting and atmosphere (golden hour / blue hour / overcast)
 but keep the subject and composition consistent"

→ 1 次 generate_image 出 3 张候选，紧跟 AskUserQuestion（每个 option 用 preview 字段贴对应图）让用户并排选
→ 比连调 3 次省 60% token，且变体间风格更统一
```

适用场景：cover 候选 / portrait 朝向候选 / palette 候选 / 标题排版候选。

## G. Semantic masking & Conversational editing（精修 ≫ 重画）

NB2 不需要用户画 mask——你用**自然语言定义编辑区域**，模型自己分割（semantic masking）。万能模板：

```
"Change only [semantic target].
 Keep [everything else: subject / composition / lighting / palette] unchanged."
```

具体例：
> "Change only the blue sofa to a vintage brown leather chesterfield sofa.
>  Keep the pillows, lighting, floor, wall art, and camera angle unchanged."

这是 regenerate / tweak 的**默认模板**——比"重画一张差不多的"准 10×。

| 想做的 | ❌ 重生整张（浪费） | ✅ semantic masking |
|---|---|---|
| 改光线 | 重生整张 | "Keep composition, change only lighting to golden hour" |
| 换背景 | 重生整张 | "Replace only the background with a neon-lit city street; keep subject and pose" |
| 删元素 | 重生整张 | "Remove only the person on the left, extend the sidewalk; keep everything else" |
| 换字体 | 重生整张 | "Keep layout, change only headline font to a bold serif; body text unchanged" |
| 局部精修 | 重生整张 | screenshot_canvas + "Soften only the headline color in top-left corner; everything else identical" |
| 换主体材质 | 重生整张 | "Change only the table material from wood to brushed steel; keep shape, position, scene" |

配合 `screenshot_canvas` 截当前页当 reference → 上面这种 prompt = 精修而非重画，token / latency / 一致性全赢。

## H. 工具签名 + Aspect ratio / image size 详解

### 工具签名

```js
mcp__nodesign__generate_image({
  prompt: "<3-5 句自然段，5 元素公式>",
  model: "flash",        // 'flash'(default NB2) | 'pro'(锚点图升档，见下方 model 路由)
  aspectRatio: "16:9",   // 14 种官方比例，见下表
  imageSize: "1K",       // '512' | '1K' | '2K' | '4K'
  assetRole: "cover",    // 必传 — emit + record_decision 都靠它定位
  outputName: "deck-cover-v1",
  referenceImages: [     // 可选, max 14（≤4 character + ≤10 object）
    "assets/user-uploaded-logo.png",
    "assets/generated/cover-anchor.jpg",  // 用作 cross-page 风格种子
    // 也可以是 .pdf —— 见 § K Document-to-visual
  ],
  thinkingLevel: "minimal",  // 'minimal'(default) | 'high'；预算不是开关，永远在跑且永远计费
  useGrounding: false,        // opt-in；真实地标/产品/场景开 ✅，人物/装饰/抽象不开 ❌（详见 § L）
})
```

### Aspect ratio × imageSize 映射（14 比例 + 4 size）

NB2 不出"标准 1920×1080"——实际像素见下表（部分常用组合）：

| 比例 | 用例 | 1K 实际像素 | 2K | 4K |
|---|---|---:|---:|---:|
| 16:9 | deck cover / hero / 视频缩略图 | 1376×768 | 2752×1536 | 5504×3072 |
| 9:16 | mobile story / 竖屏宣传 | 768×1376 | 1536×2752 | 3072×5504 |
| 21:9 | 网站超宽 hero / 影院遮幅 | 1584×672 | 3168×1344 | 6336×2688 |
| 4:5 / 5:4 | portrait / Instagram 图 | ~1144×1432 | ~2288×2864 | ~4576×5728 |
| 3:2 / 2:3 | 横/竖摄影标准 | 1248×832 | 2496×1664 | 4992×3328 |
| 4:3 / 3:4 | 老 deck / 印刷 | 1184×888 | 2368×1776 | 4736×3552 |
| 1:1 | icon / pattern / 头像 | 1024×1024 | 2048×2048 | 4096×4096 |
| **8:1 / 1:8** | 顶部公告条 / 侧边装饰带 | 3072×384 / 384×3072 | 6144×768 | 12288×1536 |
| **4:1 / 1:4** | hero strip / 长卷海报 | ~2192×548 | ~4384×1096 | ~8768×2192 |

**512 (0.5K) tier**：长边 ~512px。专给 icon / sticker / decoration / UI 元素用——latency 和成本各降 ~50%，对小尺寸用例效果跟 1K 看不出差。**别用 1K 出 32px icon**。

### Size 决策表

| 用例 | 推荐 size | 理由 |
|---|---|---|
| icon / sticker / 装饰 / UI 元素 | **512** | 渲染目标本来就小，更高分辨率纯浪费 |
| draft / 候选 / approval gate 预览 | 1K | default，approval 通过再升档 |
| deck cover / hero / 关键页 final | 2K | 渲染清晰、token 还可控 |
| 印刷 / 大屏展示 / 商用素材 | 4K | token 翻倍，approval 后再升 |

### 反规则：尺寸/比例只走 API 参数

❌ 别在 prompt 里写 "in 4K resolution" / "16:9 widescreen format" / "high resolution image" —— NB2 看 API 参数（`aspectRatio` / `imageSize`），prompt 里写这些是噪音
✅ prompt 只描述场景内容，size/ratio 全靠工具参数控制

### Thinking 透明度

| 字段 | 值 | 含义 |
|---|---|---|
| `thinkingLevel` | `minimal` (default) | NB2 用最少 thinking budget 出图，latency 优先 |
| `thinkingLevel` | `high` | 复杂 composition / 多 reference / 嵌大段文字 / 关键 final 时升 |
| 内部 `includeThoughts` | wrapper 默认 `false` | 不返回 interim thought images（只返 final 那张）|

**注意**：thinking tokens 永远计费——不是"关 thinking 省钱"的开关，而是"用多少 thinking 思考"的预算。`high` 比 `minimal` 慢 + 贵，但对 plan compliance / 文字精度 / 多 reference 一致性的提升常常值得。

### Model 路由：flash (default) vs pro

NB2 有两档：

| `model` | id | 用 | 不用 |
|---|---|---|---|
| `'flash'` (default) | gemini-3.1-flash-image-preview | 几乎所有图——装饰 / 场景 / portrait / icon / 单页用 hero / 多变体探索 / 草稿 | — |
| `'pro'` | gemini-3-pro-image-preview | **会成为 referenceImages 种子的 anchor 图**：cover hero / character bible identity sheet / brand mockup hero / 标志性数据可视化 final | 装饰 / 单页用图 / 草稿 / 探索阶段 / 多变体候选 |

**判断规则**（一句话）：**这张图会被后续 ≥3 张图引用为 reference？** 是 → `pro`，否 → `flash`。

**为啥锚点图升 pro 值得**：
- pro 比 flash 慢 ~2-3× + 贵 ~2-3×（单图成本几分钱差距）
- 但锚点图错了，downstream 引它的所有图全漂、整个 deck 视觉散——返工成本远超 pro 单图溢价
- 锚点图通常 1 个 deck 只有 2-5 张（cover / 主角 portrait / brand mockup），总额外成本可控

**反例**（这些场景**别**升 pro，纯浪费）：
- 多变体单 prompt（`"Create THREE distinct variations"` 出 3 张候选选哪张当锚）—— 探索阶段用 flash 出候选，**只对最终选中的那张** rerun 一次 pro
- 装饰元素 / 单页用图 / icon / sticker —— 用不上的优化
- 草稿 / approval gate 之前的预览 —— 用 flash + 1K 看方向，approval 后再决定 pro 升档

## I. Prompt 质量自检 6 维度（输出不理想时对照看）

- **结构** — 关键词堆砌（`"woman blue dress sunny"`）vs 自然段落描述。后者通常输出更稳，见 § B 5 元素公式
- **逻辑** — 否定描述（`"no cars"` / `"without people"`）模型容易理解反；改用肯定场景（`"empty pedestrianized street"`）更可控
- **修饰词** — `"nice"` / `"pretty"` / `"cool"` / `"高级感"` 过度抽象；用具体视觉词（灯光 / 材质 / 色温 / 字号）替代效果更可控
- **风格锚** — 没指定艺术流派 / 摄影风格 → 输出容易游移；点名一两个参考（`"Saul Bass minimalist"` / `"Fujifilm color science"`）会定向
- **文字精度** — 渲文字不带引号 + 不指定字体 → 容易跑样；明确 `render the text "XXX" in [Font Name]` 更稳
- **跨页一致** — 多页角色故事缺 referenceImages anchor → 每页独立生成时角色 / 调性容易漂；第 1 张定好后用 referenceImages 跨页复用

**额外注意**：
- icon / sticker 默认会出灰底（NB2 不支持 transparent）— 明确 `"white background"` 可消除
- 同 outputName 反复 reroll（≥3 次同 prompt）收益递减；改 prompt 关键参数或询问用户新方向通常更有效

### NB2 已知失败模式（model card 列出的常见坑）

NB2 不是万能的——以下是 final 接受前**必扫**的 checklist：

| 维度 | 坑 | 检查 |
|---|---|---|
| **小字** | 1K 下 < 12px 等效字号容易模糊 | 关键文字单独大字 + 升 2K，或用 HTML overlay 覆盖文字别让 NB2 渲 |
| **长段落 / page-length text** | 模型在 > 1 段正文时容易跑样 | > 3 行字 / 整段 paragraph 让 HTML 渲，NB2 只渲 headline / 标语 |
| **角色漂** | 跨页生成同角色容易微变（脸型 / 发色 / 服装细节）| 跨页用 § E character bible 工作流（identity sheet + reference 链）|
| **左右 / 空间定位** | "left of"/"right of"/"behind" 偶尔反 | 关键定位用绝对短语（"in the foreground"/"in the bottom-right corner"）|
| **数量** | "exactly 5 cards" 不一定真出 5 张 | 数字关键时让 HTML 复制 N 份，NB2 只出 1 张 template |
| **Mask / sketch 残墨** | reference 是带涂鸦/标注的截图时 NB2 偶尔把标注当主体复制 | 截图前清干净 reference 上的标注 / 红框 / 箭头 |
| **Paste-artifact** | 多 reference 合成时偶尔把 reference 的局部 1:1 paste 进来 | 检查输出图有没有突兀的"贴片"边缘；有就改 prompt 强调 "naturally blend" / "reinterpret" |
| **factuality** | reference 没给的信息 NB2 可能编（datestamp / sources / 数字）| 数据 / 事实类内容用 HTML 渲，别让 NB2 自己写 |
| **transparent bg** | NB2 模型本身不支持，永远填某色背景 | **server 端独立工具兜底**：调 `mcp__nodesign__remove_background({ inputPath })` 抠任意 workspace 图片（rembg U²-Net），输出 RGBA PNG。+5-10s 首次 / +1-2s 后续。复杂主体 / 清晰边界场景效果好；薄透元素（玻璃 / 烟雾 / 飘发）边缘可能软。SVG 图标仍优先 lucide-react。详见 § M |
| **SynthID watermark** | 所有 NB2 生图自带不可见 watermark | 知道即可；商用素材用户该知情 |

## J. 调完必做

1. **`record_decision`** —— 把 prompt + role + path + 用户评价记 spec.json，重生时能查回
2. **关键节点的反馈循环**：cover / 第一个 portrait / logo 嵌入这种页面级 anchor（会被当 referenceImages 种子用于 downstream），生完图后在自然回话里邀请用户反馈一下方向（例如："这个 cover 当全 deck 视觉锚 OK 吗？想换风格告诉我"）。这些是 downstream 的种子，早定早收益；用户下一轮 chat 反馈就是 conversational gate（generate_image 的 image content block 已自动渲染在 chat，用户能直接看到）。
3. **落档后 read_page / list_pages 看到的是 thumbnail 快照**（`/api/canvas` GET 时把 `assets/generated/<n>.<ext>` 透明重写到 `.thumbnails/<n>.thumb.jpg`），真实 HTML / 文件系统中的 `<img src>` 不变。如果你 Read canvas.html 想确认 src 已写进去——直接看 Read 结果（不经 thumbnail 重写）；如果想知道 preview iframe 加载哪张图——查 `.thumbnails/` 目录。重生原图 N 秒内 thumbnail 自动更新，preview 刷新即见最新。

## K. Document-to-visual（PDF 输入 → 信息可视化）

NB2 把 `.pdf` 当 reference 喂进去会**真读 PDF 文本 + 表格**，然后按你的 prompt 生成 accurate 信息可视化。spike 实测一份 745 字节的 Q3 sales report PDF，模型把 "$4.2M / +18% / APAC / 42% / 8,500 / +25% YoY" 全部精准还原进 4 stat card 信息图。

**用法**：直接把 PDF 路径放 `referenceImages`，跟 image reference 同接口：

```js
mcp__nodesign__generate_image({
  prompt: "<想要的可视化 — 见下方 4 类场景>",
  aspectRatio: "16:9",
  imageSize: "2K",
  assetRole: "infographic",
  referenceImages: ["assets/uploads/q3-sales-report.pdf"],
})
```

### 4 类高 ROI 场景

| 场景 | 用户行为 | prompt 模板 |
|---|---|---|
| **研究报告 → infographic** | 用户上传白皮书 / 行业报告 PDF | `"Use the provided PDF as the factual source. Extract the [N] most important [data points / findings / metrics] for [audience]. Create a [aspect] [infographic / dashboard / chart] with [N zones / cards / sections]. Use [visual style: minimal / corporate / editorial]. Do not invent facts not present in the PDF."` |
| **brand guideline → 风格锚** | 用户上传 brand book / VI 手册 PDF | `"Use the provided brand guideline PDF as the visual reference. Generate a [hero / cover / mood board] that strictly follows the brand's primary palette, typography spirit, and tonal system from the PDF. Apply to a [deck cover / product mockup / scene]."` —— 后续每张图都引同一个 PDF 让整 deck 锁品牌 |
| **outline / meeting notes → deck 视觉骨架** | 用户上传 outline / 纪要 PDF | `"Read the document outline in the PDF. For each section, generate a thumbnail-style visual representing its core idea. Layout as a [N×M grid] storyboard for a [deck] structure."` |
| **竞品 deck → 模仿+创新** | 用户上传竞品 deck PDF | `"Reference the layout, color, and visual hierarchy of the provided competitor deck PDF. Create a similar visual style for [your topic]. Adapt their best layout patterns but use [your brand palette]."` |

### Prompt 写作要点

- **明确"用 PDF 作为 factual source"** —— 防止 NB2 把 PDF 当装饰参考随便发挥；要它**真读内容**
- **明确"don't invent facts not in the PDF"** —— 信息可视化场景幻觉成本极高（编一个数字 = 整张图作废）
- **指定数据维度** —— "extract the 5 most important metrics" 比 "summarize the report" 准
- **指定视觉风格** —— editorial / corporate / minimal / dashboard 等具体词，别留 "good design"

### 已知限制

- **PDF 单文件 ≤ 50MB**（gateway 限制）；超大 PDF 拆成多个分别喂
- **PDF 只读文本 + 表格** —— PDF 里的图片、复杂图表、扫描页 NB2 不一定准确还原；纯图片 PDF 应当成 image reference 处理
- **PDF 算 reference budget** —— 1 个 PDF = 占 1 个 reference 槽位（共 14 槽）
- **PDF 不能做 character ref** —— PDF 算 object，不占 4 char ref 槽位

## L. Image Search Grounding（NB2 调 Google Image Search 锚真实场景）

NB2 独有能力：传 `useGrounding: true`，模型在生图前可调 Google Image Search 拿真实参考，渲染出来的视觉**锚到现实实体**——不是模型脑里"通用印象"。

spike 实测：地标场景（Cape Coast Castle）开 grounding 出来的图能看到加纳国旗 + 真实建筑细节；不开 grounding 是模型脑里"通用非洲殖民堡垒"。

### 用 vs 不用决策表

| 场景 | 用 grounding？ | 理由 |
|---|:---:|---|
| 真实地标 / 建筑 / 城市风貌 | ✅ | 模型对最近发布 / 小众建筑不熟，grounding 救场 |
| 真实产品 / 设备（特别是新发布）| ✅ | knowledge cutoff 之后的产品脑里没参考 |
| 自然风光 / 特定地理位置 | ✅ | 季节 / 气候 / 时段细节模型容易脑补错 |
| 特定品牌门店 / 工厂 / 办公场景 | ✅ | 品牌识别度强的场景 |
| 历史事件场景 / 新闻图风格 | ⚠️ 慎用 | 新闻图敏感，attribution 必须显，cookbook agent 不直接做 |
| **真实人物 / 名人 / 角色 / 二次元 IP** | ❌ 没用 | model 自己拒触发（Google guardrail "no Image Search for people"），传了也是 vanilla 行为 |
| 抽象 / 装饰 / 纹样 / 图标 | ❌ 没用 | 没有"真实参考"语义，浪费 60-90s |
| 概念图 / 隐喻 / 象征 | ❌ 没用 | 同上 |
| 草稿 / 探索阶段 | ❌ 别用 | 慢 + 后期不一定用，纯浪费 |

### 调用

```js
mcp__nodesign__generate_image({
  prompt: "A photorealistic image of Cape Coast Castle in Ghana as it looks today, midday tropical sun, aerial shot showing the white fortress walls and Atlantic Ocean.",
  useGrounding: true,    // ← opt-in
  aspectRatio: "16:9",
  imageSize: "2K",
  assetRole: "section-divider",
})
```

### 工作流约束

| 项 | 说明 |
|---|---|
| **Latency** | 真触发 grounding 时 ~60-90s（vs 普通生图 ~15-30s）。draft 阶段别开 |
| **成本** | gateway 可能按 search query 额外计费，但单图溢价不大；锚点图值得 |
| **人物自动跳** | 模型对 portrait / character / "specific person" 类 prompt 不会真触发 grounding，wrapper 返回 caption 会带上 "(grounding requested but model didn't fire — likely person/character query)" 让你知道 |
| **Attribution** | wrapper 把完整 attribution metadata 落到 `assets/generated/<name>.grounding.json` sidecar；CallToolResult 里第二个 text block 显示 queries + top sources URL 让你简短报给用户（"已用 Google Image Search 锚 5 个 source"）|
| **Reference 互补** | 跟 `referenceImages` 不冲突——grounding 是模型动态拉，referenceImages 是你显式喂；同时用得到，模型会综合两边 |

### 反例：别凡事都开

错误用法 → 浪费 60-90s + 出图也没区别：
- ❌ 装饰背景 / pattern / 抽象艺术 → 不开 grounding
- ❌ 角色 / portrait → 不开（模型自己拒）
- ❌ 多变体探索 → 用 vanilla 出 3 个候选选一个，**只对最终选中的那张** rerun + grounding
- ❌ 同 prompt 反复 reroll —— grounding 不是质量万能药，prompt 不准 grounding 也救不回

## M. remove_background —— 独立 MCP 工具抠透明背景

NB2 模型本身不支持 transparent bg（永远填某色背景），canvas bg 跟 NB2 默认色冲突时（agent 写黄底 deck，NB2 出灰底图直接糊）。**独立工具** `mcp__nodesign__remove_background({ inputPath })` 调 server 端 rembg (U²-Net ML segmentation) 抠掉背景，输出 RGBA PNG 给你叠在任何 canvas 上。

**为什么独立工具不绑 generate_image flag**：实际场景比"刚生的图想透明"更广——用户上传的产品照、之前生过的图、截图都该能抠。生图后想抠就再调一次本工具，0 重复 token。

### 何时调

| 场景 | 调 remove_background? |
|---|---|
| 角色 / portrait 叠到自定 bg 上（lifestyle photo + 品牌色背景） | ✅ |
| 产品 / 物体（咖啡杯 / 鞋 / 瓶子）做 hero 主图 | ✅ |
| 复杂带形状的 logo / 徽章 NB2 出底色冲突 | ✅ |
| 用户上传的参考图带白底 / 复杂背景，要叠到 deck | ✅ |
| 装饰性 pattern / texture / gradient 背景 | ❌（这些就是要带 bg） |
| 整页 cover / hero（背景就是整页主调） | ❌ |
| 简单线性图标（孤立图形，无渐变 / 阴影） | ❌——直接 `import { Heart } from 'lucide-react'` 走 SVG，免成本天然透明 |

### 调用

```js
// Case 1: 给刚生的图抠（生图 → 抠 两步）
const gen = mcp__nodesign__generate_image({
  prompt: "A glossy ceramic coffee mug with steaming hot drink, photorealistic, top-down view, 85mm macro, soft natural light",
  aspectRatio: "1:1",
  imageSize: "1K",
  assetRole: "decoration",
  outputName: "coffee-mug",
});
// agent 看完图觉得想要透明叠到黄底上 →
mcp__nodesign__remove_background({
  inputPath: "assets/generated/coffee-mug.png",
});
// 落 assets/generated/coffee-mug-nobg.png（RGBA）

// Case 2: 给用户上传的图抠
mcp__nodesign__remove_background({
  inputPath: "assets/user-uploaded-product.jpg",
  outputName: "product-isolated",  // 可选，default 是 <inputBaseName>-nobg
});

// Case 3: 已存在 outputName 时，default 加 timestamp 后缀防误覆盖；想覆盖：
mcp__nodesign__remove_background({
  inputPath: "assets/photo.png",
  outputName: "photo-clean",
  overwrite: true,
});
```

agent 拿到的 caption 形如 `Removed background from assets/photo.png → assets/generated/photo-nobg.png (RGBA PNG, 245.3 KB, 1240ms)` + image content block 直接 vision 看到效果。HTML 直接 `<img src="assets/generated/photo-nobg.png" style="...">` 叠在任何 bg 色上。

### 工作流约束

| 项 | 说明 |
|---|---|
| **Latency** | 首次抠图 +5-10s（onnxruntime cold start + u2net 模型加载）；后续同 server 实例 +1-2s |
| **输出格式** | 强制 .png（RGBA 必须 PNG）。input 支持 png/jpg/jpeg/webp/gif/bmp/tiff |
| **边缘质量** | 主体边界清晰时干净；薄透元素（玻璃 / 烟雾 / 飘发 / 半透明披纱）边缘可能软或抠不全 |
| **依赖前提** | server 端 `.venv-rembg/` 装了 rembg + onnxruntime（部署一次），跨 session 共享。不可用时工具返 isError + 提示 setup 命令 |
| **路径安全** | inputPath 必须 workspace-relative，不允许绝对路径 / .. traversal。候选路径解析顺序：cwd → sharedRoot |

### 反例

- ❌ 给每张生图都自动 follow-up 抠 —— 5-10s × N 累计很快；只对**真要叠合**的图按需调
- ❌ 给整页 cover / hero 抠 —— cover 本身的 bg 就是设计的一部分，抠掉等于自废武功
- ❌ 期望 SVG 级精度抠图 —— ML 抠图永远是 raster + 边缘软化，要硬边走 SVG / Figma 切图
- ❌ 复杂遮挡（人在树后） —— 模型可能抠掉树或抠掉手，预期管理
