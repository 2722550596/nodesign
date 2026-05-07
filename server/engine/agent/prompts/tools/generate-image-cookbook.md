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

## A. 模型本质 —— 用之前必须知道

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

## E. Reference image 4 大模式（max 14 张：≤4 人物 + ≤10 物体）

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
| **真实主体锚定（web 搜来的 reference）** | 模型不熟的产品/品牌/最新事件 → 先 `web_search { include_images: true }` 拿真实图，再把 `assets/references/ref-xxx.<ext>` 喂 `referenceImages` + prompt"Use the product in Reference 1 as the subject; render it in [your scene]" |

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

## G. Conversational in-painting 语言（精修 ≫ 重画）

| 想做的 | ❌ 不要 | ✅ 应该 |
|---|---|---|
| 改光线 | 重生整张 | "Keep composition, change lighting to golden hour" |
| 换背景 | 重生整张 | "Replace the background with a neon-lit city street" |
| 删元素 | 重生整张 | "Remove the person on the left and extend the sidewalk" |
| 换字体 | 重生整张 | "Keep the layout but change the headline font to a bold serif" |
| 局部精修 | 重生整张 | screenshot_canvas + "Soften the headline color in the top-left corner; everything else identical" |

配合 `screenshot_canvas` 截当前页当 reference → 上面这种 prompt = 精修而非重画。

## H. 工具签名 + 默认值

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

## I. Prompt 质量自检 6 维度（输出不理想时对照看）

- **结构** — 关键词堆砌（`"woman blue dress sunny"`）vs 自然段落描述。后者通常输出更稳，见 § B 5 元素公式
- **逻辑** — 否定描述（`"no cars"` / `"without people"`）模型容易理解反；改用肯定场景（`"empty pedestrianized street"`）更可控
- **修饰词** — `"nice"` / `"pretty"` / `"cool"` / `"高级感"` 过度抽象；用具体视觉词（灯光 / 材质 / 色温 / 字号）替代效果更可控
- **风格锚** — 没指定艺术流派 / 摄影风格 → 输出容易游移；点名一两个参考（`"Saul Bass minimalist"` / `"Fujifilm color science"`）会定向
- **文字精度** — 渲文字不带引号 + 不指定字体 → 容易跑样；明确 `render the text "XXX" in [Font Name]` 更稳
- **跨页一致** — 多页角色故事缺 referenceImages anchor → 每页独立生成时角色 / 调性容易漂；第 1 张定好后用 referenceImages 跨页复用

**额外注意**：
- icon / sticker 默认会出灰底（Nano Banana 不支持 transparent）— 明确 `"white background"` 可消除
- 同 outputName 反复 reroll（≥3 次同 prompt）收益递减；改 prompt 关键参数或询问用户新方向通常更有效

## J. 调完必做

1. **`record_decision`** —— 把 prompt + role + path + 用户评价记 spec.json，重生时能查回
2. **关键节点的反馈循环**：cover / 第一个 portrait / logo 嵌入这种页面级 anchor（会被当 referenceImages 种子用于 downstream），生完图后在自然回话里邀请用户反馈一下方向（例如："这个 cover 当全 deck 视觉锚 OK 吗？想换风格告诉我"）。这些是 downstream 的种子，早定早收益；用户下一轮 chat 反馈就是 conversational gate（generate_image 的 image content block 已自动渲染在 chat，用户能直接看到）。
