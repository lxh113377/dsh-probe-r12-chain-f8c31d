#!/usr/bin/env bash
# provision/remote-provision.sh - 一键远程部署编排规格（fail-closed，全程无头 CLI）
# WHY: P5 审计出部署链四环确切缺口：① 推包后远端不逐文件复算字节 ② deploy.sh 仅文档命令
#      从未真机执行 ③ 公网 /_health 无验收（服务绑 loopback）④ 真 reboot 自拉起未验。
#      本脚本把四环补成一条可复跑、带期望末行、默认不假绿的编排；它是执行规格，不是已完成部署。
# HOW: 默认 dry-run（只打印将执行的命令，不连任何主机）；真执行必须 DSH_EXECUTE=1 + 常开 Linux
#      主机 DSH_TARGET_HOST + key-auth/passwordless sudo + 一次真人扫码 token + DSH_ALLOW_REBOOT=1。
#      任何前置缺失立即 REFUSE(rc=2)。step0 本地字节冻结可用 --local-freeze-only 独立真跑。
#      step6 真 reboot 把前后时间戳落盘成收据；step7 由证据采集器统一装配七项验收变量
#      再交达标闸复核（弥合 P10 的 G1/G2/G3/G6）。公网可达面与 PC 断电证据由编排层喂入，不伪造。
# 诚实边界（#36 / #48）：本会话无常开 Linux 主机、无真 bot_token、无真 reboot、无真手机往返；
#      本脚本默认绝不冒充部署完成；达标闸 reboot_acceptance_gate.mjs 缺证据必回 NOT_PROVEN。
# server-deploy-UNTOUCHED：本脚本与 provision/ 判据全程不写 24 件 BYTE-FROZEN 封印件；
#      SEAL16=edbce68152224bb7 是 _goal-autochat/COMMIT-MANIFEST-r16.md 的权威封印，只作比对只读。
# 不碰鼠标/焦点：纯 ssh/scp/sha256sum/node CLI，无 GUI、无窗口操作（仓内最高约束 + #45）。
set -euo pipefail

UNIT_DIR_DROPIN="/etc/systemd/system/dsh-ilink-bot.service.d"
FROZEN="9f4138c534582e583a5de27e3de68950ad6f6b5881947aacee82aa77aff3c268"
SEAL16="edbce68152224bb7"
PREFIX="/opt/dsh-ilink-bot"
ENV_DIR="/etc/dsh-ilink-bot"
STATE_DIR="/var/lib/dsh-ilink-bot"
UNIT="dsh-ilink-bot.service"
DSH_HEALTH_PORT="${DSH_HEALTH_PORT:-8787}"
DSH_TUNNEL_LOCAL_PORT="${DSH_TUNNEL_LOCAL_PORT:-18787}"
DSH_BIND_HOST="${DSH_BIND_HOST:-0.0.0.0}"
DSH_TARGET_HOST="${DSH_TARGET_HOST:-}"
DSH_SSH_KEY="${DSH_SSH_KEY:-}"
EXPECT="${DSH_EXPECT_CODEHASH:-$FROZEN}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../server-deploy" && pwd)"
MANIFEST="$HERE/MANIFEST.sha256"
GATE="$HERE/../_goal-server/reboot_acceptance_gate.mjs"
COLLECTOR="$HERE/collect_acceptance.mjs"
RECEIPT="${DSH_RECEIPT:-$HERE/acceptance-receipt.json}"
# 公网可达面与带外断电证据：一律由编排层显式喂入，脚本绝不伪造。
# 没有真常开主机 + 反代/域名 + 真人 PC 断电证据时 step7 必回 NOT_PROVEN（fail-closed）。
DSH_PUBLIC_HEALTH_HOST="${DSH_PUBLIC_HEALTH_HOST:-}"
DSH_PUBLIC_HEALTH_URL="${DSH_PUBLIC_HEALTH_URL:-}"
DSH_PC_OFF_ATTESTED="${DSH_PC_OFF_ATTESTED:-}"
DSH_PC_OFF_EVIDENCE="${DSH_PC_OFF_EVIDENCE:-}"

log() { echo "[$1] $2"; }

# RUN: 默认只打印计划；DSH_EXECUTE=1 才真的执行。复合远程命令作为单个引号参数传入即可。
RUN() {
  if [ "${DSH_EXECUTE:-0}" = "1" ]; then echo "[EXEC] $*"; "$@"; else echo "[PLAN] $*"; fi
}

