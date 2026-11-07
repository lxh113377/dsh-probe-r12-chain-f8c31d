#!/usr/bin/env bash
# Deploy/update the headless iLink bot on a Linux server.
# #47 compliance: a service restart (what makes changes take effect) is ONLY
# performed after ALL ELEVEN machine gates pass: the NINE [2/6] preflight
# gates (including the r6 sendmessage-boundary gate, the r7 corrupt-state
# gate, the r16 provenance-gate selftest, and the r16 port-input selftest)
# and the TWO [4/6] real gates - the systemd-parser gate and the r16
# port-input validate gate. Each gate has a proven negative control
# (greenwash / mutant must FAIL). The parser gate runs the REAL
# systemd-analyze verify against the installed unit + generated drop-in; the
# port-input gate validates the TWO sources deploy.sh manages (EnvironmentFile
# env + config.json) are canonical decimal 1..65535, computes the expected
# health port from them, and provenance_gate asserts the OS-truth bound socket
# MATCHES it at [6/6] - so an UNTRACKED source that moved the real port
# (stray drop-in / manager env / DefaultEnvironment) fails closed at runtime
# instead of being enumerated statically (r17 managed-only).

# #40 compliance: commit(package) -> deploy(install) -> online-verify: an
# OS-truth provenance check (provenance_gate.mjs, r16) binds /_health to the
# process systemd JUST restarted via systemctl MainPID + /proc socket-inode
# ownership + ESTABLISHED responder-socket ownership + freshness, then
# composes the five verify_health.mjs checks; PLUS an independent outbound
# round-trip to iLink getconfig, judged by egress_gate.mjs --live (r8). The
# ELEVEN restart-preflight gates (nine [2/6] + two [4/6]) all run BEFORE the
# restart; the egress check is a second [6/6] ONLINE signal, not a restart
# gate. bot.mjs is byte-stable (codeHash 9f4138c5...) across r8..r16.
set -euo pipefail
PREFIX="${PREFIX:-/opt/dsh-ilink-bot}"
ENV_DIR="${ENV_DIR:-/etc/dsh-ilink-bot}"
STATE_DIR="${STATE_DIR:-/var/lib/dsh-ilink-bot}"
RUN_USER="${RUN_USER:-dshbot}"
RUN_GROUP="${RUN_GROUP:-dshbot}"
# UNIT_DIR is overridable so container/chroot/test installs can target a
# writable unit root; on a real server the default /etc/systemd/system applies.
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[1/6] preflight: node + syntax"
command -v node >/dev/null || { echo "node missing"; exit 2; }
NODE_BIN="$(command -v node)"
node --check "$HERE/unit_contract_gate.mjs"
node --check "$HERE/verify_unit.mjs"
node --check "$HERE/bot.mjs"
node --check "$HERE/login.mjs"
node --check "$HERE/gate.mjs"
node --check "$HERE/probe_live.mjs"
node --check "$HERE/verify_deploy.mjs"
node --check "$HERE/stale_token_gate.mjs"
node --check "$HERE/verify_health.mjs"
node --check "$HERE/sendfail_gate.mjs"
node --check "$HERE/corrupt_state_gate.mjs"
node --check "$HERE/egress_gate.mjs"
node --check "$HERE/provenance_gate.mjs"
node --check "$HERE/port_gate.mjs"

echo "[2/6] MACHINE GATE (must pass before any restart)"
( cd "$HERE" && env -u GATE_INJECT_GREENWASH node gate.mjs ) || { echo "GATE FAILED — aborting deploy, no restart performed"; exit 1; }
( cd "$HERE" && env -u DSH_ILINK_EXPECT_WRONG -u DSH_ILINK_CHILD -u DSH_ILINK_STATE node verify_deploy.mjs ) || { echo "DEPLOY-VERIFY FAILED — aborting, no restart performed"; exit 1; }
( cd "$HERE" && env -u STALE_GATE_GREENWASH node stale_token_gate.mjs ) || { echo "STALE-TOKEN GATE FAILED — aborting, no restart performed"; exit 1; }
( cd "$HERE" && env -u VERIFY_HEALTH_GREENWASH node verify_health.mjs --selftest ) || { echo "ONLINE-VERIFY SELFTEST FAILED — aborting, no restart performed"; exit 1; }
( cd "$HERE" && env -u R4_UNIT_GATE_GREENWASH node unit_contract_gate.mjs --verify ) || { echo "UNIT-CONTRACT GATE FAILED — aborting, no restart performed"; exit 1; }

