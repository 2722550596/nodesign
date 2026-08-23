**简体中文** | [English](https://github.com/Xiaokebuyu/Nodesign/blob/main/README.en.md)

# NoDesign

一张无限画布，一个始终在场的 Agent。

告诉它你想做什么，它会在画布上创建网站、演示稿、文档、图片和视频。所有产物都会保存为真实文件，可以继续编辑、批注、下载和发布。

![demo](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo.gif)

## 立即体验

```bash
npx @xiaobuyu/nodesign
```

需要 Node.js 20+，并配置至少一种模型接入方式：

- Claude 订阅或 Anthropic API
- OpenAI、DeepSeek、智谱、通义、OpenRouter
- Ollama 或其他兼容 OpenAI API 格式的模型服务

NoDesign 本身不收取订阅费，也不对模型调用加价。项目文件和配置保存在本地。使用云端模型时，完成任务所需的上下文会发送给你配置的模型服务。使用本地模型（如 Ollama）时，所有数据都留在你的电脑上。

暂时不想安装，也可以通过在线实例体验基础能力：[nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade)

在线体验版提供免费模型和每日额度，部分本地能力暂未开放。

## 它能帮你做什么

三个典型场景：

- **做一个作品集页面**：把参考图和文字素材放到画布上，告诉 Agent 你要什么风格，检查桌面、平板和手机尺寸下的效果，配置后一键发布到公网。
- **做一份演示稿**：把照片、文字和参考风格放到画布上，Agent 生成分页幻灯，你直接在上面批注修改，导出 PDF 或 PPTX。
- **做一个内容项目**：网站、图片、视频和文档放在同一张画布上，由同一个 Agent 连续处理。Agent 可以在不同产物之间继续取材和修改。

### 产物类型

| 产物 | 格式 | 能做什么 |
|---|---|---|
| 演示稿（幻灯、长图、海报） | `.html` | 16:9、9:16、4:3 等比例分页，导出 HTML、PDF、PPTX |
| 站点（作品集、落地页、小应用） | 带 `index.html` 的文件夹 | 桌面、平板和手机尺寸预览，整站 zip 导出，配置 Cloudflare 后可一键发布 |
| Word 文档 | `.docx` | 直接生成标准 OOXML，不是把 HTML 包装成 Word 文件。页图预览、翻页、下载原件 |
| 图片 | 常见图片格式 | 生图、抠图 |
| 视频 | 常见视频格式 | 视频导入、预览与转码 |

![说一句话生成图片，再抠掉背景，得到透明底 PNG](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-image.gif)

![Agent 生成 Word 文档，在画布上直接看排版](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-docx.gif)

这些文件不依赖 NoDesign 的私有格式，可以使用其他工具继续编辑和下载。

使用 NoDesign 完成的实际项目：一个乐队的研究站、一份 15 页的西藏攻略幻灯配站点、一套像素风服务器宣传页、一份改了六版的简历 .docx。也有实验性项目，比如一个在页面上选择剧情、在聊天里生成内容的互动视觉小说。已发布的一个站点：[spica-mix.share.xiaobuyu.trade](https://spica-mix.share.xiaobuyu.trade)。

## 它为什么不只是另一个 AI 聊天框

### 画布就是工作区

画布上的卡片对应真实文件，文件夹对应真实目录。移动、编辑和整理卡片，也会同步改变磁盘上的内容。

![打开文件夹、把卡片拖进文件夹、在两张卡之间建立关系](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-desktop.gif)

### Agent 始终在场

Agent 会出现在它正在处理的内容旁边。你可以看到它正在编辑哪个文件，以及内容如何逐步生成，而不是只能等待聊天框返回最终结果。

### 画布也是黑板

Agent 不只是把做完的产物放上画布，也把想法放上去。它会画草图、写板书、在相关的东西之间拉线，说明自己打算怎么做，或者把一件复杂的事情拆开摆出来。

![拆《雷雨》的人物关系：八个人分成两家，关系线标出谁和谁是什么，主要人物的肖像当场生成后连回名字](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-blackboard.gif)

板书是真文件，保存在项目的 `notes/板书/` 目录下。草图节点、连线和板书都可以双击直接改，改完 Agent 接着用改过的版本。

![双击 Agent 写的板书，在画布上原地改字](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-chalk.gif)

### 你的操作会成为下一轮上下文

你可以直接修改文字、圈选区域、拖动元素，或者在不同产物之间建立「参考」「批注」「接着做」等关系。这些操作会被整理为后续任务的上下文。

![圈选封面的一块区域写一句话，Agent 取到后直接修改](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-roundtrip.gif)

### Agent 能检查自己的结果

它可以获取不同屏幕尺寸下的页面截图、样式计算结果、控制台错误、字体加载状态和动效帧，并根据检查结果继续修改。做完之后它自己截图核对，改了两轮你还是不满意，它会请一个只读的评审子代理逐页检查。

![站点在桌面、平板、手机尺寸下的预览](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-viewport.gif)

### 记忆是可见、可编辑的

项目决策、风格记录和个人偏好不会只藏在对话历史中。它们会以可见内容保留在工作区，也可以沉淀成可复用的 Skill。

## 本地版与线上版

| | 本地版 `npx @xiaobuyu/nodesign` | 线上版 [nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade) |
|---|---|---|
| 模型 | 你自己配置的（Claude 订阅、API Key 或兼容 OpenAI API 格式的服务） | 免费模型，每日额度 |
| 数据 | 保存在 `~/.nodesign/`，服务仅监听 `127.0.0.1` | 服务端存储，按用户隔离 |
| 账号 | 无需账号，打开即可使用 | 公开注册 |
| 能力 | 全部。截图、Word、抠图、生图等按本机环境自动探测。站点发布需要配置 Cloudflare Pages | 截图、搜索、生图开放。站点发布和订阅模型暂不对外开放 |
| 费用 | 无订阅，无抽成。模型费用由你配置的服务商收取 | 免费 |

本地版是主力。线上版用来在不安装的情况下快速体验。

## 配置

启动后点右上角齿轮进入设置页，分为四个区域：

- **模型**：两张并列的卡片。「Claude 官方」填 API Key 或通过 `nodesign login` 登录 Claude 订阅。「自定义接入」从服务商预设里选一个（DeepSeek、OpenAI、智谱、通义、OpenRouter、Ollama 等），填入接口地址和密钥。每个模型配置都可以运行连接测试，实际验证普通对话、流式输出、工具调用、图片理解和计数能力。没有配置任何模型时，模型选择器是空的。
- **本机能力**：启动时自动探测 git、Chromium、LibreOffice、poppler、ffmpeg、rembg、生图、搜索、发布能力。缺少的会标出安装方法，对应工具会明确显示为不可用，并附上安装说明。
- **其他设置**：搜索（四家任选一）、生图通道、Cloudflare 发布、沙盒与权限模式。
- **状态**：数据目录、配置文件路径、重启。

配置文件存放在 `~/.nodesign/.env`（密钥）和 `~/.nodesign/config.json`（模型插槽），也可以直接编辑。

## 安全与隐私

每个项目使用独立的工作区目录。本地数据默认保存在 `~/.nodesign/`，服务仅监听 `127.0.0.1`。

在支持的平台上，可以启用系统级命令沙盒：

- Linux：bubblewrap
- macOS：sandbox-exec
- Windows：当前暂不提供系统级命令沙盒

还可以启用自动权限检查，对文件上传、外部请求和其他敏感操作进行额外判断。

本地版默认不启用命令沙盒和自动权限检查。请根据使用场景在设置中开启。在 Windows 上，建议仅打开你信任的项目，并在执行涉及工作区外文件、安装软件或上传内容的操作前确认 Agent 的计划。

## 项目状态

个人项目，2026 年 4 月底起步，目前仍在快速迭代。本地发行版当前是 `0.0.4`，核心功能已在内测中稳定使用。

### 功能

| 能力 | 当前状态 |
|---|---|
| 画布与项目管理 | 内测主版本运行中 |
| 网站生成、预览与发布 | 稳定 |
| 演示稿生成与导出 | 稳定 |
| Word 文档 | 可用。预览分页与 Microsoft Word 可能存在偏差 |
| 图片与视频工具 | 可用。具体能力取决于本机依赖和服务配置 |
| 互动演出模式 | 实验中，尚未完整进入公开版本 |

### 平台兼容性

| 平台 | 状态 |
|---|---|
| Linux | 生产环境运行中 |
| Windows | 已完成真机安装与运行验证 |
| macOS | 有对应代码分支，尚未在真机上验证 |
| 移动端 | 可以浏览和对话，整理和编辑建议使用电脑 |

## 技术架构

- **前端**：React + Vite。无限画布的相机、命中检测、关系排布和产物能力系统为自研实现（web/src/lib，45 个纯函数模块，配有单测）。
- **服务端**：Node.js ESM。Agent 会话以项目工作区作为执行目录，通过 56 个进程内工具操作文件、浏览器和不同类型的产物。
- **会话同步**：服务端维护会话状态，支持流式输出、断线恢复和多标签页同步。
- **模型兼容**：原生支持 Claude，并通过格式转换接入兼容 OpenAI API 的模型服务。无法匹配上游时直接返回错误，避免请求被发送到错误的模型服务。
- **产物系统**：网站、演示稿和 Word 文档通过统一的注册机制接入预览、导出和发布流程。新增产物类型时，通过同一注册入口接入相关能力。

## 开发

```bash
npm install && cd web && npm install && cd ..
npm run dev                 # 服务端，读 .env
cd web && npm run dev       # 前端
npm test                    # server 测试 + web 测试
```

> 注意：完整运行需要配置模型接入（Claude 订阅或 API Key）以及部分本地工具依赖。设置页会列出缺少的依赖和安装方法。

项目以 Vitest 测试套件作为发布前检查，server 和 web 合计 1021 项用例，覆盖前后端契约、模块边界、权限能力表和关键用户文案。部分约束以静态测试固化，避免仅依赖注释和人工约定。例如：

- 前后端双份能力表逐项对账
- 权限判断必须通过能力表查询
- 用户可见文案的措辞检查
- 源文件行数棘轮

前端部署使用 `web/scripts/deploy.sh`（新分片加入、旧分片不删、`index.html` 原子替换）。服务端改动需要重启进程。

## 许可

AGPL-3.0。可以使用，可以修改，可以自行部署。对外提供服务时，修改需要一并开源。
