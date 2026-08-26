#!/usr/bin/env bash
# NoDesign 源码仓库版服务控制脚本
#
# 用法:
#   nodesign-ctl start    启动（后台运行，日志 ~/.nodesign/nodesign.log）
#   nodesign-ctl stop     停止（优雅：先 SIGTERM，超时再 SIGKILL）
#   nodesign-ctl restart  重启
#   nodesign-ctl status   状态（进程 + 健康检查）
#   nodesign-ctl logs     跟踪日志（Ctrl+C 退出跟踪，不影响服务）
#   nodesign-ctl port     打印端口
#
# 环境变量:
#   NODESIGN_PORT     端口（默认 4001；被占会报错而不是悄悄换端口）
#   NODESIGN_DATA_DIR 数据目录（默认 ~/.nodesign）
#
# 说明: 脚本管理的是「bin/nodesign.js supervisor」进程——服务端是它的子进程，
# 收到 SIGTERM 会级联优雅关闭（含 rembg 常驻服务）。改完代码 restart 即可。
set -uo pipefail

# readlink -f 解析符号链接：从 ~/.local/bin/nodesign-ctl 调用时也要能找到真实仓库
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
DATA_DIR="${NODESIGN_DATA_DIR:-$HOME/.nodesign}"
PID_FILE="$DATA_DIR/nodesign.pid"
LOG_FILE="$DATA_DIR/nodesign.log"
PORT="${NODESIGN_PORT:-4001}"
HOST=127.0.0.1

# ── node 定位：PATH 优先，回退 nvm 最新版 ──
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  local latest
  latest="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  if [ -n "$latest" ] && [ -x "$latest" ]; then
    echo "$latest"
    return
  fi
  echo ""
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || echo '')"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

health_ok() {
  curl -sf "http://$HOST:$PORT/api/health" >/dev/null 2>&1
}

cmd_start() {
  if is_running; then
    echo "已在运行（pid $(cat "$PID_FILE")，端口 $PORT）。要换端口先 stop 再 start，或 NODESIGN_PORT=xxxx $0 start"
    return 1
  fi
  if health_ok; then
    echo "端口 $PORT 上已有服务在响应（可能不是你通过本脚本起的实例）。先用原方式停掉它，再 start。"
    return 1
  fi
  local node_bin
  node_bin="$(find_node)"
  if [ -z "$node_bin" ]; then
    echo "找不到 node（PATH 里没有，~/.nvm 也没有）"
    return 1
  fi
  mkdir -p "$DATA_DIR"
  echo "启动 NoDesign（$REPO_DIR，端口 $PORT）"
  echo "  日志: $LOG_FILE"
  nohup "$node_bin" "$REPO_DIR/bin/nodesign.js" --no-open --port "$PORT" >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  local i
  for i in $(seq 1 40); do
    if health_ok; then
      echo "OK：http://$HOST:$PORT/"
      return 0
    fi
    sleep 0.5
  done
  echo "启动超时，最近日志："
  tail -5 "$LOG_FILE" 2>/dev/null
  return 1
}

cmd_stop() {
  if ! is_running; then
    echo "没有在运行（pid 文件 $PID_FILE 不存在或进程已退出）"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  echo "停止（pid $pid）…"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "已停止"
      return 0
    fi
    sleep 0.5
  done
  echo "优雅停止超时，强制结束…"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "已强制停止"
}

cmd_status() {
  if ! is_running; then
    echo "未运行"
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if health_ok; then
    echo "运行中（pid $pid）· http://$HOST:$PORT/ 健康"
  else
    echo "进程在（pid $pid）但健康检查不通（可能还在启动，或端口不是 $PORT）"
  fi
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "还没有日志文件（$LOG_FILE）"
    return 1
  fi
  tail -f "$LOG_FILE"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  port)    echo "$PORT" ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs|port}"
    echo "  NODESIGN_PORT=xxxx $0 start   # 换端口"
    exit 1
    ;;
esac