( cd "$HERE" && env -u SENDFAIL_GATE_GREENWASH node sendfail_gate.mjs ) || { echo "SENDFAIL GATE FAILED — aborting, no restart performed"; exit 1; }
( cd "$HERE" && env -u CORRUPT_GATE_GREENWASH node corrupt_state_gate.mjs ) || { echo "CORRUPT-STATE GATE FAILED — aborting, no restart performed"; exit 1; }
( cd "$HERE" && env -u PROVENANCE_GATE_GREENWASH node provenance_gate.mjs --selftest ) || { echo "PROVENANCE GATE SELFTEST FAILED — aborting, no restart performed"; exit 1; }
( cd "$HERE" && env -u PORT_GATE_GREENWASH node port_gate.mjs --selftest ) || { echo "PORT-INPUT GATE SELFTEST FAILED — aborting, no restart performed"; exit 1; }

echo "[3/6] install files + service account"
# The shipped unit declares User/Group=dshbot. systemd refuses to start a unit
# whose user does not resolve, so create it idempotently BEFORE install/chown.
if ! getent group "$RUN_GROUP" >/dev/null; then groupadd --system "$RUN_GROUP"; fi
if ! getent passwd "$RUN_USER" >/dev/null; then useradd --system --gid "$RUN_GROUP" --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$RUN_USER"; fi
install -d -m 0755 "$PREFIX" "$ENV_DIR"
install -d -m 0750 "$STATE_DIR"
# state.json is written BY the service (as RUN_USER). A root-owned 0755 dir
# is not writable even with ReadWritePaths=, so chown it to the run user.
chown "$RUN_USER:$RUN_GROUP" "$STATE_DIR"
chmod 0750 "$STATE_DIR"
# HERE==PREFIX is the documented default (scp to /opt/dsh-ilink-bot, cd there,
# run). A bare install "$HERE/x" "$PREFIX/" then fails with a coreutils "same file"
# error at [3/6]. In-place installs just fix mode bits instead of self-copying.
if [ "$HERE" = "$PREFIX" ]; then
  echo "[3/6] install files (in-place: source dir == PREFIX)"
  chmod 0644 "$HERE/bot.mjs" "$HERE/login.mjs" "$HERE/gate.mjs" "$HERE/probe_live.mjs" "$HERE/verify_deploy.mjs" "$HERE/stale_token_gate.mjs" "$HERE/verify_health.mjs" "$HERE/unit_contract_gate.mjs" "$HERE/verify_unit.mjs" "$HERE/sendfail_gate.mjs" "$HERE/corrupt_state_gate.mjs" "$HERE/package.json" "$HERE/config.example.json" "$HERE/egress_gate.mjs" "$HERE/provenance_gate.mjs" "$HERE/port_gate.mjs"
else
  install -m 0644 "$HERE/bot.mjs" "$HERE/login.mjs" "$HERE/gate.mjs" "$HERE/probe_live.mjs" "$HERE/verify_deploy.mjs" "$HERE/stale_token_gate.mjs" "$HERE/verify_health.mjs" "$HERE/unit_contract_gate.mjs" "$HERE/verify_unit.mjs" "$HERE/sendfail_gate.mjs" "$HERE/corrupt_state_gate.mjs" "$HERE/package.json" "$HERE/egress_gate.mjs" "$HERE/provenance_gate.mjs" "$HERE/port_gate.mjs" "$PREFIX/"
  install -m 0644 "$HERE/config.example.json" "$PREFIX/config.example.json"
