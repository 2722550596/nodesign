# AskUserQuestion —— NoDesign 约定（首次调用时注入）

> SDK preset `claude_code` 自带 AskUserQuestion 工具用法；本节是 NoDesign 项目对该工具的**额外约定**（特别是 `preview` 字段渲染方式），SDK preset 不含这部分。

### 何时用 AskUserQuestion vs chat 文本

**有结构化候选（A/B/C）时优先 AskUserQuestion**——用户看到带选项按钮的卡片，点一下就回到 agent，比让用户打字答效率高很多。

| 场景 | 用什么 |
|---|---|
| 离散选择（A/B/C 三选一） | ✅ AskUserQuestion |
| 视觉方向 / 配色 / 字体 / 排版风格分类 | ✅ AskUserQuestion + preview |
| 用户给了 reference 但风格模糊 → 提供 2-3 个解读方向 | ✅ AskUserQuestion + preview |
| 开放问题（"你喜欢什么色调？"） | ❌ chat 文本（用户更易具体回答） |
| 简单 yes/no | ❌ chat 文本 |
| 需要用户写一段说明 | ❌ chat 文本 |

### 调用 schema

```js
{
  questions: [
    {
      question: "<完整问题文本>",
      header: "<≤12 字 chip 标签>",
      options: [
        { label: "<1-5 词>", description: "<一句话 trade-off>", preview: "<可选>" },
        ...
      ],
      multiSelect: false,  // 默认 false；候选互不互斥时 true
    }
  ]
}
```

单次调用 **1-4 个 question**，每个 question **2-4 个 option**。

### 写好选项的诀窍

- 选项要**互斥**（避免 "A" 和 "A 加一点 B" 这种边界模糊的对）
- 每个 label 1-5 词 + 一句 description 解释 trade-off
- 最多 4 选项，多了用户晕
- **不要加 "Other / 其他"** —— 系统自动提供（SDK 默认行为）

### `preview` 字段 — 选项要"看到"差异时给

前端**自动检测内容形态**分派渲染（多模态 preview）：

| preview 内容 | 渲染方式 | 适用场景 |
|---|---|---|
| `data:image/...;base64,XXX` | `<img>` 直接显 | 多变体并排选 cover/portrait（先 generate_image 出图再当 preview） |
| `https://...` / `/api/.../assets/...` 以 .png/.jpg 结尾 | `<img>` 直接显 | 已有 asset path 直接当 preview |
| `assets/generated/x.jpg` 相对路径 | `<img>` 直接显（fallback） | 同上简写 |
| 含 `<...>` 像 HTML | sandbox iframe srcDoc | 视觉方向 / 配色 / 字体 / 排版（约束见下） |
| 纯文本 | mono 字 fallback | 兜底 |

**HTML preview 约束**（视觉方向 / 配色 / 字体 / 排版示意场景）：
- 尺寸：240×140（前端 sandbox iframe 渲染区）
- 内容：**HTML 片段，每个元素 `style="..."` 属性写样式**。⚠️ SDK validator 硬性拒 `<style>` 和 `<script>` 标签——只能 inline style 属性（"inline" 字面理解：写在 element 里，不是 `<style>` 块）。也不能含 `<html>` / `<body>` / `<!doctype>` 等完整文档标签，纯 fragment。
- 体积：≤ 5KB（超出会被截断）
- 用途：让用户视觉对比 4 个选项的差异（主色 + 字体方向 + 排版示意），不是渲染完整页面

**典型 HTML preview 范例**（240×140 配色 + 字体方向，全 inline style）：

```html
<div style="background: #f9f8f6; padding: 12px; font-family: 'Lyon Display', 'Songti SC', 'Noto Serif SC', serif; color: #2d2418;">
  <h1 style="font-size: 28px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.02em;">Cover</h1>
  <p style="font-size: 11px; color: #c45c3f; margin: 0;">warm cream + cherry accent + serif</p>
</div>
```

字体 chain 4 段式（latin → 苹果 CJK → Noto CJK → generic）跟真 deck 同款规则——只是从 `<style>` 块挪到每个元素的 `style` 属性里。

### 何时用 image preview vs HTML preview vs 不带 preview

- **image preview**（base64 / asset path）：多张候选图选哪张（cover / portrait / decoration）→ 先 generate_image 出 3 变体，每个 option 的 preview 字段贴对应图
- **HTML preview**（240×140 self-contained）：视觉方向 / 配色 / 字体 / 排版 / **风格名候选** → 每个元素 `style="..."` 属性演示主色 / 字体 / 排版差异（**别用 `<style>` 块、`<script>`、`<html>`/`<body>`——SDK validator 拒**）

⚠️ **别把 web_search 搜来的图片网址直接当 preview**：判据要求地址以 `.png/.jpg/.jpeg/.webp/.gif/.svg` 结尾（可带 `?查询串`），很多图床地址不满足，会**静默退成纯文本**，用户看到一行网址而不是图。搜来的图是给你自己对齐理解用的；要让用户看，用 HTML 小样，或先 generate_image 再贴 base64。
- **不带 preview**：离散文字决策（yes/no, deck-kind 选择, 是否需要 PDF）→ 选项标签足够说明

---
