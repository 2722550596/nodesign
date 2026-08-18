# 文档.json 字段全集

这份文件回答一个问题：**写 `文档.json` 时哪些键是真的、值能填什么。**

引擎的 schema 是**闭合**的——不认识的键直接报错，不会静默吞掉。所以这里列全了，
列外的键写上去就是构建失败。（唯一例外是 `_` 开头的键，那是给你写注释用的，
构建前会被剥掉。）

一句话架构：**`文档.json` 是真相源，`.docx` 是构建产物。** 永远改 JSON 再
`build_docx`，不要去改 `.docx`。

---

## 顶层

```jsonc
{
  "v": 1,                    // 必填，只能是 1
  "preset": "办公标准",       // 可选，见下。省略则必须自己给全 tokens
  "tokens": { ... },         // 可选，覆盖 preset 的部分字段（深合并）
  "content": [ ... ],        // 必填，正文块数组，空数组会被拒
  "header": ... ,            // 可选，页眉
  "footer": ...              // 可选，页脚
}
```

`preset` 三选一，就是三种排版传统，不是三种"主题"：

| preset | 什么时候用 |
|---|---|
| `办公标准` | 通用中文文档：报告、方案、说明、简历 |
| `公文` | 按 GB/T 9704-2012 排的党政机关公文（仿宋三号正文、黑体标题） |
| `学术论文` | 论文体例：宋体小四、行距、章节编号感 |

`tokens` 是在 preset 上**深合并**，只写要改的那部分。不写 preset 就得把
`page` / `fonts` / `base` / `styles` 全部自己给齐。

---

## tokens.page

```jsonc
"page": {
  "size": "A4",                    // A4 | A3 | Letter | B5 | {wTwip, hTwip}
  "landscape": false,
  "marginsTwip": { "top": 1440, "bottom": 1440, "left": 1800, "right": 1800,
                   "header": 851, "footer": 992, "gutter": 0 },
  "docGrid": { "type": "lines", "linePitchTwip": 312 }   // 或 null
}
```

单位换算：**1 磅 = 20 twip，1 厘米 ≈ 567 twip，1 英寸 = 1440 twip**。
页边距 2.54cm = 1440，3.17cm = 1800。

`docGrid` 是中文排版的行网格（每页固定行数那种感觉），`null` 关掉。

## tokens.lang

```jsonc
"lang": { "latin": "en-US", "eastAsia": "zh-CN" }
```

## tokens.fonts —— 字体槽

⭐ **这是最容易写错的一处。** `fonts` 定义**具名槽**，风格里的 `run.font`
填的是**槽名**，不是字体名：

```jsonc
"fonts": {
  "正文":   { "eastAsia": "宋体",   "ascii": "Times New Roman", "hAnsi": "Times New Roman" },
  "标题":   { "eastAsia": "黑体",   "ascii": "Times New Roman", "hAnsi": "Times New Roman" },
  "等宽":   { "eastAsia": "宋体",   "ascii": "Consolas",        "hAnsi": "Consolas" }
}
```

然后 `"run": { "font": "正文" }`。槽名随便起（中文也行），但**必须先在 `fonts`
里注册**，否则报 `no such font slot`。

槽内四个位置各只能填**一个字体名，没有 fallback 链**（OOXML 就是这么规定的）：
- `eastAsia` 中日韩字符走这个
- `ascii` 拉丁字母数字走这个
- `hAnsi` 扩展拉丁，一般跟 `ascii` 填一样
- `cs` 复杂文种，中文文档基本用不到

`eastAsia` 请填**中文 Windows 一定有的**：宋体 / 黑体 / 微软雅黑 / 楷体 / 仿宋。
服务器渲染时会用替身字体（宋体→Noto Serif CJK 等），但用户在自己的 Word 里
打开时用的是真字体，所以这里要按用户机器上有什么来填。

## tokens.base —— 全文默认（docDefaults）

```jsonc
"base": {
  "sizePt": "小四",                 // 数字（磅）或字号名，见下表
  "color": "000000",               // RRGGBB，不带 #
  "font": "正文",                   // 槽名，或直接写 {eastAsia, ascii, ...}
  "spacing": { "line": 1.5, "lineRule": "multiple", "beforePt": 0, "afterPt": 0 },
  "kernPt": 1,
  "cjk": { "kinsoku": true, "autoSpaceDE": true, "autoSpaceDN": true,
           "adjustRightInd": true, "snapToGrid": true, "overflowPunct": true,
           "wordWrap": true }
}
```