fi
[ -f "$ENV_DIR/config.json" ] || install -m 0644 "$HERE/config.example.json" "$ENV_DIR/config.json"
[ -f "$ENV_DIR/env" ] || { echo "MISSING $ENV_DIR/env (run login.mjs once to obtain token, mode 0600)"; exit 2; }
chmod 0600 "$ENV_DIR/env"

echo "[4/6] systemd unit + node/user drop-in"
install -m 0644 "$HERE/dsh-ilink-bot.service" "$UNIT_DIR/dsh-ilink-bot.service"
# The shipped unit hardcodes ExecStart=/usr/bin/node. On real servers node may
# live at /usr/local/bin/node (nvm, tarball). A drop-in override reconciles the
# detected binary AND the PREFIX/ENV_DIR/STATE_DIR overrides without editing
# the packaged file (which stays byte-stable for sha-based integrity).
DROPIN_DIR="$UNIT_DIR/dsh-ilink-bot.service.d"
install -d -m 0755 "$DROPIN_DIR"
{
  echo "[Service]"
  echo "User=$RUN_USER"
  echo "Group=$RUN_GROUP"
  echo "WorkingDirectory=$PREFIX"
  echo "EnvironmentFile="
  echo "EnvironmentFile=$ENV_DIR/env"
  echo "Environment="
  echo "Environment=DSH_ILINK_CONFIG=$ENV_DIR/config.json"
  echo "ReadOnlyPaths="
  echo "ReadOnlyPaths=$PREFIX"
  echo "ReadWritePaths="
  echo "ReadWritePaths=$STATE_DIR"
  echo "ExecStart="
  echo "ExecStart=$NODE_BIN $PREFIX/bot.mjs"
} > "$DROPIN_DIR/10-nodebin.conf"
# #47 gate 10 (r17 managed-only port EXPECT computation, fail-closed BEFORE
# restart): read ONLY the two sources deploy.sh itself manages (EnvironmentFile
# env + config.json), validate their DSH_ILINK_HEALTH_PORT / healthPort values
# are canonical decimal 1..65535 (F-N2 fail-fast on 0/1e3/0x50/empty/space-80),
# and compute PORT-EXPECT following bot.mjs priority env>config>8787. We do NOT
# statically enumerate every possible source - that arms race is unwinnable.
# Instead we CARRY the expected port to [6/6] and provenance_gate.mjs asserts
# the REAL bound socket (from /proc) equals it; any untracked source that moved
# the port becomes a runtime mismatch => red. A VALID managed override (F2)
# stays green because PORT-EXPECT tracks it.
PORT_OUT="$( cd "$HERE" && env -u PORT_GATE_GREENWASH node port_gate.mjs --validate --env "$ENV_DIR/env" --config "$ENV_DIR/config.json" --unit "$UNIT_DIR/dsh-ilink-bot.service" --dropin "$DROPIN_DIR" 2>&1 )" || { echo "PORT-INPUT GATE FAILED — aborting, no restart performed"; printf '%s\n' "$PORT_OUT"; exit 1; }
EXPECT_PORT="$(printf '%s\n' "$PORT_OUT" | grep -oE 'PORT-EXPECT=[0-9]+' | head -1 | cut -d= -f2 || true)"
if [ -z "$EXPECT_PORT" ]; then
  echo "PORT-INPUT GATE FAILED: no PORT-EXPECT in gate output — aborting, no restart performed"
  printf '%s\n' "$PORT_OUT"
  exit 1
fi
printf '%s\n' "$PORT_OUT"
echo "PORT-EXPECT-CAPTURED=$EXPECT_PORT"
# #47 gate 11 (REAL parser, fail-closed): validate the installed unit + drop-in
# with the actual systemd-analyze BEFORE daemon-reload/restart. This catches a
# malformed unit or a nonexistent ExecStart binary that static gates miss.
( cd "$HERE" && env -u VERIFY_UNIT_GREENWASH node verify_unit.mjs --verify "$UNIT_DIR/dsh-ilink-bot.service" ) || { echo "SYSTEMD-ANALYZE GATE FAILED — aborting, no restart performed"; exit 1; }
systemctl daemon-reload

