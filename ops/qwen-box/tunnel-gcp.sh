#!/usr/bin/env bash
# tunnel-gcp.sh — GCP 侧：把盒上 llama-server(127.0.0.1:8080) 拉到本机 127.0.0.1:8080（Nodesign qwenLocal 上游）。
#   密码从 Nodesign/.env 的 NODESIGN_H3BOX_PASS 读（不进文件不进参数），断线 3 秒重连。
#   -C：⭐08-20 实测这条链路上行只有 ~200KB/s、RTT ~400ms、重传 17%；CLI 每个旁路请求都带整上下文
#       （32K token ≈ 110KB JSON），一批 13 个并发就是 1.4MB≈7 秒。JSON 压 3~5 倍，少传就少等。
#   配套：盒上 llama-server 已打补丁把 httplib 首字节等待 5s→60s（keepalive-timeout.patch），
#       否则排在后面上传的请求首字节晚于 5 秒就被对端关掉 = Node 的 `ECONNRESET: socket hang up`。
#   用法：setsid nohup bash ops/qwen-box/tunnel-gcp.sh > /dev/null 2> /tmp/qwen-tunnel.log < /dev/null &
set -u
ENVF="$(cd "$(dirname "$0")/../.." && pwd)/.env"
export SSHPASS="$(grep '^NODESIGN_H3BOX_PASS=' "$ENVF" | cut -d= -f2-)"
HOST="$(grep '^NODESIGN_H3BOX_SSH=' "$ENVF" | cut -d= -f2-)"; HOST="${HOST:-featurize@workspace.featurize.cn}"
PORT="$(grep '^NODESIGN_H3BOX_PORT=' "$ENVF" | cut -d= -f2-)"; PORT="${PORT:-12434}"
while true; do
  sshpass -e ssh -N -C -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -L 8080:127.0.0.1:8080 "$HOST" -p "$PORT"
  echo "[tunnel] 断线，3 秒后重连 $(date +%T)" >&2
  sleep 3
done
