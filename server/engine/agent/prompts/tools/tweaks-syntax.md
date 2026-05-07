# expose_tweaks 完整语法

> 此文件由 PreToolUse(mcp__nodesign__expose_tweaks) hook 在 agent 首次调用时注入。
> SKILL.md 已含精简版"暴露什么 / 何时暴露"哲学；本文是控件 schema 详解。

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

## 5 种 control type

- `slider` —— 数值连续可调（字号 / 间距 / 圆角）
- `color` —— 颜色（accent / bg）
- `segmented` —— 少数互斥选项（density / variant），一般 2-4 个
- `toggle` —— on/off（暗色模式 / 简洁模式）
- `select` —— >4 选项的 dropdown（字体家族）

## target_var vs target_class_on

- 99% 用 `target_var` + 对应 CSS variable（更灵活，连续值也能改）
- 只有 segmented / toggle 改的是"加 class 切样式分支"时才用 `target_class_on`

## target_scope —— per-page / per-layout 限定影响范围

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

## Tweaks ↔ Tailwind 桥接（hybrid 范式硬规约）

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

## 常坑

- **暴露过多** → 信息过载，5-8 个核心维度足够（暴露 20 个用户晕）
- **target_var 不以 `--` 开头** → zod 校验会拒
- **slider 没 unit** → 默认 px 也写明白
- **Apply 后只改 :root，忘了再 expose_tweaks 更新 default** → 下次开界面看到旧值
- **target_scope 写了但 canvas.html 没有对应 selector 的 CSS rule** → 控件失灵

## 调用范例（典型 deck 第一版完成后一次性调）

```js
mcp__nodesign__expose_tweaks({
  controls: [
    { id: 'accent', type: 'color', label: '主色', target_var: '--accent', default: '#c45c3f' },
    { id: 'paper', type: 'color', label: '背景纸色', target_var: '--paper', default: '#f9f8f6' },
    { id: 'hero_size', type: 'slider', label: '封面字号',
      target_var: '--hero', target_scope: 'section[data-page="1"]',
      min: 80, max: 160, step: 4, default: 112, unit: 'px' },
    { id: 'density', type: 'segmented', label: '排版密度',
      target_class_on: 'density-compact',
      options: [
        { label: '紧凑', value: 'compact' },
        { label: '均衡', value: 'balanced' },
        { label: '舒展', value: 'spacious' },
      ], default: 'balanced' },
  ],
  replace: false,
})
```