`cjk` 那组是中文排版开关：`kinsoku` 避头尾（标点不许出现在行首）、
`autoSpaceDE/DN` 中英文和中数字之间自动加空隙、`overflowPunct` 标点悬挂。
中文文档基本全开。

### 字号名表

| 名 | 磅 | 名 | 磅 | 名 | 磅 | 名 | 磅 |
|---|---|---|---|---|---|---|---|
| 初号 | 42 | 小初 | 36 | 一号 | 26 | 小一 | 24 |
| 二号 | 22 | 小二 | 18 | 三号 | 16 | 小三 | 15 |
| 四号 | 14 | 小四 | 12 | 五号 | 10.5 | 小五 | 9 |
| 六号 | 7.5 | 小六 | 6.5 | 七号 | 5.5 | 八号 | 5 |

写别的中文名（比如"小四号"）会报 `unknown 字号`。也可以直接写数字磅值。

---

## tokens.styles —— 命名风格

`styles` 是一张 `styleId → Style` 的表。styleId 是你在 content 里用
`"style": "..."` 引用的名字。

⭐ **有几个 id 是有魔法的**：`Normal`（正文默认）、`Heading1`…`Heading9`
（Word 认它们是标题，导航窗格和目录靠这个）、`Title`、`Quote`。自定义 id
随便起。

一条 Style 的**全部**合法键：

```jsonc
"Heading1": {
  "type": "paragraph",        // paragraph | character | table
  "name": "heading 1",        // Word UI 里显示的名。内置名有魔法含义，别乱改
  "basedOn": "Normal",        // 继承谁（必须是已存在的 styleId）
  "next": "Normal",           // 敲回车后下一段用哪个风格
  "link": "...",              // 段落风格 ↔ 字符风格的配对
  "qFormat": true,            // 在 Word 的风格快速库里露出
  "uiPriority": 9,
  "run":  { ... },            // 字符级
  "para": { ... },            // 段落级
  "extraXml": { "pPr": "...", "rPr": "..." }   // 原样并入的 XML（外来文档透传用）
}
```

### style.run —— 字符级（14 个键）

| 键 | 值 |
|---|---|
| `font` | 字体槽名，或 `{eastAsia, ascii, hAnsi, cs}` |
| `sizePt` | 数字（磅）或字号名 |
| `bold` `italic` | true / false |
| `color` | `"RRGGBB"`，不带 `#` |
| `underline` | `true` / `"single"` / `"double"` / `"dotted"` / `"wave"` … |
| `strike` | true |
| `caps` `smallCaps` | true（全大写 / 小型大写，只对拉丁有意义） |
| `vertAlign` | `"superscript"` / `"subscript"` |
| `em` | 着重号：`"dot"`（中文最常用的点） / `"comma"` / `"circle"` / `"underDot"` |
| `kernPt` | 字距调整起始磅值 |
| `spacingTwip` | 字符间距（twip，可负） |
| `highlight` | 荧光笔色名，如 `"yellow"` |

### style.para —— 段落级（13 个键）

| 键 | 值 |
|---|---|
| `align` | `"left"` / `"center"` / `"right"` / `"both"`（两端对齐，中文正文常用） / `"distribute"`（分散对齐） |
| `outlineLevel` | 0-8。⭐ **这个才是让标题成为"真标题"的东西**，Word 的导航窗格和自动目录只看它 |
| `indent` | `{firstLineChars, firstLineTwip, hangingChars, hangingTwip, leftChars, leftTwip, rightChars, rightTwip}` |
| `spacing` | `{beforePt, afterPt, beforeLines, afterLines, line, lineRule}` |
| `keepNext` | true = 与下段同页（标题必备，否则标题会孤零零留在页尾） |
| `keepLines` | true = 段内不跨页 |
| `pageBreakBefore` | true = 段前分页 |
| `widowControl` | 孤行控制 |
| `contextualSpacing` | true = 同风格相邻段之间不加段间距（列表用） |
| `borders` | `{top/bottom/left/right: {style, sizePt8, color, spacePt}}`，`sizePt8` 单位是 1/8 磅 |
| `shading` | `"RRGGBB"` 底纹 |
| `tabs` | `[{pos: twip, val: "left"/"center"/"right"/"decimal", leader: "dot"}]` |
| `cjk` | 覆盖 `base.cjk` 的同名开关 |

