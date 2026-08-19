# 问题库关单审计（id → 理由，供回滚复查）

纪律来源：2026-08-18 全库清账时立的规矩 —— 关单要留档，"已修"必须能指到 commit，
"忽略"必须能指到戒律条款（agent 自身错误 / 按设计的拒绝 / 外因，本不该占信箱）。

## 2026-08-19 截图三案 + 沙盒 tmp 批（修复 commit 见 git log 当日）

| id | 判决 | 理由 |
|---|---|---|
| iss_msz25m5p_v5so | closed | 沙盒 tmp 修复：CLAUDE_CODE_TMPDIR → /tmp/nd/<项目>（allowWrite + 遮兄弟目录），pip 缓存随行；prelude 补装包两条路配方。真跑验收：沙盒内 $TMPDIR 可写、venv 建成、跨项目 tmp 不可见 |
| iss_msz24x5h_er8l | closed | selector 截图弃 locator.screenshot（stability 死等），改元素文档坐标 + fullPage clip 裁剪；rAF 持续重绘 canvas 真跑验收通过（240x180 纯红帧） |
| iss_msz0qat0_y7eu | closed | 同上一条同病根（auto 层抓到的那次 21s 超时） |
| iss_msz24e0q_vfwf | closed | 新增 console:'warn'\|'all' 参数；默认档下被滤 log 条数写进 caption（"没显示≠没发生"） |
| iss_msz236jw_9eui | closed | 新增 waitFor（独立 15s 轮询）；beforeShot 超时 5→10s 且超时文案指路 waitFor；settleMs 上限 3000→10000；caption 报各段用时 |
| iss_msyxgjuf_tosp | closed | settleMs zod 上限放宽（同上） |
| iss_msyzrrtz_p1ds | ignored | agent 自身脚本 exit 1（音效换装清单），一次性；其中 pip 缓存 WARNING 噪音部分已随 PIP_CACHE_DIR 修复消失 |
| iss_msyyoqmf_8c6m | ignored | agent 自身 py7zr API 用错（SevenZipFile.read 不存在），一次性、无平台可改点 |
| iss_mszmxa4u_66vq | ignored | agent 自身 cd 相对路径打错，一次性 |
| iss_msynv7o3_legv | ignored | 读 .env 被 denyRead 拒 —— 按设计的拒绝，闸门在正常工作 |
| iss_msznq1xx_so5m | ignored | agent 自身 cd 相对路径打错（简历），一次性 |
| iss_msnhasxu_hprf | ignored | agent 给 selector 传 playwright :has-text 语法 —— 工具描述本就写明 Plain CSS only，使用错 |

留 open 未动 6 条：iss_msyoej2o_6ftd（外站 page.goto 超时，外因未修）、exit 144 ×3、
exit 1 JSON、rembg balanced 偶发、旧路径不存在、iss_msc4620y_0z3r（生图一致性模式，idea 通道等拍板）。