echo "[5/6] restart (all eleven preflight gates already green)"
# r12: enable MUST succeed. The old "|| true" here let DEPLOY-OK print even when
# boot auto-start was broken - the original "重启后桥又断了" complaint. Fail closed.
if ! systemctl enable dsh-ilink-bot.service; then
  echo "DEPLOY-VERIFY-FAIL: systemctl enable failed - service will NOT survive reboot"
  exit 1
fi
# r16 N5 freshness: capture the restart instant BEFORE the unit is restarted.
# provenance_gate.mjs rejects any /_health reply whose ts predates this wall
# clock, so a stale leftover from a PREVIOUS deploy cannot be judged as this
# restart even if it echoes the right codeHash/pid (Restart=always flapping).
RESTART_TS="$(date +%s)"
systemctl restart dsh-ilink-bot.service

# Online judge: TWO INDEPENDENT signals must BOTH be green before DEPLOY-OK.
# (1) PROCESS health via verify_health.mjs --url: service name,
#     codeHash == sha256(deployed bot.mjs), status == ok, needsRelogin !== true,
#     lastError empty. WHY needsRelogin/lastError: token expiry degrades to
#     needs_relogin; a zero-egress/generic transport-error host keeps status=ok
#     but sets lastError - both must FAIL verify (r5 fix).
# (2) OUTBOUND egress via egress_gate.mjs --live: a real HTTP round-trip to the
#     NON-long-poll getconfig endpoint with a DELIBERATELY fake token, which
#     iLink MUST reject (nonzero errcode/ret). WHY: a network BLACKHOLE (TCP
#     accepted, never answered) makes bot.mjs swallow the getUpdates timeout as
#     a pseudo-success {ret:0,msgs:[]}; runService then clears lastError and
#     keeps status=ok, so signal (1) is byte-identical to a healthy idle host -
#     r8_checkurl_probe.mjs blackhole_cli=ACCEPTED. Without (2), DEPLOY-OK
#     prints on a host where ZERO messages can ever arrive (r8). Blackhole,
#     zero-egress, captive HTML, 5xx, and {errcode:0} all fail closed.
echo "[6/6] ONLINE VERIFY (verify_health.mjs process health + egress_gate.mjs --live outbound)"
# FG-4: bind the verdict to the unit we actually restarted. Without this a
# leftover healthy process from a PREVIOUS deploy on :8787 could pass as this
# restart even when the new unit never came up.
if ! systemctl is-active --quiet dsh-ilink-bot.service; then
  echo "DEPLOY-VERIFY-FAIL: dsh-ilink-bot.service is not active after restart"
  exit 1
fi
# r12: boot survival. is-active proves it runs NOW; is-enabled proves systemd
# will start it again after reboot. Both must hold before DEPLOY-OK.
if ! systemctl is-enabled --quiet dsh-ilink-bot.service; then
  echo "DEPLOY-VERIFY-FAIL: dsh-ilink-bot.service is not enabled - will NOT start after reboot"
  exit 1