**缩进用 `Chars` 后缀那一组更稳**：`firstLineChars: 200` = 首行缩进 **2 个字**，
字号变了缩进跟着变；写 `firstLineTwip: 480` 则是写死的物理长度，改字号就错位。
（`Chars` 的单位是百分之一字，所以 2 字 = 200。）

**行距的坑（引擎会拦，但先说清楚）**：
```jsonc
"spacing": { "line": 1.5, "lineRule": "multiple" }   // ✅ 1.5 倍行距
"spacing": { "line": 360, "lineRule": "exact" }      // ✅ 固定 18 磅（360 twip 不是磅！这里 line 的单位是磅）
"spacing": { "line": 360, "lineRule": "auto" }       // ❌ auto 不是合法值
```
`lineRule` 只有三个值：`multiple`（`line` 是倍数）、`exact`、`atLeast`
（后两个 `line` 是磅）。写 `auto` 会被拒——它在 CSS 和 OOXML 里都存在，
特别容易顺手打出来，但这个引擎不认。

---

## content —— 正文块

`content` 是块数组，块只有**三种** `t`：

### `{"t": "p"}` 段落

```jsonc
{ "t": "p", "style": "Heading1", "text": "第一章 绪论" }

{ "t": "p", "style": "Normal", "runs": [
    "这段里有",
    { "text": "加粗的字", "bold": true },
    "和",
    { "text": "红色的字", "color": "CC0000" },
    { "br": true },
    "换行之后的内容。第 ", { "fld": "PAGE" }, " 页。"
] }
```

- `text` 和 `runs` 二选一。`runs` 里字符串 = 纯文本 run，对象 = 带格式的 run
- run 对象的键 = 上面 **style.run 那 14 个** + `text` + `br` + `fld`
- `br`: `true` 换行；`"page"` 分页符；`"column"` 分栏符
- `fld`: 域。目前只有 `"PAGE"`（当前页码）和 `"NUMPAGES"`（总页数），
  **写在页脚里**，别手打数字——手打的"1"在第二页还是 1

⭐ **块级直接格式是平铺在块上的，没有 `para` 包层**：

```jsonc
{ "t": "p", "align": "center", "indent": { "firstLineChars": 0 } }   // ✅
{ "t": "p", "para": { "align": "center" } }                          // ❌ 静默无效
```

块上可以直接写 `style.para` 的那 13 个键 + `sizePt`，用来给单独一段开小灶。
写成 `"para": {...}` 不会报错，但**一点效果都没有**——这是最难发现的一类错。

### `{"t": "table"}` 表格

```jsonc
{ "t": "table",
  "widthsTwip": [2000, 4000, 2400],          // 每列宽，长度 = 列数
  "rows": [
    ["表头一", "表头二", "表头三"],
    [{ "text": "带底纹的格", "shading": "F2F2F2" }, "普通格", "普通格"]
  ] }
```

- 单元格是字符串（纯文本）或对象（对象的键 = 一个段落块的键 + `shading`）
- 列宽单位 twip，**总和要等于版心宽度**（A4 默认边距下约 8306 twip），
  否则表格会歪出版心

### `{"t": "pageBreak"}` 分页

```jsonc
{ "t": "pageBreak" }
```

---

## header / footer

两种写法：

```jsonc
"header": "机密 · 内部资料",                 // 字符串 = 一行纯文字
"footer": [                                 // 数组 = 完整控制，元素是段落块
  { "t": "p", "align": "center",
    "runs": [ { "text": "— " }, { "fld": "PAGE" }, { "text": " —" } ] }
]
```

⚠️ 页眉页脚里**不要放表格**，会构建失败。

---

## 引擎当前做不到的（诚实边界）

- ~~自动编号~~ **已支持**（2026-08-18），见下面的 numbering 一节
- **自动目录**：可以用 `fld` 插 TOC 域，但内容要用户在 Word 里按 F9 更新域
  才会生成；我们的渲染预览里它显示的是占位文案
- **图片**：还没接
- **编辑外来 .docx**：还没做。外来文档几乎不用命名样式（全是直排格式），
  重建 styles.xml 对它们不起作用

---

## tokens.numbering —— 自动编号

```jsonc
"numbering": {
  "条款": "公文条款",        // 用内置梯队（推荐）
  "要点": "圈码",
  "自定义": { "levels": [    // 或者自己写
    { "fmt": "ideographTraditional", "text": "%1、", "firstLine": 2, "suff": "nothing" }
  ] }
}
```

