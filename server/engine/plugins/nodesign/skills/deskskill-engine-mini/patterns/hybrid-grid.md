# Hybrid Grid（layout-role: `hybrid`）

> 图文 grid，3 图 + caption 网格。sales feature 阵列 / launch 多 variant 展示 / portfolio 案例集。

## 何时用

- **sales 类**feature 阵列（产品功能多个并列）
- **launch 类**多 variant / 多型号展示
- **portfolio / 作品集**案例 grid
- **knowledge 类**步骤对照（每格一步骤 + caption）
- ⚠️ **超过 6 格切到 `<Tabs>` 或 embla-carousel** —— grid 太多视觉碎片化
- ⚠️ **feature 阵列 / variant 展示场景**：单页 ≤ 4 件 → **首选 `<Tabs>`**（visitors 一次扫一个）；> 4 件用 grid 或 embla（详见 SKILL.md hybrid 选型表）

## 标记规约

| 元素 | 必/选 | 规约 |
|---|---|---|
| `<section data-page="N">` | 必装 | |
| `data-anchor="grid-pN"` | 选填 | 跨 turn 改单格时加 |
| `data-layout="grid"` / 自定 | 选填 | |
| `data-layout-role="hybrid"` | 必装 | 必标 hybrid（图文 grid 平分）|
| 每格 `<img>` | 必装 | aspect-[4/3] / aspect-[3/2] 锁比 |
| `data-asset-role="illustration"` | 必装 img | 装饰 illustration 或 sample |
| `data-asset-source="generated"` | 必装 img | |
| caption 段 | 必装 | text-sm muted 小字 |
| h2 总标题 | 必装 | font-display |

## 写法铁律

1. **`grid-cols-3 gap-6` 是常见骨架** —— 也可 cols-2 / cols-4，按格数调
2. **`aspect-[4/3]` 锁比** —— 不锁比例 grid 容易高度不齐
3. **caption 用 muted 小字** —— `text-sm text-[var(--muted)]`
4. **3 张图共用 referenceImages 系列** —— 跨格保风格一致（generate_image 多次调用同 ref）
5. **超过 6 格** → **切到 `<Tabs>` 或 embla-carousel-react**（grid 太多视觉碎片化）
6. **feature 阵列优先 reach for `<Tabs>` / `<Card>` 而非纯 grid** —— SKILL.md hybrid 选型表 sales/launch 行明确推荐

## 最小代码片段

```html
<section data-page="6" data-anchor="grid-p6"
         data-layout="grid" data-layout-role="hybrid"
         class="bg-[var(--paper)] p-24">
  <h2 class="font-display text-[var(--ink)] mb-8"
      style="font-size: var(--h2)">
    {Grid 标题 · 改我}
  </h2>
  <div class="grid grid-cols-3 gap-6 h-[calc(100%-120px)]">
    <div class="flex flex-col gap-2">
      <img src="assets/generated/grid-1.jpg"
           data-asset-role="illustration"
           data-asset-source="generated"
           class="w-full aspect-[4/3] object-cover rounded-lg" alt="" />
      <div class="text-sm text-[var(--muted)]">{caption 1}</div>
    </div>
    <div class="flex flex-col gap-2">
      <img src="assets/generated/grid-2.jpg"
           data-asset-role="illustration"
           data-asset-source="generated"
           class="w-full aspect-[4/3] object-cover rounded-lg" alt="" />
      <div class="text-sm text-[var(--muted)]">{caption 2}</div>
    </div>
    <div class="flex flex-col gap-2">
      <img src="assets/generated/grid-3.jpg"
           data-asset-role="illustration"
           data-asset-source="generated"
           class="w-full aspect-[4/3] object-cover rounded-lg" alt="" />
      <div class="text-sm text-[var(--muted)]">{caption 3}</div>
    </div>
  </div>
</section>
```

**用 `<Card>` 替代纯 grid（推荐 sales / launch / decision feature 阵列）**：

```jsx
// 在 babel script 段（模板自带 <Card> 简化版，无需 import）
<section data-page="6" data-layout="feature-cards" data-layout-role="hybrid">
  <div className="grid grid-cols-3 gap-6 p-24">
    <Card><CardHeader><CardTitle>{Feature 1}</CardTitle></CardHeader>
      <CardContent>{description}</CardContent></Card>
    {/* ... */}
  </div>
</section>
```

**用 `<Tabs>` 替代（推荐 ≤ 4 variant 切换）**：

```jsx
<section data-page="6" data-layout="variant-showcase" data-layout-role="hybrid">
  <Tabs defaultValue="v1">
    <TabsList>
      <TabsTrigger value="v1">{Variant 1}</TabsTrigger>
      <TabsTrigger value="v2">{Variant 2}</TabsTrigger>
    </TabsList>
    <TabsContent value="v1">...</TabsContent>
    <TabsContent value="v2">...</TabsContent>
  </Tabs>
</section>
```
