#!/usr/bin/env bash
set -e
cd /d/dsh-im-robot || exit 1
R=_goal-server/probe-r12
rm -rf "$R"
mkdir -p "$R/provision" "$R/_goal-server" "$R/server-deploy" "$R/.github/workflows"
# BYTE-FROZEN 24 件原样拷（只读源，不改）
cp -a server-deploy/. "$R/server-deploy/"
# provision 活动判据件全拷（含 MANIFEST.sha256 / .sh / 文档）
cp -a provision/. "$R/provision/"
# _goal-server 只需判据链依赖的 gate（collect 跨目录 import 它）
cp -a _goal-server/reboot_acceptance_gate.mjs "$R/_goal-server/"
# 防 CRLF：Git 不做行尾转换，保证 sha256sum -c 在 Linux 与本机一致
printf "%s\n" "* -text" > "$R/.gitattributes"
echo "=== ASSEMBLED FILE COUNTS ==="
echo -n "server-deploy="; find "$R/server-deploy" -type f | wc -l
echo -n "provision="; find "$R/provision" -type f | wc -l
echo -n "_goal-server="; find "$R/_goal-server" -type f | wc -l
echo "=== byte-for-byte identity (source vs copy) ==="
DIFF=0
for f in server-deploy/* provision/* _goal-server/reboot_acceptance_gate.mjs; do
  case "$f" in
    *_r12*|*_r11*|*.tmp|*.jsonl) continue;;
  esac
  if [ -f "$f" ]; then
    dst="$R/${f#_goal-server/}"; [ -f "$R/$f" ] && dst="$R/$f"
    # 计算目标：server-deploy/provision 前缀直接映射到 R 同名目录；gate 单独处理
    if [[ "$f" == server-deploy/* ]]; then dst="$R/server-deploy/${f#server-deploy/}";
    elif [[ "$f" == provision/* ]]; then dst="$R/provision/${f#provision/}";
    else dst="$R/_goal-server/reboot_acceptance_gate.mjs"; fi
    if [ -f "$dst" ]; then cmp -s "$f" "$dst" || { echo "DIFF $f"; DIFF=$((DIFF+1)); }; fi
  fi
done
echo "BYTE_DIFF_COUNT=$DIFF"
echo "=== sha256sum -c inside copy (layout check) ==="
( cd "$R/server-deploy" && sha256sum -c ../provision/MANIFEST.sha256 ) | tail -2
echo "SHA256SUM_RC=$?"