fi
echo "DEPLOY-BOOT-OK is-enabled=confirmed (survives reboot)"
# (1) process health via OS-truth provenance (r16/r17). verify_health.mjs
# judged a PUBLICLY-computable codeHash + a SELF-REPORTED pid; a loopback
# impostor on a DIFFERENT socket could answer /_health and pass as THIS deploy
# (F4). r16: provenance_gate.mjs discovers the endpoint from the OS -
# systemctl MainPID (SYSTEM bus) -> /proc/$pid/fd socket inodes ->
# /proc/net/tcp{,6} LISTEN rows owned by that pid - then composes the SAME
# five assertDeployHealth checks; an impostor (different inode) is never
# polled. r17: it ALSO asserts that discovered port == PORT-EXPECT computed
# at [4/6] from the two MANAGED sources (--expect-port), so an untracked
# source that moved the real bound socket fails closed at runtime. We do NOT
# derive the DIAL url from config (that caused F2 false-RED / F-N2 NaN url);
# the expected port is only a RUNTIME ASSERTION on OS-truth, not a dial target.
# H1 hardening: a LISTEN inode only proves MainPID HOLDS a socket. The gate
# ALSO keeps our client socket open and asserts the accept()-ed ESTABLISHED
# socket (state 01, a DIFFERENT inode) is owned by MainPID, so an
# SO_REUSEPORT impostor that accepts on its own socket is rejected. N5:
# --since-ts rejects a /_health reply older than the restart we JUST issued.
# Restart=always can flap MainPID for a few seconds, so we poll 20x (as the
# old health loop did) instead of failing on the first transient.
if [ "${DSH_ILINK_HERMETIC:-0}" = "1" ]; then PROV_SCOPE="hermetic-mock"; else PROV_SCOPE="confirmed"; fi
PROV_LAST=""
PROV_OK=0
for i in $(seq 1 20); do
  if PROV_LAST="$( cd "$PREFIX" && env -u PROVENANCE_GATE_GREENWASH -u VERIFY_HEALTH_GREENWASH -u DBUS_SYSTEM_BUS_ADDRESS -u DBUS_SESSION_BUS_ADDRESS node provenance_gate.mjs --check --unit dsh-ilink-bot.service --prefix "$PREFIX" --node "$NODE_BIN" --scope "$PROV_SCOPE" --since-ts "$RESTART_TS" --bot-file "$PREFIX/bot.mjs" --expect-port "$EXPECT_PORT" 2>&1 )" && printf %s "$PROV_LAST" | grep -qF "PROVENANCE-OK"; then
    echo "$PROV_LAST"
    PROV_OK=1
    break
  fi
  sleep 1
done
if [ "$PROV_OK" -ne 1 ]; then
  echo "DEPLOY-VERIFY-FAIL after 20 provenance polls: ${PROV_LAST:-no response}"
  echo "  if it says needs_relogin: deployed token expired - run login.mjs once, then redeploy"
  exit 1
fi
# (2) independent outbound round-trip. Raw fetch, NOT bot.mjs, so a bot bug
# cannot mask an egress failure. env -u strips the gate greenwash.
# r14 Face A: on a REAL deploy we ALSO strip DSH_EGRESS_HOST (FG-2 symmetry
# with the health judge). That override is test-only; if it leaked in, a
# loopback impostor answering {errcode:-14} would pass --live and we would
# print egress=confirmed without EVER reaching iLink. Hermetic capstones
# opt in with DSH_ILINK_HERMETIC=1 to KEEP the override (they need their
# loopback mock), but their receipt is explicitly labelled hermetic-mock,
# never confirmed. An operator must never read a capstone as a real deploy.
EGRESS_ENV=(env -u EGRESS_GATE_GREENWASH)
if [ "${DSH_ILINK_HERMETIC:-0}" = "1" ]; then
  EGRESS_RECEIPT="egress=hermetic-mock"
else
  EGRESS_ENV+=(-u DSH_EGRESS_HOST)
  EGRESS_RECEIPT="egress=confirmed"
fi
if ! ( cd "$PREFIX" && "${EGRESS_ENV[@]}" node egress_gate.mjs --live ); then
  echo "DEPLOY-VERIFY-FAIL: outbound egress to iLink NOT confirmed (blackhole / no-route / bad response)"
  exit 1
fi
echo "DEPLOY-OK health=ok needsRelogin=false $EGRESS_RECEIPT provenance=$PROV_SCOPE expectPort=$EXPECT_PORT (judge: service+sha+status+needsRelogin+lastError+egress+os-truth-inode+responder-bound+freshness+expect-port)"
exit 0
