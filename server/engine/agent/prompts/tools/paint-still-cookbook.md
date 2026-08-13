# paint_still — 本地生图手册（08-08 实测配方 + BFL 官方提示词实践）

## 选型

| 模型 | 提示词语言 | 稳态速度 | 许可 | 用在哪 |
|---|---|---|---|---|
| noobai | danbooru 标签 | ~20s | 商用可 | 动漫角色/关键帧主力，tag 级控制最强 |
| anima | 自然语言英文 | ~20s | 非商用 | 氛围感插画 |
| krea2 | 自然语言 | ~10s | 个人免费 | 写实/氛围/审美向画面，反 AI 油光脸 |

⚠️ 换模型后的第一张要付一次权重装载（krea2 约 1 分钟，小模型十几秒）。
**批量时按模型分组排序**（同模型的 stills 排一起），别交错着切。

## noobai 提示词（danbooru 标签流）

逗号分隔标签，不写自然语言句子。质量前缀词系统自动加，别重复写。
顺序习惯：主体数量 → 角色外观 → 服装 → 动作表情 → 场景 → 构图镜头 → 光。
`1girl, silver hair, long hair, witch hat, black robe, riding broom, flying,
cloud sea, sunrise, wide shot, from below, cinematic lighting, depth of field`

## krea2 提示词（自然语言审美向）

- **骨架：Subject + Action + Style + Context** 通用（主体→动作→风格→环境氛围）。
- **长度**：30-80 词生产甜区；形容词堆砌是噪音，每句话都要背视觉信息。
- **审美词很吃**：光线（golden hour / soft window light）、介质（35mm film,
  editorial photography, watercolor）、质感词直接决定成色——它是审美向训练，
  给足氛围锚它就不出"AI 油光脸"。
- **8 步蒸馏 cfg=1**：negative 字段无效——描述你要的，不描述你不要的。
- 分辨率 16 的倍数；1344x768 与视频关键帧对齐。

## anima 提示词

自然语言英文白描，一两句说清主体与光线氛围即可，堆砌反而糊。

## 现成 LoRA（风格补丁，按 still 传 lora / lora_strength）

- **Krea 2 官方风格包（已装盒，只配 krea2，无触发词，挂上即生效，强度 0.6-0.8）**：
  `krea2_retroanime`（90年代赛璐璐动漫，krea2 的动漫档就靠它）· `krea2_softwatercolor`
  水彩 · `krea2_darkbrush` 暗调厚涂 · `krea2_neondrip` 霓虹 · `krea2_rainywindow`
  雨窗 · `krea2_sunsetblur` 落日虚化 · `krea2_vintagetarot` 复古塔罗 ·
  `krea2_dotmatrix` 点阵 · `krea2_kidsdrawing` 童稚涂鸦（文件名加 .safetensors）
- **其他 LoRA**（Civitai 下载的角色/画风）：只用用户明确给出的文件名——名字不存在
  会直接报错；多数带**触发词**，要写进提示词才激活；角色 LoRA 强度 0.8-1.0。
- v1 一张只挂一个 LoRA；风格强度拉太高会吃掉构图。

## 批量纪律

- stills 数组一次交（≤16 张），逐张上墙，中途失败即停。
- seed 不传则每张随机并回报；要复现/微调时把回报的 seed 传回去。
- 视频关键帧一律 1344x768，商用项目只用 noobai。

## 铁律：不做视觉检查

产物不 Read、不截图、不派 vision-checker。路径报给用户，质量判定归用户。
（codex 的 generate_image 不受此限，照旧检查。）
