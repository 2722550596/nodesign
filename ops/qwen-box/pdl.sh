#!/usr/bin/env bash
# 并发分块下载器：hf-mirror 单连接限速 10MB/s，8 并发实测 46MB/s。
# 每块 append 式续传（重跑即接着下），全下完再 cat 成整文件。
set -u
R=HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF
F="$1"; OUT="$HOME/qwen38/models/$F"; P="$HOME/qwen38/parts/$F"
URL="https://hf-mirror.com/$R/resolve/main/$F"
mkdir -p "$P"
TOTAL=$(curl -sIL "$URL" | grep -i '^content-length' | tail -1 | tr -dc '0-9')
[ -z "$TOTAL" ] && { echo "FAIL: 拿不到 content-length"; exit 1; }
CHUNK=$(( 1000*1000*1000 ))
N=$(( (TOTAL + CHUNK - 1) / CHUNK ))
echo "总大小 $((TOTAL/1000000)) MB，分 $N 块"
seq 0 $((N-1)) | xargs -P 8 -I{} bash -c '
  i={}; S=$(( i * '"$CHUNK"' )); E=$(( S + '"$CHUNK"' - 1 ))
  [ $E -ge '"$TOTAL"' ] && E=$(( '"$TOTAL"' - 1 ))
  NEED=$(( E - S + 1 )); PF="'"$P"'/part.$i"
  HAVE=$(stat -c%s "$PF" 2>/dev/null || echo 0)
  while [ "$HAVE" -lt "$NEED" ]; do
    curl -sL -r $(( S + HAVE ))-$E "'"$URL"'" >> "$PF"
    NEW=$(stat -c%s "$PF" 2>/dev/null || echo 0)
    [ "$NEW" -le "$HAVE" ] && { echo "块 $i 卡住"; break; }
    HAVE=$NEW
  done
'
cat $(seq 0 $((N-1)) | sed "s|^|$P/part.|") > "$OUT"
GOT=$(stat -c%s "$OUT")
if [ "$GOT" = "$TOTAL" ]; then rm -rf "$P"; echo "DOWNLOAD_DONE $F"; else echo "FAIL 大小不符 $GOT != $TOTAL"; fi
