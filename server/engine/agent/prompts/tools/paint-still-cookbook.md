# paint_still — 本地生图手册（08-08 实测配方 + BFL 官方提示词实践）

## 选型

| 模型 | 提示词语言 | 稳态速度 | 许可 | 用在哪 |
|---|---|---|---|---|
| noobai | danbooru 标签 | ~20s | 商用可 | 动漫角色/关键帧主力，tag 级控制最强 |
| anima | 自然语言英文 | ~20s | 非商用 | 氛围感插画 |
| flux2-turbo | 自然语言 | **~12s** | 非商用 | 海报/字卡/写实细节，flux2 系首选 |
| flux2 | 自然语言 | ~30s | 非商用 | turbo 不够细时的质量锚（20 步） |

⚠️ 装卸税：flux2 系和其他模型互切时，切换后第一张要付 ~35G 权重搬运费（几分钟）。
**批量时按模型分组排序**（同模型的 stills 排一起），别交错着切。

## noobai 提示词（danbooru 标签流）

逗号分隔标签，不写自然语言句子。质量前缀词系统自动加，别重复写。
顺序习惯：主体数量 → 角色外观 → 服装 → 动作表情 → 场景 → 构图镜头 → 光。
`1girl, silver hair, long hair, witch hat, black robe, riding broom, flying,
cloud sea, sunrise, wide shot, from below, cinematic lighting, depth of field`

## flux2 / flux2-turbo 提示词（BFL 官方实践）

- **骨架：Subject + Action + Style + Context**（主体→动作→风格→环境氛围）。
- **长度**：30-80 词是生产档甜区；10-30 词探索；只有真复杂的场景才 80+。
  形容词堆砌是噪音，每句话都要背视觉信息。
- **画面文字**：精确文字用引号并放句子前部，指明位置与字体风格——
  `The text "FILMS" carved in bold serif letters on a wooden signpost in the
  foreground`。文字短、字数少更稳；首发命中率约 60%，重要字卡同题出 3-5 张挑。
- **无负面提示**：FLUX.2 不支持 negative（工具的 negative 字段对 flux2 系无效）。
  描述你要的，不描述你不要的。
- **颜色**：绑到具体对象上说，可用 hex——"the cloak is #1a1a2e" 比"用深蓝色调"稳。
- 分辨率 16 的倍数；1344x768 与视频关键帧对齐，海报可开更大。

## anima 提示词

自然语言英文白描，一两句说清主体与光线氛围即可，堆砌反而糊。

## 批量纪律

- stills 数组一次交（≤16 张），逐张上墙，中途失败即停。
- seed 不传则每张随机并回报；要复现/微调时把回报的 seed 传回去。
- 视频关键帧一律 1344x768，商用项目只用 noobai。

## 铁律：不做视觉检查

产物不 Read、不截图、不派 vision-checker。路径报给用户，质量判定归用户。
（codex 的 generate_image 不受此限，照旧检查。）