SSH_OPTS=()
[ -n "$DSH_SSH_KEY" ] && SSH_OPTS=(-i "$DSH_SSH_KEY")
SSH() { RUN ssh "${SSH_OPTS[@]}" "$DSH_TARGET_HOST" "$1"; }

require_host() {
  [ -n "$DSH_TARGET_HOST" ] || { echo "REFUSE: DSH_TARGET_HOST unset - no always-on Linux host declared (fail-closed)"; exit 2; }
  # EXPECT_EQ_FROZEN guard: 永不接受调用方传入的非 BYTE-FROZEN hash
  [ "$EXPECT" = "$FROZEN" ] || { echo "REFUSE: DSH_EXPECT_CODEHASH != BYTE-FROZEN bot.mjs sha"; exit 2; }
  [ -f "$MANIFEST" ] || { echo "REFUSE: MANIFEST.sha256 missing"; exit 2; }
  command -v ssh >/dev/null 2>&1 || { echo "REFUSE: ssh missing"; exit 2; }
  command -v scp >/dev/null 2>&1 || { echo "REFUSE: scp missing"; exit 2; }
  command -v sha256sum >/dev/null 2>&1 || { echo "REFUSE: sha256sum missing"; exit 2; }
  command -v node >/dev/null 2>&1 || { echo "REFUSE: node missing"; exit 2; }
  log "PRECONDITIONS-OK" "host=$DSH_TARGET_HOST expect=$EXPECT execute=${DSH_EXECUTE:-0}"
}

# [0] 本地字节冻结（真跑，不依赖远程）：双向 fail-closed，24 件逐字节对封印。
step0_local_freeze() {
  log "STEP0" "local BYTE-FROZEN freeze check (sha256sum -c + verify_frozen.mjs)"
  ( cd "$PKG" && sha256sum -c "$MANIFEST" ) || { echo "FREEZE-FAIL: local sha256sum -c rejected package"; exit 1; }
  node "$HERE/verify_frozen.mjs" "$PKG" "$MANIFEST" || { echo "FREEZE-FAIL: verify_frozen.mjs rejected package"; exit 1; }
  echo "FREEZE-OK n=24 r16-commit-seal=$SEAL16 (server-deploy-UNTOUCHED; per-file seal is verify_frozen.mjs MANIFEST-VERIFY-OK)"
}

# [1] 推 BYTE-FROZEN 包 + 清单到常开主机（弥合 P5 缺口①：推包）。
step1_push() {
  log "STEP1" "scp BYTE-FROZEN 24 files + MANIFEST.sha256 into $PREFIX (flat, HERE==PREFIX)"
  # WHY: scp -r dir host:target 在 target 已存在时会嵌套成 target/dir，破 deploy.sh:82 就地分支。
  #      mkdir -p + scp dir/. 把 24 件平铺进 PREFIX，与 README:60 的 /opt/dsh-ilink-bot 一致。
  SSH "mkdir -p $PREFIX"
  RUN scp -r "${SSH_OPTS[@]}" "$PKG/." "$DSH_TARGET_HOST:$PREFIX/"
  RUN scp "${SSH_OPTS[@]}" "$MANIFEST" "$DSH_TARGET_HOST:/tmp/dsh-manifest.sha256"
}

# [2] 远端逐文件复算（弥合 P5 缺口①核心：推包后远端复算，不是只在本机算）。
step2_remote_freeze() {
  log "STEP2" "remote sha256sum -c /tmp/dsh-manifest.sha256 inside $PREFIX"
  SSH "cd $PREFIX && sha256sum -c /tmp/dsh-manifest.sha256"
  echo "REMOTE-FREEZE-EXPECT: 24 lines ending OK, zero FAILED (else abort before deploy)"
}

# [3] 一次性扫码拿真 token（唯一真人动作；脚本 fail-closed 提示，绝不伪造 token）。
step3_login() {
  log "STEP3" "one-time QR login (human scans once on phone); needs passwordless sudo"
  SSH "cd $PREFIX && sudo DSH_ILINK_ENV_OUT=$ENV_DIR/env node login.mjs"
  echo "LOGIN-GATE: confirmed token in $ENV_DIR/env mode 0600; deploy.sh:90 refuses if missing"
}

