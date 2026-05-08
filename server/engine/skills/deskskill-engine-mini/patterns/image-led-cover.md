# Image-led Cover（layout-role: `image-led`）

> 封面 / 大 hero — 图占 100% + 文字浮层。emotion / launch / ceremony 类首页常用。

## 何时用

- **emotion / launch / ceremony 类**首页（封面 cover）—— 通过"图压全屏 + 大字 overlay"奠定 deck 主视觉锚
- **decision / sales / funding 类**做强视觉冲击的封面（克制使用，主体仍依赖 text-led / data-led）
- **跨 deck 视觉一致性的种子**：cover 用户 OK 后作为后续每张 hero / section-divider 的 `referenceImages` 跨页固定角色
- 跟 `section-divider` 区别：cover 是"deck 入口"，section-divider 是"章节切片"——文案密度不同、章节号位置不同

## 标记规约

| 元素 | 必/选 | 规约 |
|---|---|---|
| `<section data-page="1">` | 必装 | 通常是 page 1（封面） |
| `data-anchor="cover"` | 必装 | section 级，跨 turn 引用 |
| `data-layout="cover"` | 选填 | layout 名 hint，按隐喻自由命名（"dig-cross-section" / "vinyl-spread" 等也 OK）|
| `data-layout-role="image-led"` | 必装 | 必标 |
| `<img>` 大图 | 必装 | absolute inset-0 object-cover 全屏铺底 |
| `data-asset-role="cover"` | 必装 img | 同 generate_image 的 `assetRole` 入参 |
| `data-asset-source="generated"` | 必装 img | 跟 user-upload 区分 |
| `data-asset-prompt="<short hint>"` | 选填 img | 重生时给 Tweaks UI 一个 short hint |
| `data-anchor="cover-title"` | 必装标题 h1 | deck 内唯一；同 deck 多 cover 时加 `-pN` 后缀 |
| `data-anchor="cover-sub"` | 选填副标 | 副标必装则配 `-pN`；不必时省 |

**不要写** `data-node-id`（已废，data-anchor 是单写源）。

## 写法铁律

1. **图传达的别再用文字重述**——"古书堆图"旁不写"古典氛围"。两者重复 = 设计不自信
2. **文字 ≤ 3 行**（标题 + 可选副标 + 可选 footer 编号）—— 多于这数说明该 page-role 选 text-led / hybrid 而非 image-led
3. **overlay 用 `linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.55))`** 只压底部 + 大字 + `drop-shadow-lg` —— **别加纯黑半透明压全图亮度**（"半透明黑蒙层"是 designer 偷懒）
4. **图 absolute inset-0 object-cover** 是骨架不是定值；`object-position` 按视觉重心调（人物 cover 通常 center-top）
5. **referenceImages 种子**：第一张 cover 用户 approve 后，主动 `request_image_approval` 多张候选并排让用户选，避免风格漂移返工

## 最小代码片段（占位骨架，按隐喻填）

> ⚠️ 这是占位骨架，按你的核心隐喻 + design-tokens 填实。**别 cp 当 final layout**——下面的 `font-display` / `var(--hero)` / 渐变比例都只是默认值。

```html
<section data-page="1" data-anchor="cover"
         data-layout="cover" data-layout-role="image-led"
         class="relative overflow-hidden">
  <img src="assets/generated/cover-1.jpg"
       data-asset-role="cover"
       data-asset-source="generated"
       data-asset-prompt="<short prompt summary>"
       class="absolute inset-0 w-full h-full object-cover" alt="" />

  <!-- gradient overlay 只压底部，不压全图 -->
  <div class="absolute inset-0 flex items-end p-32"
       style="background: linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.55))">
    <div class="flex flex-col gap-6">
      <h1 data-anchor="cover-title"
          class="text-white font-display leading-[0.95] drop-shadow-lg"
          style="font-size: var(--hero); letter-spacing: -0.04em;">
        {大字标题 · 一行}
      </h1>
      <p data-anchor="cover-sub"
         class="text-white/80 text-2xl max-w-3xl"
         style="font-family: Instrument Serif, serif; font-style: italic;">
        {可选副标 · 改我或删}
      </p>
    </div>
  </div>

  <!-- 可选 footer 编号 -->
  <div class="absolute top-12 right-12 font-mono text-xs uppercase tracking-widest text-white/70">
    01 / N
  </div>
</section>
```

**填实时考虑**：
- 隐喻是"暗童话"→ `--hero` 用衬线 + 字距更紧 / 渐变可以加 radial 暗角
- 隐喻是"实验报告"→ 标题用 mono / 加编号侧栏 / 渐变细一些只 ≤ 30%
- 隐喻是"占卜卡"→ 中心居中而非 items-end / 加周边古文符
