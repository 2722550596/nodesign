# Quote Backdrop（layout-role: `image-led`）

> 图弱化作衬底 + 大字引言。emotion 中段情绪页 / decision 关键转折页 / launch 立意页。

## 何时用

- **emotion 类**情绪转折页（quote 是 deck 节奏的"暂停"）
- **decision 类**关键转折页（一句 quote 推动判断 X → Y）
- **launch 类**立意页（"why we built this" / 创始人 quote）
- 跟 `portrait` 区别：portrait 是"人 + quote 装饰"，backdrop 是"quote 主角 + 图淡化衬托"

## 标记规约

| 元素 | 必/选 | 规约 |
|---|---|---|
| `<section data-page="N">` | 必装 | |
| `data-anchor="quote-pN"` | 推荐 blockquote | deck 内多 quote 时加页号后缀 |
| `data-layout="quote"` | 选填 | layout hint |
| `data-layout-role="image-led"` | 必装 | image 仍是 layout-role 主角，只是被弱化 |
| `<img>` 衬底 | 必装 | absolute inset-0 + opacity-30（关键）|
| `data-asset-role="quote-backdrop"` | 必装 img | |
| `data-asset-source="generated"` | 必装 img | |
| `<blockquote>` | 必装 | font-display + italic + var(--h1) |
| Source / 出处 | 推荐 | mono + 破折号前置 |

## 写法铁律

1. **`opacity-30` 是上限**（更淡读不出底图意境）—— 别用 `opacity-10` 那种"怕被看到"的衬底
2. **用 `paper/40` 罩底而非纯白**（保留底图的色彩透气）—— `bg-[var(--paper)]/40`
3. **quote 下挂 source 用 — 破折号 + mono 小字** —— "— Wong Kar-wai" 比 "by Wong Kar-wai" 文气
4. **垂直居中 + 文字左右居中** —— 仪式感（vs portrait 的左右排）
5. **不要堆装饰元素** —— quote 页是"减法"，加 1 个装饰 = 减 1 个文字段（4 铁律 ④）

## 最小代码片段

```html
<section data-page="7" data-anchor="quote-p7"
         data-layout="quote" data-layout-role="image-led"
         class="relative overflow-hidden">
  <img src="assets/generated/quote-bg.jpg"
       data-asset-role="quote-backdrop"
       data-asset-source="generated"
       class="absolute inset-0 w-full h-full object-cover opacity-30" alt="" />

  <div class="relative h-full flex flex-col justify-center items-center text-center p-32 bg-[var(--paper)]/40">
    <blockquote class="max-w-5xl font-display text-[var(--ink)] italic"
                style="font-size: var(--h1); line-height: 1.15;">
      {一句改变设计观的 quote · 改我}
    </blockquote>
    <div class="mt-8 font-mono text-sm tracking-widest text-[var(--muted)]">
      — {Source · 出处}
    </div>
  </div>
</section>
```