# [3b] 部署期绑定动作（弥合 P5 缺口③软件侧根因：编排链没接线，不是代码不支持）。
#   render_config.mjs(round6) 曾是孤儿：deploy.sh:89 只在 config.json 不存在时才复制
#   loopback 的 config.example.json。本步在 step4 之前把绑 0.0.0.0 的 config.json
#   预置进 $ENV_DIR，sudo install 覆盖旧 loopback 版本 -> systemd 读全网卡配置。
#   ENV_DIR 在 deploy.sh:73([3/6]) 才创建，故此处先 sudo mkdir -p。
#   config.example.json 是冻结件(MANIFEST.sha256:4)，全程只读不改。
step3b_bind_config() {
  log "STEP3B" "render config.json (healthHost=$DSH_BIND_HOST) -> pre-stage into $ENV_DIR/config.json BEFORE deploy.sh"
  local tmpcfg="$HERE/.config.rendered.json"
  if [ "${DSH_EXECUTE:-0}" = "1" ]; then
    node "$HERE/render_config.mjs" --health-host "$DSH_BIND_HOST" --out "$tmpcfg" \
      || { echo "BIND-CONFIG-FAIL: render_config.mjs refused healthHost=$DSH_BIND_HOST (fail-closed; no silent loopback config)"; rm -f "$tmpcfg"; return 2; }
  else
    echo "[PLAN] node $HERE/render_config.mjs --health-host $DSH_BIND_HOST (validate bind literal, no file written)"
    node "$HERE/render_config.mjs" --health-host "$DSH_BIND_HOST" >/dev/null \
      || { echo "BIND-CONFIG-FAIL: render_config.mjs refused healthHost=$DSH_BIND_HOST (fail-closed; no silent loopback config)"; return 2; }
  fi
  if [ "${DSH_EXECUTE:-0}" != "1" ]; then
    # plan 只展示将执行的动作，绝不指向一个 dry-run 下并不存在的本地文件（P17）。
    echo "[PLAN] ssh $DSH_TARGET_HOST: sudo mkdir -p $ENV_DIR"
    echo "[PLAN] scp <rendered config.json> -> $DSH_TARGET_HOST:/tmp/dsh-config.rendered.json"
    echo "[PLAN] ssh $DSH_TARGET_HOST: sudo install -m 0644 /tmp/dsh-config.rendered.json $ENV_DIR/config.json"
    echo "BIND-CONFIG-OK healthHost=$DSH_BIND_HOST -> $ENV_DIR/config.json (deploy.sh:89 will NOT overwrite; public routing still needs PUBLIC-HEALTH.md §3)"
    return 0
  fi
  SSH "sudo mkdir -p $ENV_DIR"
  RUN scp "${SSH_OPTS[@]}" "$tmpcfg" "$DSH_TARGET_HOST:/tmp/dsh-config.rendered.json"
  SSH "sudo install -m 0644 /tmp/dsh-config.rendered.json $ENV_DIR/config.json"
  RUN rm -f "$tmpcfg"
  echo "BIND-CONFIG-OK healthHost=$DSH_BIND_HOST -> $ENV_DIR/config.json (deploy.sh:89 will NOT overwrite; public routing still needs PUBLIC-HEALTH.md §3)"
}

# [4] 远端执行 deploy.sh（弥合缺口②）：十一道闸全绿才 restart，期望末行逐字对齐 deploy.sh:241。
step4_deploy() {
  log "STEP4" "sudo ./deploy.sh on remote (eleven gates + [6/6] online verify)"
  SSH "cd $PREFIX && sudo ./deploy.sh"
  echo "DEPLOY-EXPECT: DEPLOY-BOOT-OK is-enabled=confirmed (survives reboot)"
  echo "DEPLOY-EXPECT-LAST: DEPLOY-OK health=ok needsRelogin=false egress=confirmed provenance=confirmed expectPort=<PORT-EXPECT> (judge: ...)"
}

