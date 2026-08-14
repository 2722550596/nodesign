# NoDesign

面向独立创作者的 agent 创作工作台。一张无限画布就是你的桌面，说一句想做什么，
agent 在真实文件上做出网站、演示稿、图像和视频，过程实时演在画布上；你直接在
产物上改字、圈选、留评论、拖拽整理，agent 接着你的动作继续做。

线上实例（内测，邀请制）：`nodesign.xiaobuyu.trade`

## 它长什么样

- **画布即桌面**：项目就是一张空间画布，画布上的一切与磁盘一一对应。文件夹是
  真目录，卡片 id 就是文件路径，拖一张卡进文件夹等于真的 `mv`。
- **产物即文件**：形态由文件证据认定，不用声明。写出 `<名字>.html` 是一份
  deck；建一个带 `index.html` 的文件夹是一个站点，配响应式取景的显示器窗；
  普通文件各自成卡，图片、视频、Office 文档、Markdown 都读得开。
- **agent 是在场的**：一枚铅笔定格风格的 Claude 星芒住在画布上。干活时贴着
  它正在写的那张卡，代码直播框跟在身边；空闲时停在你的视野里，写一句刚才
  干了什么。点它可以直接搭话。
- **关系是一等公民**：六类关系线（改自、批注、接着、取材、对照、自定义
  label）。你画的线 agent 读得到，agent 也会在收尾时主动把产物之间的关系画
  出来；HTML 里真实引用的素材由服务端自动对账成取材边。版面排布按关系走：
  相关的凑近、对照的成行、现役主角放大。

## agent 能做什么

| 能力 | 说明 |
|---|---|
| 建站 / 做 deck | 手写或构建型站点（Astro、11ty 均可，产物根自动认定）；deck 固定比例分页 |
| 看得见 | 截图自检（回传 console 错误与加载失败资源）、DOM 查询、真机移动端取景 |
| 画布语言 | `read_board` 看座次、`arrange_on_board` 语义摆位、`create_on_board` 手写便签、`organize_board` 归纳收纳、`relate_on_board` 画关系线 |
| 图像 | `generate_image` 生图、`remove_background` 抠图；可接自部署 GPU 产线（多模型生图、文生视频，按账号开通） |
| 发布 | `publish_site` 一键发布到四级子域名（Cloudflare Pages）；下线即回收 |
| 导出 | PDF / PPTX / 整站 zip / 工程交付包，浏览器直接下载 |
| 记忆 | 项目级风格档案与用户偏好档，跨会话不忘；共享便利贴层与决策记录 |

用户侧的直接操作全部会回到 agent 手里：双击改字写回源文件，元素评论与圈选
截图进 pending buffer 下一轮自动带上，拖拽移动、样式调整、删除都以结构化意图
落地。

## 架构

```
web/     React + Vite 前端。无限画布为自研：相机、命中、形态能力表、关系
         排布、在场归约全部是带单测的纯函数（web/src/lib，30+ 模块）。
server/  Node ESM 服务端。Claude Agent SDK 驱动 agent 会话（每会话独立
         cwd 指向项目工作区）；in-process MCP 提供 31 件业务工具；hooks
         做注入与守卫；WS 采用快照加尾随协议，断线重连不丢流。
```

几个关键设计：

- **形态注册表**（`server/lib/kinds/`）：一种产物形态一个条目，寻址、预览、
  导出、发布都从注册表读。加新形态不改散落的 if。
- **单一真相源**：会话指针在服务端，多标签页不分叉；搬家语义一份实现，用户
  拖拽与 agent 工具共用；改名是一等动词，三层传播（画布身份、关系线端点、
  转发表）保证 agent 背着画布 `mv` 之后版面不散。
- **事件三管线**：一条 WS 进来分流为舞台旁路（画布演出）、聊天流折叠、控制
  帧。分流名单与过期判据抽成纯函数并有钉子测试。
- **多用户**：邀请码注册、按用户隔离、用量计费闸门、内容外审档位。

## 开发

```bash
npm install && cd web && npm install && cd ..

# 服务端（读 .env；需要 Claude 订阅登录态或 API key）
npm run dev

# 前端
cd web && npm run dev
```

测试与守门：

```bash
npm test               # server 单测 + web 单测（含 lint 型测试）
npm run test:server    # 仅服务端
node web/src/components/canvas/_hook-order-check.mjs   # TDZ 依赖顺序体检
```

lint 型测试是这个仓库的护栏（没有 CI，vitest 就是部署链的闸门）：

- `loc-ratchet.lint`：源文件不超过 600 行，存量超标文件按现状冻结上限，只降不升
- `legacy-shape.lint`：旧任务模型的路径形状不许回到代码里
- `path-compose.lint`：路径拼接必须走统一入口
- parity 系列：前端消费的事件形状必须在服务端源码里逐字存在，reducer 消费的
  事件必须在转发名单里

前端上线用 `web/scripts/deploy.sh`：构建到旁路目录后原子换入，旧分片保留，
开着的页面不断链。服务端改动记得重启进程，Node 不热重载。

真渲染验证有两条通道：`web/scripts/inspect.mjs`（拦截 API 喂固定数据，纯 UI
回归）与 `web/scripts/shot-live.mjs`（登录真服务端截图加探针，查真问题用）。

## 现状

个人项目，内测运行中。近期完成画布与 agent 交互的整体重做：扁平桌面模型、
连线范式、铅笔精灵、agent 摆位与归纳工具、根站治理。方向与记录见提交历史。
