# roll_film — MiniMax-H3 提示词手册（08-08 定档配方，《好巧》14 段零失败实证）

管线固定：站主 5090 盒子 + sage + Turbo 8 步，1344×768@24fps，单镜 5.2-12.25s。
没有别的档位。

## Prompt 格式（英文，三字段布局，≤7000 字符）

```
integrated_multimodal_description: [Shot 1] <风格锚句>. <角色块>. <画面/动作/机位描述>.
<角色名> says in Mandarin: "台词写中文". [Shot 2] At 00:04.500 <下一内切镜头>...
overall_soundscape: <环境音/音效分层描述，英文>
non_diegetic_music: N/A
```

- **台词**：`says/shouts in Mandarin: "……"`（H3 原生中文语音，实测过关）；旁白用
  voice-over 措辞。台词梗 > 画面文字梗（画面小字会变成装饰性乱码）。
- **段内多切镜**：`[Shot N] At mm:ss.mmm` 把相邻节拍并进同一次生成——切点天然连续、
  音轨不断，比拆两条便宜一半。
- **non_diegetic_music 永远 N/A**：配乐后期统一铺，否则镜镜配乐互相撞车。
- 有首尾帧锚时开头加一句对齐说明：`How the reference pictures align with the target
  video — Picture 1 aligns with the 0.00-second mark; Picture 2 aligns with the
  <时长>-second mark.`

## 多镜成片纪律（连贯性全靠这个，没有捷径）

1. **角色块逐字相同**：每个角色写一段外观描述（发色/瞳色/服装/配饰），所有镜头
   一字不差地复制粘贴。改一个词角色就漂。风格锚句同理。
2. **全片一个 seed**：第一镜用什么 seed，后面每镜都传同一个。
3. **一镜一生成**：每镜 ≤12.25s，长剧情拆镜后期拼（用户负责剪辑或另行安排）。
4. **关键帧锚**：`paint_still`（动漫向）或 `generate_image` 产 1344×768 关键帧，
   传 first_frame/last_frame。首尾锚极可靠，但锚间模型会自由发挥——别指望中段细节。
5. 运动方向尽量统一（如一律向右），减少跨镜跳切感。

## 节奏（发车前告知用户）

产线跑在站主的 5090 盒子上：一条墙钟约 3-6 分钟（8s≈3 分、12s≈5 分），机时成本
几美分级。盒子不在线时工具会明说——转告用户等开机，没有自动备胎。
多镜片先跟用户对齐分镜表再逐镜发车，别自作主张连发。同一镜拿到成片后不要擅自重跑
——要改也是用户看完提要求。

## 铁律：不做视觉检查

产物 mp4 不 Read、不截图、不派 vision-checker、不试图用任何方式"看"。把
`assets/generated/<name>.mp4` 的路径报给用户，质量判定全部由用户完成。