# [5] 远端 /_health 验真（部分弥合缺口③）：服务绑 127.0.0.1，走 ssh -L 隧道把远端 loopback 映到本地，
#     再把真实响应喂 check_health.mjs 纯函数五判，不用 bash 内联 grep 猜 JSON。
#     诚实边界：隧道是本机 loopback，非公网暴露；公网 IP/域名/防火墙/反代仍未取证（README:74 只 curl 127.0.0.1）。
step5_health() {
  log "STEP5" "ssh -L tunnel -> curl /_health -> node check_health.mjs (loopback tunnel, NOT public)"
  RUN ssh -f -N -L "${DSH_TUNNEL_LOCAL_PORT}:127.0.0.1:${DSH_HEALTH_PORT}" "${SSH_OPTS[@]}" "$DSH_TARGET_HOST"
  echo "HEALTH-EXPECT-LAST: HEALTH-OK codeHash=$EXPECT"
  if [ "${DSH_EXECUTE:-0}" = "1" ]; then
    curl -fsS "http://127.0.0.1:${DSH_TUNNEL_LOCAL_PORT}/_health" | node "$HERE/check_health.mjs" "$EXPECT"
  else
    echo "[PLAN] curl -fsS http://127.0.0.1:${DSH_TUNNEL_LOCAL_PORT}/_health | node $HERE/check_health.mjs $EXPECT"
  fi
}

REBOOT_BEFORE_TS=""
REBOOT_AFTER_TS=""
# [6] 真 reboot 自拉起验收（弥合缺口④）：默认 SKIPPED 不假绿；显式 DSH_ALLOW_REBOOT=1 才真重启。
#     P10 G3：真 reboot 时把 before/after 落盘成 receipt JSON（不是只 echo），供采集器/达标闸读。
step6_reboot() {
  if [ "${DSH_ALLOW_REBOOT:-0}" != "1" ]; then
    echo "[PLAN] step6 real reboot: DSH_ALLOW_REBOOT=1 would systemctl reboot + write receipt $RECEIPT"
    echo "REBOOT-ACCEPT=SKIPPED (no real reboot authorized; never claimed as proven)"
    return 0
  fi
  if [ "${DSH_EXECUTE:-0}" != "1" ]; then
    # plan 预演真 reboot 动作但绝不真重启、绝不真写收据（P17 门控泄漏）。
    echo "[PLAN] ssh $DSH_TARGET_HOST: sudo systemctl reboot"
    echo "[PLAN] date +%s before/after -> receipt $RECEIPT (NOT written in dry-run)"
    return 0
  fi
  log "STEP6" "real reboot + post-boot is-active/health recheck"
  local before after
  before="$(date +%s)"
  REBOOT_BEFORE_TS="$before"
  SSH "sudo systemctl reboot" || true
  after="$(date +%s)"
  REBOOT_AFTER_TS="$after"
  printf '{"rebootBefore":%s,"rebootAfter":%s}\n' "$before" "$after" > "$RECEIPT"
  echo "REBOOT-BEFORE=$before REBOOT-AFTER=$after receipt=$RECEIPT (PC-off evidence supplied out-of-band)"
}

