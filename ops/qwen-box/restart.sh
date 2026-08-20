#!/usr/bin/env bash
pkill -f "[q]wen38/llama.cpp/build/bin/llama-ser" ; sleep 3
setsid nohup bash "$HOME/qwen38/serve.sh" > "$HOME/qwen38/logs/server.log" 2>&1 < /dev/null &
