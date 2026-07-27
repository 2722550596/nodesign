# Task(subagent_type='vision-checker') 派遣 prompt 模板

> 此文件由 PreToolUse(Task) hook 在 agent 派 vision-checker 时注入。
> SKILL.md § 四、自检与收尾 讲"何时派 / 怎么处理 critique"；本文是具体派遣 prompt 范例。
>
> vision-checker 默认走"先全图一轮 + 每页逐张对照 plan"工作流（自己 list_pages 取页数 / fullPage 总览 / 循环 pageIndex 逐页 / 按页分组报告）。你只需要在 prompt 里给上下文 + 重点关注方向，工作流它自己跑。

## 默认：完整 deck 逐页自检

```
Task(subagent_type='vision-checker',
     prompt='对当前 canvas.html 跑完整逐页视觉评审。

            <deck 上下文 — 用 1-2 句话告诉它这是什么 deck>
            例："情绪型 deck，6 页，《Lain》赛博冷调主题。"
            例："决策型 deck，10 页，AI 搜索市场分析，已 Q3 数据为证。"

            <重点关注 — 任选 0-3 项点名>
            例："- 第 5 页是核心数据页，重点看图表层级
                 - 节奏对比：page 4 应该是空 → 跟 page 3 满形成反差
                 - palette 锁了 #2d2418 / #c45c3f / #f9f8f6"

            返结构化 VERDICT + ISSUES (按页分组) + OVERALL。')
```

vision-checker 会自动：① Read design-plan.md（有的话）跑 Tier 0；② list_pages 取页数；③ fullPage 截图看整体；④ 循环 pageIndex 逐页对照 plan；⑤ 按页分组返 critique。

## 单页定向评审

整个 deck 已自检过、只想看具体一页改完的效果时：

```
Task(subagent_type='vision-checker',
     prompt='重点评审 canvas.html 的 page 3（用 pageIndex=3 截图）。
            上下文：刚改完数据可视化部分，重点看图表层级 + 对比度
            是否撑住"投资回报"核心叙述。
            其他页跳过。')
```

vision-checker 看到你点名了 page，会跳过逐页循环只评这一页。

## 调用约束

- **Task 独占一个 message**（不跟别的 tool 并发；SDK parallel dispatch 会让 subagent 结果丢，这是 SDK 硬规则）
- **`run_in_background: true` 留空或 false**（fire-and-forget 等于自检结果丢；万一传了 PreToolUse hook 会透明改回）
- **派之前先 chat 一句**："让 vision-checker 帮我逐页自检视觉" —— 用户看到不卡死
- **Budget**：逐页模式 ~`页数+5` turn（10 页 deck = ~15 turn）。SDK 给 vision-checker 的 maxTurns 上限 = 16，超长 deck 派之前先在 prompt 里点名分批（"只看 1-5 页" / "只看 6-10 页"）