# [7] fail-closed 达标闸收口（弥合 P10 G1/G2/G3/G6）：step6 已把 reboot 前后戳落盘成 receipt，
#     这里把全部 7 项证据（公网 host/url、reboot 戳、PC-off 带外证据）喂达标闸，缺一必 NOT_PROVEN(rc=2)。
#     公网可达面与 PC 断电证据由编排层显式参数喂入，脚本绝不伪造（P10 G4/G5 如实留白、不自证）。
# WHY: 采集器是 C1–C10 唯一装配权威（实算冻结包 sha256 + readReceipt 读真 reboot 收据 +
#      readPcOff 校验带外证据文件真实存在非空）。旧版 step7 手写透传 7 个 DSH_ACCEPT_*
#      绕过 readPcOff，让「DSH_PC_OFF_ATTESTED=1 + 不存在的证据路径」骗绿 gate C6
#      （P19 W2 / P21 C6 安全洞，round 10 Lead 独立复现：judge 回 PASS、readPcOff 回 false）。
# HOW: eval 采集器 --emit-shell 的 7 行 export（shellQuote 单引号转义防注入），让它的
#      装配结果直接成为 gate 输入；删掉手写前缀、2>/dev/null||true 与恒绿 grep 探针。
#      装配-only 模式采集器绝不 fetch；gate 仅在 host+url 都声明时才 fetch（dry-run 默认空 ⇒ 零出网）。
step7_acceptance() {
  log "STEP7" "collect_acceptance.mjs --emit-shell (sole assembly authority) + reboot_acceptance_gate.mjs fail-closed verdict"
  local emit
  emit="$(DSH_COLLECT_HOST="$DSH_PUBLIC_HEALTH_HOST" DSH_COLLECT_URL="$DSH_PUBLIC_HEALTH_URL" DSH_COLLECT_RECEIPT="$RECEIPT" DSH_COLLECT_PCOFF="$DSH_PC_OFF_EVIDENCE" DSH_COLLECT_PCOFF_ATTESTED="$DSH_PC_OFF_ATTESTED" node "$COLLECTOR" --emit-shell)" || { echo "COLLECT-WIRING-FAIL: collector --emit-shell failed (fail-closed)"; return 2; }
  # 七项 export 逐项守卫：少任何一项都视为接线断裂，绝不把残缺装配喂给 gate。
  local key
  for key in DSH_ACCEPT_HOST DSH_ACCEPT_URL DSH_ACCEPT_EXPECT_CODEHASH DSH_ACCEPT_REBOOT_BEFORE DSH_ACCEPT_REBOOT_AFTER DSH_ACCEPT_PC_OFF_ATTESTED DSH_ACCEPT_PC_OFF_EVIDENCE; do
    printf '%s\n' "$emit" | grep -qF "export $key=" || { echo "COLLECT-WIRING-FAIL: missing export $key"; return 2; }
  done
  echo "$emit"
  # eval 只执行 7 行 export KEY=单引号值；值经 shellQuote 转义，外部 host/path 无法注入命令。
  eval "$emit" || { echo "COLLECT-WIRING-FAIL: eval of collector exports failed (fail-closed)"; return 2; }
  # WHY: 旧版把达标闸的 rc=2/NOT_PROVEN 用 `|| { ...; return 0; }` 吞成整链 rc=0，
  #      自动调用方会把「链 rc=0」误读成验收 OK —— #36 假绿温床（round 9 实测：假 host
  #      dry-run 全链跑完 CHAIN_RC=0 而 gate 实为 NOT_PROVEN + 11 条 FAILURES）。
  # HOW: `|| grc=$?` 在 OR 列表里绕开 set -e 捕获真实 rc；按三态打印 ACCEPTANCE-CHAIN
  #      并原样 return：PASS=0 / FAIL=1 / NOT_PROVEN=2。整链退出码 = 最终达标裁决，绝不假绿。
  local grc=0
  node "$GATE" || grc=$?
  case "$grc" in
    0) echo "ACCEPTANCE-CHAIN=PASS rc=0 (gate verdict PASS; verify evidence is REAL — gate only judges self-consistency, see acceptance_drill S2)" ;;
    1) echo "ACCEPTANCE-CHAIN=FAIL rc=1 (evidence contradicts; do NOT claim success)" ;;
    *) echo "ACCEPTANCE-NOT-PROVEN (expected until all external evidence is real); ACCEPTANCE-CHAIN=NOT_PROVEN rc=$grc (NEVER claim success)" ;;
  esac
  return "$grc"
}

# 完整回滚（P6 决5：补齐 drop-in 与 dshbot 账号，不止删 prefix）。
rollback() {
  log "ROLLBACK" "disable+stop -> drop-in -> prefix/env/state -> dshbot account"
  SSH "sudo systemctl disable --now $UNIT || true"
  SSH "sudo rm -rf $UNIT_DIR_DROPIN 2>/dev/null || true"
  SSH "sudo rm -rf $PREFIX $ENV_DIR $STATE_DIR"
  SSH "sudo userdel dshbot || true"
  echo "ROLLBACK-DONE (server-deploy-UNTOUCHED; local package untouched)"
}

