# Portrait（layout-role: `image-led`）

> 人物 / 演讲者卡片 — 4:5 居左图 + 右侧元数据 + quote。

## 何时用

- **emotion 类**主角介绍页 / 角色卡
- **sales / funding 类**团队页 / 创始人介绍
- **decision 类**专家背书页（4:5 比例 vs landscape 是"个人"vs"环境"的暗示）
- 跟 `quote-backdrop` 区别：portrait 是"人 + quote"，backdrop 是"图弱化 + 大字引言"——人物在不在前景看清

## 标记规约

| 元素 | 必/选 | 规约 |
|---|---|---|
| `<section data-page="N">` | 必装 | |
| `data-anchor="portrait-<name>-pN"` | 必装 | deck 内唯一；多 portrait 时加 `-pN` 页号后缀 |
| `data-layout="portrait"` | 选填 | layout hint |
| `data-layout-role="image-led"` | 必装 | |
| `<img>` 4:5 / 2:3 | 必装 | grid 左格，object-cover |
| `data-asset-role="portrait"` | 必装 img | |
| `data-asset-source="generated"` | 必装 img | |
| Speaker label（mono）| 推荐 | 角色名 / title，小字打底 |
| 姓名 h2 | 必装 | font-display + var(--h1) |
| Quote / tagline | 推荐 | italic + Instrument Serif |

## 写法铁律

1. **`grid-cols-[480px_1fr]` 是骨架不是定值** —— 不同视觉密度可调到 [400px_1fr] / [560px_1fr]
2. **圆角 `rounded-2xl` 别全圆** —— 全圆（rounded-full）人物失去稳重感，rounded-2xl 现代但保留方寸
3. **引用 quote 用 italic + Instrument Serif** —— 跟正文衬线区分
4. **speaker label 用 mono 小字** —— "Speaker" / "Founder" / "角色名"，反差衬托姓名
5. **图选择**：generate_image 时 `assetRole="portrait"`，aspectRatio="4:5"；多人物时 referenceImages 锁定光线 / 风格

## 最小代码片段

```html
<section data-page="3" data-anchor="portrait-maya-p3"
         data-layout="portrait" data-layout-role="image-led"
         class="bg-[var(--paper)]">
  <div class="h-full grid grid-cols-[480px_1fr] gap-24 p-24">
    <img src="assets/generated/portrait-maya.jpg"
         data-asset-role="portrait"
         data-asset-source="generated"
         class="w-full h-full object-cover rounded-2xl" alt="Maya Chen" />

    <div class="flex flex-col justify-center gap-6">
      <div class="font-mono text-sm tracking-widest uppercase text-[var(--muted)]">
        {Speaker / 角色名}
      </div>
      <h2 class="font-display text-[var(--ink)] leading-none"
          style="font-size: var(--h1)">
        {Maya Chen}
      </h2>
      <p class="text-2xl text-[var(--muted)] italic"
         style="font-family: Instrument Serif, serif;">
        {一句 quote 或 tagline · 改我}
      </p>
    </div>
  </div>
</section>
```
