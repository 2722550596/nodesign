---
name: deskskill-engine-mini
version: 0.1.0
description: NoDesign deck 设计方法论 — 风格锚范式（先钉一个明确存在的风格锚，全部生成和迭代以锚为基准），附反默认套路清单与字体链硬约束。当用户要做 deck / 演示 / 幻灯片 / PPT / 海报 / 长图 / 单页报告 / pitch / lecture 等任何多页或单页视觉化设计任务时使用。
---

# deskskill-engine-mini — 风格锚设计法

> 本文 = 设计方法论。工具用法 / 路径地图 / DirectEdit 协议在 prelude；
> generate_image cookbook / tweaks 语法 / vision-checker 模板由 PreToolUse hook 首调时注入。
>
> ⚠️ 比例硬规则属协议层，见 prelude § 第一动作硬规则（4 档 aspect，锁死后切换等于整套重排）。

---

## 核心范式：先钉锚，再展开，迭代不漂移

一个 deck 做得好不好，第一因素不是排版技巧，是**有没有一个明确存在的风格**。

**风格锚**是一句能说出口、别人能凭它认出这个 deck 的风格定义。例：

- ✅ "无印良品式克制：米白底、单色暖灰、宋体大字、零动效、每页一句话"
- ✅ "Bloomberg 终端感：近黑底、数据绿、等宽字体、密集小字网格、图表即主角"
- ✅ "王家卫暖调：2046 金绿、大面积暗部、衬线中文、慢节奏 fade"
- ❌ "现代简约大气"（雾，锚不住任何判断）
- ❌ "科技感"（AI 默认审美的入口，做出来千篇一律）

锚一旦钉下，它就是所有判断的基准：每一页是锚的一次表达，每一次修改先问是否动锚。
没有锚的 deck 会向 AI 默认审美滑落（暗背景大标题小字说明、等高卡片、渐变 wash），
换个主题看起来一模一样。锚就是抵抗这种均值回归的东西。

你的设计判断力是可信的。本文不给你流程脚本，给你的是：钉锚的手段、锚的落档方式、
迭代时守锚的规则，和一份反默认清单。轮次、话术、每页检查表，由你自己判断。

---

## 一、钉锚（写第一行 HTML 之前）

### 锚的组成

一个完整的锚包含五件事，全部是**具体取值**，不是形容词：

| 组成 | 具体到什么程度 | 例 |
|---|---|---|
| 参照物 | 一张真图 / 一个品牌 / 一个隐喻 | 无印良品官网 / 用户上传的海报 / "伪论文实验记录" |
| Palette | 色号 | `--bg:#f5f2ea; --ink:#2d2418; --accent:#c45c3f` |
| 字体配对 | family 名 + 用在哪 | 标题 Songti SC / 正文 PingFang / 数据 JetBrains Mono |
| 版式语言 | 这个锚下的页长什么样 | 大留白单句页 / 密集网格 / 满幅图 + 角落小字 |
| 动效预算 | 静态 / 微动效 / entry / 戏剧化 | 严肃商务默认静态 |

### 钉锚的手段（按效率排）

1. **搜真图**：brief 里有品牌 / 产品 / 模仿对象 / 风格名，先 `web_search { include_images: true }`
   拿真图当锚，再让用户纠偏。"我搜到 X 的主色是 cobalt blue + Lyon Display，保留还是换？"
   比"你想要什么颜色"高效一个量级。
2. **生样张**：brief 有主体或隐喻就先 `generate_image` 出 1-2 张候选当对齐起点。
   图本身就是对齐工具，用户看图给方向比文字往返快得多。cover 这类会被跨页引用的
   种子图，选错一路全漂，值得让用户亲自挑。
3. **AskUserQuestion + preview**：方向收敛到 2-4 个候选时用，每个选项配 240×140
   HTML preview 或真图，让用户看着选（语法见 prelude）。
4. **直接问**：只问搜不到、看不出的主观偏好。能自答的（搜索 / Read assets /
   spec.json / brief 里其实说了）不要浪费用户回合。

问多少轮你自己判断。原则只有一条：**锚没钉住之前不动工**。用户说"你看着办"
通常是描述能力有限而不是真没偏好，给 1-2 个具体方向让 ta 挑，比硬猜准。
用户明说赶时间就用模板兜底 palette 起步，但锚的一句话版本仍要在 chat 里说出来。

### Deck 意图（判断标准跟着走）

锚管"长什么样"，意图管"要观众发生什么变化"。一句话判断，别问卷：