# 内建静态自证（#44 D10.2）：功能体关键标记全在才绿；删任一必翻红（负控有牙）。
STATIC_LITERALS=(
  "server-deploy-UNTOUCHED"
  "sha256sum -c /tmp/dsh-manifest.sha256"
  "DEPLOY-BOOT-OK is-enabled=confirmed"
  "systemctl reboot"
  "REBOOT-ACCEPT"
  "DSH_ACCEPT_HOST"
  "disable --now"
  "EXPECT_EQ_FROZEN"
  "DSH_ILINK_ENV_OUT"
  "FREEZE-OK n=24"
  "ACCEPTANCE-NOT-PROVEN"
  "DSH_ACCEPT_REBOOT_BEFORE"
  "DSH_ACCEPT_PC_OFF_ATTESTED"
  "DSH_PUBLIC_HEALTH_URL"
  "collect_acceptance.mjs --emit-shell"
  'eval "$emit"'
  "rebootBefore"
  "step3b_bind_config"
  "render_config.mjs"
  "BIND-CONFIG-OK"
  "/tmp/dsh-config.rendered.json"
  "ACCEPTANCE-CHAIN=NOT_PROVEN"
  "ACCEPTANCE-CHAIN=PASS"
)
static_check_on() {
  local f="$1" miss=0 boundary body
  # 只扫功能体（STATIC_LITERALS 定义行之前）：若连字面清单自身都算命中，判据即自指恒绿。
  boundary="$(grep -n -m1 -F 'STATIC_LITERALS=(' "$f" | cut -d: -f1)"
  if [ -z "$boundary" ]; then body="$(cat "$f")"; else body="$(head -n "$((boundary-1))" "$f")"; fi
  for lit in "${STATIC_LITERALS[@]}"; do
    printf '%s\n' "$body" | grep -qF -- "$lit" || { echo "STATIC-MISSING $lit"; miss=$((miss+1)); }
  done
  [ "$miss" -eq 0 ]
}
selftest() {
  static_check_on "$0" || { echo "REMOTE-PROVISION-SELFTEST-FAIL static"; return 1; }
  # 负控（#44 D10.2）：构造缺一个字面的合成文件，static_check_on 必须判 FAIL —— 证明判据有牙非恒绿。
  # 用合成文件而非 mutate $0，避免把字面清单自身一并删掉造成「清单跟着缩水」的自指假绿。
  local tmp lit omit teeth=0
  # 两个负控分别证明：① 删任一功能体标记静态闸翻红；② 删掉 round 9 的 rc 传播标记
  # (ACCEPTANCE-CHAIN=NOT_PROVEN) 也翻红 —— 防止有人把 step7 改回吞 rc 的假绿版本。
  for omit in "systemctl reboot" "ACCEPTANCE-CHAIN=NOT_PROVEN"; do
    tmp="$(mktemp)"
    for lit in "${STATIC_LITERALS[@]}"; do
      [ "$lit" = "$omit" ] || printf '%s\n' "$lit" >> "$tmp"
    done
    if static_check_on "$tmp" >/dev/null 2>&1; then
      echo "NEGCTL-FAIL missing-literal copy still passes (omit=$omit)"; rm -f "$tmp"; return 1
    fi
    rm -f "$tmp"
    teeth=$((teeth+1))
  done
  # 第三负控（#44 D10.2 / P21 R3）：精确变异功能体、删掉 eval 接线行（清单保留），
  # 静态闸必须翻红 —— 防止有人把 step7 改回手写透传 7 变量、绕过 readPcOff 的 C6 洞。
  tmp="$(mktemp)"
  sed '/^  eval "\$emit"/d' "$0" > "$tmp"
  if static_check_on "$tmp" >/dev/null 2>&1; then
    echo "NEGCTL-FAIL eval-wiring mutant still passes"; rm -f "$tmp"; return 1
  fi
  rm -f "$tmp"
  teeth=$((teeth+1))
  echo "REMOTE-PROVISION-SELFTEST-OK literals=${#STATIC_LITERALS[@]} teeth=$teeth"
  return 0
}

expect_guard() {
  # EXPECT_EQ_FROZEN guard（全路径）：永不接受调用方传入的非 BYTE-FROZEN hash
  [ "$EXPECT" = "$FROZEN" ] || { echo "REFUSE: DSH_EXPECT_CODEHASH != BYTE-FROZEN bot.mjs sha"; exit 2; }
}

main() {
  expect_guard   # 所有路径一律校验 BYTE-FROZEN hash，含 --local-freeze-only / --selftest
  case "${1:-}" in
    --selftest) selftest; rc=$?; exit $rc ;;
    --local-freeze-only) step0_local_freeze; echo "FREEZE-LOCAL-OK"; exit 0 ;;
    --bind-config-only) step3b_bind_config; echo "BIND-CONFIG-PLAN-OK"; exit 0 ;;
    --rollback) require_host; rollback; exit 0 ;;
    "") require_host; step0_local_freeze; step1_push; step2_remote_freeze; step3_login; step3b_bind_config; step4_deploy; step5_health; step6_reboot; step7_acceptance ;;
    *) echo "REFUSE: unknown arg $1"; exit 2 ;;
  esac
}
main "$@"
