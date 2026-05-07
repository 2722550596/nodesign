# Task(subagent_type='vision-checker') 派遣 prompt 模板

> 此文件由 PreToolUse(Task) hook 在 agent 派 vision-checker 时注入。
> SKILL.md Stage 4 讲"何时派 / 怎么处理 critique"；本文是具体派遣 prompt 范例。

## 标准全 deck 自检

```
Task(subagent_type='vision-checker',
     prompt='请截图 canvas.html 评审视觉合理性（fullPage 1920×1080）。
            先看 cwd 有没有 design-plan.md：
              有 → 先 Read 跑 Tier 0（plan compliance：deck_kind 导演对象兑现 /
                  meta.palette 配色匹配 / meta.anti_cliche 主动避开的俗套是否真避开 /
                  各页 c_decisions.function_in_arc + rhythm_vs_prev + 单页 4 铁律 / sealed test）
              没有 → 跳 Tier 0 直接 Tier 1
            然后跑 Tier 1-3（可读性 / 层级 / 对齐 / 留白 / 对比度 / 元喻撑场 /
            构图平衡 / 反 AI 套路）。
            返结构化 VERDICT + ISSUES + OVERALL。')
```

## 有 design-plan.md 时（按计划 critique，重 Tier 0）

```
Task(subagent_type='vision-checker',
     prompt='请先 Read design-plan.md，再截图评审 canvas.html。
            **Tier 0 重点对照 plan 的承诺**：
              - 核心隐喻 / palette 是否在视觉上撑住
              - meta.deck_kind 的导演对象是否兑现（决策型标题是否结论而非名词；
                数据型每图是否对应一句结论；情绪型 sealed test 能否过等等，按 kind 分流）
              - meta.anti_cliche 列的俗套是否真避开（逐条对照页面）
              - 每页 c_decisions.function_in_arc / rhythm_vs_prev 是否真兑现
              - 单页 4 铁律（One Sentence / One Dominant Visual / Contrast of Rhythm /
                Delete Before Decorate）逐页打分
            指出 plan 说要 X 但页面没做到 X 的具体差异。
            返结构化 VERDICT + ISSUES + OVERALL，每条 ISSUE 引用 plan 段落。')
```

## 单页评审

```
Task(subagent_type='vision-checker',
     prompt='截图 canvas.html 的 page 3（用 pageIndex=3）评审。
            重点看数据可视化的层级与对比度是否撑住"投资回报"的核心叙述。')
```

## 调用约束

- **Task 独占一个 message**（不跟别的 tool 并发；SDK parallel dispatch 会让 subagent 结果丢，这是 SDK 硬规则）
- **`run_in_background: true` 留空或 false**（fire-and-forget 等于自检结果丢；万一传了 PreToolUse hook 会透明改回）
- **派之前先 chat 一句**："让 vision-checker 帮我自检视觉" —— 用户看到不卡死
