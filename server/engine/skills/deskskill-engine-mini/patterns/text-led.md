# Text-led（layout-role: `text-led`）

> 文为主，图当 frame ≤ 30%。decision 论点页 / sales 痛点页 / knowledge 段论页。

## 何时用

- **decision 类**论点页 / 结论页（核心是文字论证，图是配重）
- **sales 类**痛点页 / 解决方案概述（文字承载 narrative，图当 frame）
- **knowledge / academic 类**段论页 / 概念页
- **emotion 类** quote 替代页（不用 quote-backdrop 时的文字主导页）
- 跟 `image-led-cover` 区别：text-led 是文 70%+ / 图 ≤ 30% 当 frame；image-led 是图 80-100%

## 标记规约

| 元素 | 必/选 | 规约 |
|---|---|---|
| `<section data-page="N">` | 必装 | |
| `data-anchor="<role>-pN"` | 推荐关键文字 | 跨 turn 改时加 |
| `data-layout="content"` / 自定 | 选填 | |
| `data-layout-role="text-led"` | 必装 | |
| `<img>` 配重图 | 选填 | grid 右格或角落，**≤ 30% 面积** |
| `data-asset-role="frame"` | 必装 img（如有）| |
| `data-asset-source="generated"` | 必装 img | |
| h2 标题 | 必装 | font-display + var(--h1) |
| 段落 / ul | 必装 | leading-relaxed |

## 写法铁律

1. **`grid-cols-[1fr_400px]` 文字优先** —— 图区固定 400px 是骨架；可调到 [1fr_360px] / [1fr_480px]
2. **图占比 ≤ 30%** —— 超过就该走 hybrid，不是 text-led
3. **段落 ≤ 3 段** —— 演示稿不是论文，超过 3 段说明该拆页
4. **ul ≤ 5 项** —— 超过 5 项说明该用 Card 阵列（hybrid-grid）或 Tabs（switcher）
5. **不要 image-led 那套 overlay** —— text-led 的图就是 frame，clean rounded-xl + object-cover 即可

## 最小代码片段

```html
<section data-page="4" data-anchor="argument-p4"
         data-layout="content" data-layout-role="text-led"
         class="bg-[var(--paper)]">
  <div class="h-full grid grid-cols-[1fr_400px] gap-16 p-24">
    <div class="flex flex-col gap-6">
      <h2 class="font-display text-[var(--ink)] leading-none"
          style="font-size: var(--h1)">
        {页标题 · 改我}
      </h2>
      <p class="text-xl text-[var(--ink)]/80 leading-relaxed">
        {首段 · 主论点 · 改我}
      </p>
      <ul class="text-lg text-[var(--ink)]/70 space-y-3 list-disc pl-6">
        <li>{要点 1}</li>
        <li>{要点 2}</li>
        <li>{要点 3}</li>
      </ul>
    </div>
    <img src="assets/generated/frame-decor.jpg"
         data-asset-role="frame"
         data-asset-source="generated"
         class="w-full h-full object-cover rounded-xl" alt="" />
  </div>
</section>
```

**纯文 text-led 变体**（无配重图）：去掉 grid，直接 `flex flex-col p-32` 大留白。
