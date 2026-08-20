#!/usr/bin/env bash
# restart-prod.sh — 重启今晚的 llama-server（serve-prod.sh）。
# ⛔ 08-20 栽过：llama-server 吃 SIGTERM 走「优雅关闭」会等在线的 HTTP 线程，有客户端挂着就卡住不退；
#    新进程起来显存还被占着 → cudaMalloc OOM 退出，结果是两个都不在 = 掉线。所以 TERM 等 15 秒不退就 KILL。
P=$(pgrep -f "[l]lama-server" | tr "\n" " ")
if [ -n "$P" ]; then
  kill $P 2>/dev/null
  for i in $(seq 1 15); do pgrep -f "[l]lama-server" >/dev/null || break; sleep 1; done
  if pgrep -f "[l]lama-server" >/dev/null; then echo "[restart] TERM 15s 没退，KILL"; kill -9 $P 2>/dev/null; fi
  for i in $(seq 1 20); do pgrep -f "[l]lama-server" >/dev/null || break; sleep 1; done
fi
setsid nohup bash "$HOME/qwen38/serve-prod.sh" > "$HOME/qwen38/logs/server.log" 2>&1 < /dev/null &
for i in $(seq 1 48); do curl -s -m 2 http://127.0.0.1:8080/health | grep -q ok && { echo "[restart] health ok (~$((i*5))s)"; exit 0; }; sleep 5; done
echo "[restart] ⛔ 240s 还没 health ok，看 ~/qwen38/logs/server.log"; exit 1