段落上引用（**按名字，不按数字** —— numId 是 OOXML 的实现细节，引擎替你算）：

```jsonc
{ "t": "p", "style": "Normal", "list": { "name": "条款", "ilvl": 0 }, "text": "总体要求" }
{ "t": "p", "style": "Normal", "list": "要点", "text": "单层可以简写" }
```

⚠️ 引用一个没定义过的名字会**直接报错**（以前会产出一个指向空处的 numId，Word
打开可能报文档损坏）。

### 四个内置梯队

| 名字 | 形状 | 缩进形态 |
|---|---|---|
| `公文条款` | 一、→（一）→ 1. →（1） | 首行缩进两字、文字紧跟编号、**折行顶格** |
| `数字条款` | 1. → 1.1 → 1.1.1 | **悬挂缩进**，折行对齐到文字起点 |
| `圈码` | ①②③ | 悬挂一字，编号后无间隔 |
| `项目符号` | ●→○→▪ | 悬挂 |

⭐ **两种缩进形态的差别决定折行去哪儿**，这不是审美问题：中文公文的层级标题
折行要**回到左边距**（顶格），技术文档的 `1.1.1` 折行要**对齐到文字起点**（整块
看起来是对齐的）。选错了整篇文档的观感就不对。

### 自己写一级的全部键

| 键 | 值 |
|---|---|
| `fmt` | 编号格式，见下表 |
| `text` | 编号长什么样。`%N` 是第 N 级的当前值 —— `"%1、"` 出「一、」，`"%1.%2"` 出「1.1」。**非 bullet 的必须含 `%N`**，否则编号值根本不出现（引擎会拦） |
| `indent` | 左缩进，单位**字**（不是磅不是英寸） |
| `hanging` | 悬挂量，单位字 |
| `firstLine` | 首行缩进，单位字。**跟 `hanging` 二选一** —— 给了它就是首行缩进形态 |
| `indentTwip` / `hangingTwip` / `firstLineTwip` | 同上但直接给 twip（要精确控制时用） |
| `start` | 起始值，默认 1 |
| `align` | `left`（默认）/ `center` / `right` |
| `suff` | 编号和文字之间放什么：`tab`（默认）/ `space` / `nothing`。⭐ **中文编号自带全角标点（一、/（一）/①），一律用 `nothing`** —— 默认的 tab 会跳到下一个制表位，「一、」后面会空出一大截 |

### 支持的 fmt

`decimal` 1 2 3 · `chineseCounting` 一 二 三 · `chineseCountingThousand` ·
`ideographDigital` 一 二 三 · `ideographTraditional` 甲 乙 丙 ·
`decimalEnclosedCircle` ①②③ · `decimalEnclosedParen` ⑴⑵⑶ ·
`decimalEnclosedFullstop` ⒈⒉⒊ · `lowerLetter` / `upperLetter` /
`lowerRoman` / `upperRoman` · `bullet` · `none`

列外的写上去会被拒 —— ISO 29500 里有六十多个格式，全放开只会让人写出 Word
显示不出来的东西。

---

## 常见错法对照

| 写了什么 | 会怎样 | 正确写法 |
|---|---|---|
| `"para": { "border": {...} }` | `unknown key border` | 键是**复数** `borders` |
| `"run": { "font": "宋体" }` | `no such font slot '宋体'` | `font` 填**槽名**；槽要先在 `fonts` 里注册 |
| `"styles": { "X": { "numbering": ... } }` | `unknown key numbering` | `numbering` 是**顶层**键，风格里用的是 `para.list` |
| 块上写 `"para": { "align": ... }` | **不报错，也不生效** | 平铺：`{ "t": "p", "align": ... }` |
| `"lineRule": "auto"` | 被拒 | `multiple` / `exact` / `atLeast` |
| `"color": "#CC0000"` | 颜色不对 | 不带 `#`：`"CC0000"` |
| `"sizePt": "小四号"` | `unknown 字号` | `"小四"` |

---

## 改完怎么验

`build_docx` 成功 ≠ 排版对。**必须 `screenshot` 看一眼渲出来的页图**——
它是服务端用 LibreOffice 真渲的。两条已知失真：中文是替身字体（判版式可以、
判具体字形不行），TOC 域显示占位文案（PAGE 域是正常求值的，页脚看到几就是几）。