| 意图 | 结构脊柱 | 一票否决项 |
|---|---|---|
| decision 决策汇报 | 要决什么 → 洞察 → 方案 → 证据 → 风险 → 下一步 | 标题写名词不写结论；风险被藏起来 |
| funding 融资路演 | why now → why this → why us → 请求 | 把 TAM 当增长证据；护城河空话 |
| sales 销售提案 | 客户的损失 → 我们怎么解 → ROI → 风险控制 | 按功能清单组织而不是按客户疑虑 |
| launch 产品发布 | 旧痛苦 → 新答案 → 登场 → 能力展开 → 记忆点 | 登场页只有 logo 大字没有"哇"的瞬间 |
| emotion 情绪叙事 | 进入 → 加深 → 冲突 → 高潮 → 余韵 | 装饰盖过叙事；百科式解说文案 |
| knowledge 教学 | 误区 → 正确模型 → 例子 → 框架收束 | 直接堆知识跳过误区 |
| academic 学术答辩 | 问题 → 方法 → 实验 → 消融 → 贡献 | 工作量堆叠代替贡献凝练；无消融 |
| data 数据洞察 | 结论先行 → 证据 → 拆解 → 建议 | 堆图不堆判断；无反直觉点 |
| ceremony 仪式活动 | 场域 → 共同记忆 → 高潮 → 收束 | 华丽背景堆叠代替仪式节奏 |

意图判错的代价大（汇报做成氛围片），brief 模糊时这一项值得专门确认一句。

### 锚的落档（必做，一次）

锚钉住后立即落档，这是跨 turn / 跨 session 不漂移的物质基础：

- `<style id="design-tokens">` 的 `:root {}` 整组覆盖（palette + 字号 var）
- `record_decision({ topic: 'style-anchor', decision: '<锚的一句话版本>', rationale })`
- plan mode 下再落 `design-plan.md.meta`（tone / palette / motion_budget 字段）
- 品牌类项目顺手更新 `agent-memory/brand/memory.md`

**锚测试**：落档前自问，锚能不能用一句话说出来？这句话给另一个 designer，
ta 做出来的东西跟你像不像？说不出或不像，锚还没钉住。

---

## 二、展开（生成 = 锚的表达）

### 起手式

`cp canvas.template.html canvas.html` 起步（模板 667 行全家桶 boilerplate，
Write 复述必漏字符），然后只 Edit 差异：`<title>`、design-tokens `:root` 整组（锚的
palette）、wrap `data-deck-aspect`、按大纲铺空骨架 section（每页唯一 `data-anchor`）。
之后逐页 Edit 填充，一次一页。关键页（cover / 数据页 / 收尾）写完立即
`screenshot_canvas` 自己看一眼。标记规约（data-page / data-layout-role /
data-anchor / data-react-mount）见 prelude。

模板预置的暖灰白 palette 是**信息缺口时的兜底，不是设计起点**，锚一旦存在就整组覆盖。

### 每页的问题只有一个

写每页前问："**这一页，用锚的语言，怎么说这件事？**"

- 说什么：这页的一个核心句（观点 / 情绪 / 转折）。盖住其他文字只看它，讲不清就砍。
- 谁是主角：一个视觉主角（大字 / 图 / 图表 / 黑场）。多主角互相消解。
- 跟上一页什么关系：满与空、图与字、快与慢，相邻页拉开节奏，否则整个 deck 像 PDF。
- 装饰在干什么：说不出对应哪个状态变化的装饰，删。

这四问是判断的方向，不是逐页打卡的表格。页与页的区别应该来自**内容角色不同**
（cover / 论点页 / 证据页 / 转场页），而不是风格漂移。写到第 8 页时的用色和
字体决策，应该跟第 1 页出自同一个锚。中途发现锚不对，回到第三节的动锚流程，
不要一页一页悄悄漂过去。

### 技术选型（一段话版）

简单页纯静态 HTML + Tailwind（DirectEdit 可直接改）；数据图表 / 流程图 / 公式 /
代码 / 轮播 / 复杂动画才 React mount + 对应库（importmap 已预置 21 库，速查表见
prelude）。动效跟着锚的动效预算走：严肃场景默认静态，情绪 / 发布 / 仪式场景才放开
gsap / framer-motion。数据用 chart 库，流程架构用 mermaid，不混用。3D 用之前想清楚，
多数情况一张 generate_image 更轻。layout-role 骨架参考按需 Read
`<plugin>/patterns/<role>.md`（意图级参考，不是模板）。

### 字体 4 段链（硬约束，不可省）

任何 `font-family` 必须 4 段：latin family + 苹果 CJK + Noto CJK + generic。

| 风格 | chain |
|---|---|
| sans | `'Inter', 'PingFang SC', 'Noto Sans SC', system-ui, sans-serif` |
| serif | `'Playfair Display', 'Songti SC', 'Noto Serif SC', serif` |
| mono | `'JetBrains Mono', monospace`（mono 极少含中文，不配 CJK） |

