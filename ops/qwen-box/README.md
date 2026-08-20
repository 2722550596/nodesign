# qwen-box 重建手册（租用 GPU 盒 → Nodesign 本地模型全链路）

盒子是按小时租的（featurize），**换机即全灭**。本目录是盒上 `~/qwen38/` 与 `~/`
全部手写脚本的原样备份——重建 = 把这些推回新盒子按序跑。两套档位并存：

| 档位 | 机型 | 模型 | 服务脚本 | 槽 × 窗 | Nodesign window |
|---|---|---|---|---|---|
| 96G（08-19） | RTX PRO 6000 Blackwell 96G / 117G 内存 | Q8_K_P 29.3G | `serve.sh` / `restart.sh` / `comfy-start.sh` | 3 × 262144 | 262144 |
| **5090（08-20 起，现役）** | RTX 5090 32G / 58G 内存 | OrcaRouter Uncensored **Q5_K_M** 19.5G | `serve-prod.sh` / `restart-prod.sh` / `comfy-start-low.sh`（`--lowvram` 同卡共存） | 1 × 131072 | 131072 |

5090 档配套（08-20 定案，细节见记忆 qwen38-local-rp / nodesign-api-model-routing）：
- MTP 投机 `n8/p0.5`（干净 A/B 选出；DSpark 封线：散文反而更慢+视觉坏+32G 放不下）
- `--reasoning-effort medium`（xhigh 是模板默认，想太多）
- **`keepalive-timeout.patch` 必打**（llama.cpp `server-http.cpp` 首字节等待 5s→60s）：经隧道并发上传
  多个 100KB+ 请求时排后面的会被 httplib 关连接 = Node 侧 `ECONNRESET: socket hang up`。重拉源码就重打，
  只重编 `cmake --build build --target llama-server`。
- `restart-prod.sh`：llama-server 吃 SIGTERM 会卡在优雅关闭，TERM 等 15s 不退就 KILL 再轮询 /health。

⚠️ 纪律：SSH 密码每次租机都变，走 `SSHPASS` 环境变量 + `sshpass -e`，
**绝不落文件**。盒上两个服务只绑 `127.0.0.1`，出网一律靠隧道。

## 重建顺序（GPU 按秒计费，能并行的并行）

```
推脚本上盒 → 同时开三路：
  ① cuda.sh        conda 装 CUDA 12.9 工具链（Blackwell 要 ≥12.8）
  ② dl.sh / pdl.sh 下模型（hf-mirror 单连接 10MB/s，pdl.sh 8 并发 46MB/s；
                    Q8_K_P 30G + mmproj 889M）
  ③ getsrc2.sh     浅克隆 llama.cpp master（一次性机器不留 git pull 隐患）
① ③ 完成后 → build.sh   （sm_120，-j30 约 15 分钟；产物立刻 cp 进 binbak/）
② 完成后    → restart.sh （setsid nohup 起 serve.sh，日志 logs/server.log）
生图半区    → noobai-setup.sh → comfy-start.sh（NoobAI-XL-Vpred-v1.0，⚠️v-pred
              配错不报错只出废图，验收必须真看图）
```

一条龙有 `rebuild.sh`（clone→build→备份二进制）、`chain.sh`（盯 clone 日志自动接编译）。

## 本机侧（GCP 生产机）

隧道（挂断自动重连；密码/主机/端口从 Nodesign/.env 的 `NODESIGN_H3BOX_*` 读）：

```bash
setsid nohup bash ops/qwen-box/tunnel-gcp.sh > /dev/null 2> /tmp/qwen-tunnel.log < /dev/null &
```

带 `-C` 压缩：这条链路实测上行 ~200KB/s、RTT ~400ms、重传 17%，而 CLI 的旁路请求每个都带整上下文
（32K token ≈ 110KB JSON），压 3~5 倍少传就少等。ComfyUI 隧道同款（8188）。Nodesign 侧不用改任何代码：`model-context.js` 的
qwenLocal 上游指 `127.0.0.1:8080`，盒子没开就 fail-loud 502，这是设计。

## 换机后必查的契约（每条都真栽过）

1. **`n_ctx_slot` 是唯一真相**：serve.sh 的 `-c` 是所有 slot 总量，
   每路 = c/np。3 路要 `-c 786432` 才能保住每路 262144
   （必须 ≥ model-context.js 里 qwen 行的 window，低了 SDK compact 之前先撞 400）。
   改完看启动日志那一行确认，别信注释。
2. **`-np` 应当等于 `NODESIGN_MAX_CONCURRENT_RUNS`**（.env）。改一边就要改另一边；
   `server/lib/_ingress-check.mjs` 第 6 项会真查 `/slots` 对账，换机后跑一次：
   `node --env-file=.env server/lib/_ingress-check.mjs`
   ⚠️ 5090 档是 `-np 1` / 闸 3，这项红是**已知走偏**（按模型 maxConcurrent ⏸ 未拍板），第 2 个 qwen 请求在盒上排队。
3. **`-cram -1`** = prompt cache 不设上限住系统内存。实测会回收不是单向涨，
   但无硬上限，内存报警先看 llama-server RSS。
4. **`--jinja` + chat-template.jinja** 是工具调用的前提，模板在本目录有备份。
5. 投机解码参数：96G 档 serve.sh 里的 `n16/p0.8` 是社区数字；**08-20 5090 干净 A/B 定为 `n8/p0.5`**
   （散文 +29%、agent ~2.5×；长上下文收益缩水）。测速脚本在 `~/qwen38-local/5090/`（bench.py / kl.sh）。
6. 并发性能账（08-19 实测）：单路 63 t/s、双路各 20–33、三路各 14–19，
   总吞吐随并发**下降**——`-np 3` 买的是"不排队"，不是吞吐。

## 验收清单（起完必跑）

- [ ] 启动日志 `n_slots / n_ctx_slot` 与档位表一致（96G：3 × 262144；5090：1 × 131072）
- [ ] 5090 档：`strings`/`git diff` 确认 keepalive-timeout.patch 已打；`curl /health` 经隧道延迟 10 秒再发首字节也要 200
- [ ] `node --env-file=.env server/lib/_ingress-check.mjs`（本机，含 slot 对账）
- [ ] 真发一张 webp 图给 qwen 会话（走 ingress 转码路，stb_image 不认 webp）
- [ ] ComfyUI 真出一张图用眼睛看（v-pred 废图不报错）
- [ ] 前端 picker 里 qwen 可见（localGen 批准账号）
