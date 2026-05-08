# Section Divider（layout-role: `image-led`）

> 章节扉页 — 全屏图 + 章节号大字。多章节 deck（≥ 6 页）切章用。

## 何时用

- **多章节 deck（≥ 6 页）**的章节切片
- **funding / launch 中段**的"why now / why this / why us"等三段式
- **knowledge 教程**章节起头
- 跟 `image-led-cover` 区别：cover 是 deck 入口，divider 是中段切片——章节号必装，文案密度更低

## 标记规约

| 元素 | 必/选 | 规约 |
|---|---|---|
| `<section data-page="N">` | 必装 | 通常 page 2-N |
| `data-anchor="section-N"` | 选填 | 不必 chat 引用时可省（但跨 turn 提"章节 2 那个"时方便）|
| `data-layout="section-divider"` | 选填 | layout hint |
| `data-layout-role="image-led"` | 必装 | image-led 类型 |
| `<img>` 全屏图 | 必装 | absolute inset-0 object-cover |
| `data-asset-role="section-divider"` | 必装 img | 同 generate_image |
| `data-asset-source="generated"` | 必装 img | |
| 章节号 | 必装 | mono + tracking 大间距，前置（"CHAPTER 02"）|
| `data-anchor="section-N-title"` | 选填标题 | 跨 turn 改时加 |

## 写法铁律

1. **章节号 + 标题** 是核心结构，bullet / 段落都该砍掉（这是过渡页，不是论点页）
2. **章节号用 mono 字体 + tracking-[0.4em]** 强机械感；标题用 font-display 反差
3. **radial-gradient overlay 比 linear 更"切片感"**：`radial-gradient(circle at center, rgba(0,0,0,0.35), rgba(0,0,0,0.55))`
4. **垂直居中 + 文字左右居中**（不像 cover 是 items-end）—— 仪式感
5. **图选择**：跟 cover 同 `referenceImages` 系列保风格一致，但场景换（cover 是产品 hero，divider 是 environment / mood）

## 最小代码片段

```html
<section data-page="5" data-anchor="section-2"
         data-layout="section-divider" data-layout-role="image-led"
         class="relative overflow-hidden">
  <img src="assets/generated/section-2-bg.jpg"
       data-asset-role="section-divider"
       data-asset-source="generated"
       class="absolute inset-0 w-full h-full object-cover" alt="" />

  <div class="absolute inset-0 flex flex-col justify-center items-center text-center p-32"
       style="background: radial-gradient(circle at center, rgba(0,0,0,0.35), rgba(0,0,0,0.55))">
    <div class="font-mono text-white/80 text-sm tracking-[0.4em] mb-6">
      CHAPTER 02
    </div>
    <h2 class="text-white font-display leading-none"
        style="font-size: var(--hero); letter-spacing: -0.04em;">
      {章节标题 · 改我}
    </h2>
  </div>
</section>
```