原因：苹果 CJK 命中 preview / 导出端的系统字体（字体表达力核心）；Noto 是用户
Windows / Linux 下载后双击打开的兜底，用了就必须在 Google Fonts `<link>` 里 import
对应 family（模板默认已 import Noto Sans/Serif SC）；缺任何一段，三处渲染就不一致。
装饰中文字体（古风 / 手写）插在 latin 之后苹果 CJK 之前，同样要 import。

### 反默认清单（视觉层的均值回归，做完一页对照一遍）

| 默认套路 | 替代方向 |
|---|---|
| 等高卡片网格（3-4 张同尺寸平铺） | 打破均质：左大右小 / 单 hero + 细行注脚 / Z 型错位 |
| emoji 当视觉主角（👁️🧠💻 放 ID 级位置） | hero 位用大字 / 真图 / 数据 / 形状；emoji 只进辅料句 |
| 浅色 wash 渐变 + 浮动圆点 | 纯色 + 一个有意图的元素，或纯白纯黑当 visual silence |
| 彩色 chip 当 section label（每页顶贴 pill） | section 转场独占一页（大编号 + 一句概括） |
| 相邻页同版式复用（5 页全是 chip+标题+卡片） | 主动选反维度：满↔空 / 图↔字 / 静↔动 |

命中 2 条以上就回去改。这 5 条不挑主题不挑意图，是 AI 视觉层最常见的滑落方向；
"内容写对了"不等于"视觉做对了"。锚存在的意义之一就是让这些默认无处可套。

---

## 三、迭代（修改先过锚）

修改请求（评论 / 微调 / Tweaks Apply / DirectEdit pending / 换图改字）进来，先分类：

**锚内调整** —— 字号、间距、单页布局、换图、改文案。直接做，做完仍在锚里。
动手前回一眼故事：优先 Read `design-plan.md` 对应页的 c_decisions，退而
`spec.json` decisions[]，都没有就直接做并在 chat 里说清你的假设。

**动锚的修改** —— 换主色、换字体气质、换整体调性（"改冷酷一点"这种）。
这类修改会让已生成的页跟新方向脱节，正确做法：

1. 在 chat 里点明这是动锚："现在的锚是 X，你要的方向是 Y，我更新锚并把已有页面
   一起对齐过去？"（用户就改一处的明确指令除外）
2. 用户确认后**更新锚的落档**（design-tokens :root + record_decision 新条目）
3. 全局传播：所有引用锚的页一起改，不留一半旧一半新

分不清是哪类时按动锚处理，多问一句的成本远低于做完发现方向漂了。

**Tweaks**：`expose_tweaks` 暴露的就是锚的可调维度（主色 / hero 字号 / 密度 /
字体候选，5-8 个），deck 第一版成形后调一次。用户 Apply 等于在锚内微调，
Edit :root 落实并 replace 重 expose。

---

## 四、自检与收尾

- **整 deck 第一版写完**：先 `screenshot_canvas` 自己扫明显错位，然后默认派一次
  `vision-checker`（独立视角逐页对照 plan，能看出你自己看不出的跨页节奏和 palette
  一致性问题）。critique 是给你的，挑最影响第一印象的修，别原文转给用户。
  修完到再派的循环最多 2 次，别陷入 self-criticism loop。
- **改错字 / 单页微调**：自己 screenshot 看一眼就够，不派。
- **骨架先行模式**：派 vision-checker 前先 grep `data-skeleton=` 残留（漏填的页）。
- **收尾消息**（100-200 字）：做了什么、锚是什么（或有没有动）、用户接下来能做什么
  （双击改字 / Tweaks / 让我再自检）。有意义的决策节点随手 `record_decision`
  （5-8 条/session 的密度回看时最好用）；用户说"差不多 / 交付"时主动 `export_handoff`。
- 心里没底就直说"我看着差点意思但说不清，想听你的反馈"，比假装 OK 有价值。

### 长期记忆

| 文件 | 写什么 |
|---|---|
| `agent-memory/memory.md` | 通用偏好（"用户喜欢中文衬线"、"不要 emoji"） |
| `agent-memory/brand/memory.md` | 品牌档案（color / type / voice），BrandCard 直接读 |
| `spec.json decisions[]` | 当前 deck 的锚 + 关键决策（不写实现细节） |

### Plan mode

多页 deck 从零 / brand 重设 / 用户开了"深度对齐" toggle 时走
`mcp__nodesign__request_plan_mode`。进入后 SDK 自动注入 plan-instructions（含
design-plan.md schema），跟着那份走。锚在 plan mode 里对应 meta 段，逐页
brainstorm 就是锚在每页的展开预演。
