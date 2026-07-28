# 站点技术参考

首次写站点 html 时注入一次。方法论在 `site-craft` skill，这里只讲平台事实和会踩的坑。

## 目录

```
tasks/<任务名>/
  index.html        入口（**这个文件名决定了系统把这个任务当站点**）
  about.html        子页，同目录直接加
  style.css         全站共用一份
  posts/            子目录可以有，扫描深度 3 层
```

起手：`cp site.template.html tasks/<任务名>/index.html` +
`cp style.template.css tasks/<任务名>/style.css`，然后改。

## 路径铁律

预览和导出都走 `…/artifact-file/tasks/<任务>/…` 这个前缀，URL 结构跟磁盘结构 1:1。
所以：

- 站内链接**只用相对路径**：`about.html` / `posts/x.html` ✓
- **绝不用根路径**：`/about.html` ✗ —— 会跳出前缀直接 404
- 项目素材写 `../../assets/generated/x.png`（相对当前文件的位置）。导出时系统按
  每个文件自己的深度归一成包内的 `assets/`，你不用管
- 外链正常写 `https://…`

## 系统怎么认这是站点

任务目录里有 `index.html` = 站点，有 `canvas.html` = deck。**不用声明**，写出来就认。
认定之后：

- 桌面上是**一个**站点物件（不是每个 html 一张卡），双击开响应式预览窗
- 导出菜单换成整站 zip / 单页自包含 HTML / 工程交付包（PDF/PPTX 不出现，站点没有分页）
- 不会被注入分页 fit script（那是 deck 的整屏翻页脚本，注进站点会把长页变成翻页器）
- `canvas-validate` 的 anchor / layout-role 校验不跑（那是 deck 规约）

一个任务只做一种。想在同一个项目里既做 deck 又做站点，开两个任务。

## 感知层怎么用

| 想知道 | 用 |
|---|---|
| 这站有哪些页、彼此怎么连、有没有断链 | `list_pages`（站点下返回站点结构 + 断链清单） |
| 某一页长什么样 | `screenshot_canvas { path, device }` |
| 移动端断点有没有生效 | `screenshot_canvas { device: 'mobile' }`（真的按 390px 渲染） |
| 某个元素的实际盒子 / 计算样式 | `query_elements` / `get_computed_styles`（站点按 1440 宽量） |
| 页面正文 | 直接 `Read`（站点页面通常不大）；`read_page` 的页码语义不适用 |

`screenshot_canvas` 站点下默认整页（fullPage），因为网页本来就是长的，只截首屏
等于没看过下面那些。

## 常坑

- **忘了 `<meta name="viewport">`**：移动端会按 980px 虚拟视口渲染，你的媒体查询
  看着"没生效"，其实是视口不对。模板里已经有，别删
- **字体链少了 CJK 那段**：`'Inter', sans-serif` 换台机器中文就掉到系统默认字体。
  每段 latin family 后面必须跟 `'PingFang SC', 'Noto Sans SC'`
- **改了 style.css 预览没变**：不会。html/css/js 走 `no-cache`，写完即时刷新
- **半角标点**：中文正文里的 `,` `:` 很扎眼，用全角 `，` `：`
- **别引框架 / 构建步骤**：沙箱禁 npm install，而且用户要的是能自己改一句话的站
