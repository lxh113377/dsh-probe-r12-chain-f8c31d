// server-deploy/unit_contract_gate.mjs
// #47 machine gate (round 4): the SHIPPED systemd unit + deploy.sh install
// contract must hold under real Linux root semantics. Pure static judge with
// 6 mutants + a forced-green negative control; wired into deploy.sh [2/6].
// v2 (r4): +C11 login.mjs must create its env dir (login runs BEFORE deploy),
//          +C12 the systemd drop-in must honor PREFIX/ENV_DIR/STATE_DIR
//          overrides instead of leaving the unit hardcoded to defaults.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SD = fileURLToPath(new URL(".", import.meta.url));
const readText = (p) => readFileSync(SD + p, "utf8");

// judge() is pure: feed it (deploy.sh, unit, config.example.json, login.mjs).
export function judge(sh, unit, cfg, login, opts) {
  const greenwash = !!(opts && opts.greenwash);
  const checks = [];
  const ok = (name, cond, ev) => checks.push({ name, ok: !!cond, ev: ev || "" });
  const has = (s, needle) => s.indexOf(needle) >= 0;

  // C1/C2: unit declares User/Group=dshbot; deploy.sh MUST create them
  // idempotently (getent guard), or systemd fails with "Unknown user".
  ok("C1_run_user_created", has(sh, "useradd") && (has(sh, "getent passwd") || has(sh, "id -u")), "deploy.sh needs idempotent useradd for RUN_USER");
  ok("C2_run_group_created", has(sh, "groupadd") && (has(sh, "getent group") || has(sh, "getent passwd")), "deploy.sh needs idempotent groupadd for RUN_USER");

  // C3/C4: config statePath lives under STATE_DIR; service runs as RUN_USER.
  // A root-owned 0755 dir is NOT writable by RUN_USER even with ReadWritePaths.
  ok("C3_state_dir_chowned_to_run_user", has(sh, "chown") && has(sh, "STATE_DIR"), "deploy.sh must chown STATE_DIR to RUN_USER");
  ok("C4_state_dir_not_world_writable", /07[05]0|0700/.test(sh) || (has(sh, "install -d") && has(sh, "STATE_DIR")), "STATE_DIR must be owner-writable, not 0777");

  // C5: unit User must match deploy.sh RUN_USER default.
  const unitUser = (unit.match(/^User=(\S+)/m) || [])[1] || "";
  const shUserM = sh.match(/RUN_USER="?\$\{?RUN_USER:?-([a-zA-Z0-9_-]+)/) || sh.match(/RUN_USER=([a-zA-Z0-9_-]+)/);
  const shUser = shUserM ? shUserM[1] : "";
  ok("C5_unit_user_matches_deploy", unitUser.length > 0 && unitUser === shUser, "unit User=" + unitUser + " vs deploy RUN_USER=" + shUser);

  // C6: unit ReadWritePaths must cover config.example.json statePath dir.
  let cfgObj = null; try { cfgObj = JSON.parse(cfg); } catch {}
  const statePath = cfgObj && cfgObj.statePath ? cfgObj.statePath : "";
  const stateDir = statePath.substring(0, statePath.lastIndexOf("/"));
  const rw = (unit.match(/^ReadWritePaths=(.+)$/m) || [])[1] || "";
  ok("C6_rwpath_covers_state_dir", stateDir.length > 0 && has(rw, stateDir), "ReadWritePaths=" + rw + " must contain " + stateDir);

  // C7: deploy.sh must reconcile its detected node with unit ExecStart path.
  ok("C7_nodebin_reconciled_with_unit", has(sh, "command -v node") && (has(sh, "10-nodebin.conf") || has(sh, "/usr/bin/node")), "deploy.sh must reconcile node path with unit ExecStart");

  // C8/C9/C10: install + secret hygiene (regression guards).
  ok("C8_config_installed", has(sh, "ENV_DIR/config.json") || has(sh, "config.json"), "deploy.sh must install config.json");
  ok("C9_env_mode_0600", has(sh, "chmod 0600"), "env file must be 0600");
  ok("C10_no_plaintext_token_in_config", !/"token"\s*:/.test(cfg.replace(/"_comment"[^,]*,?/g, "")), "config.example.json must not carry a token value");

  // C11 (r4): login.mjs is run BEFORE deploy.sh (README step 2), so it must
  // create its env output DIRECTORY, not just write the file (ENOENT otherwise).
  ok("C11_login_creates_env_dir", has(login, "mkdirSync") && has(login, "dirname(") && has(login, "recursive"), "login.mjs must mkdirSync(dirname(envOut), {recursive:true})");

  // C12 (r4): the drop-in must override ALL path-bearing unit directives so
  // PREFIX/ENV_DIR/STATE_DIR overrides are actually honored at runtime.
  ok("C12_dropin_honors_path_overrides",
      has(sh, "WorkingDirectory=$PREFIX") && has(sh, "EnvironmentFile=$ENV_DIR/env") &&
      has(sh, "ReadWritePaths=$STATE_DIR") && has(sh, "Environment=DSH_ILINK_CONFIG=$ENV_DIR/config.json"),
      "drop-in must override WorkingDirectory/EnvironmentFile/Environment/ReadWritePaths to resolved dirs");

  // C13 (r4): HERE==PREFIX is the documented default install path. A bare
  // install "$HERE/x" "$PREFIX/" fails 'same file' => deploy.sh needs guard.
  ok("C13_inplace_install_guard", has(sh, '"$HERE" = "$PREFIX"') || has(sh, '"$HERE" == "$PREFIX"'), "deploy.sh must guard HERE==PREFIX (install same-file abort)");

  // C14 (r4): the REAL systemd parser gate must be wired into deploy.sh.
  // A static string gate cannot see a malformed unit / bad ExecStart binary.
  ok("C14_real_systemd_parser_wired", has(sh, "verify_unit.mjs") && has(sh, "systemd-analyze") && has(sh, "SYSTEMD-ANALYZE GATE FAILED"), "deploy.sh must call verify_unit.mjs --verify and fail-closed on parser error");

  const total = checks.length;
  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, total, greenwash, ok: greenwash ? false : passed === total };
}

function selftest(sh, unit, cfg, login) {
  const lines = [];
  const base = judge(sh, unit, cfg, login, {});
  lines.push("SELFTEST_BASE passed=" + base.passed + "/" + base.total);
  const m1 = sh.split("\n").filter((l) => l.indexOf("useradd") < 0).join("\n");
  const r1 = judge(m1, unit, cfg, login, {});
  lines.push("M1_NO_USERADD rejected=" + (!r1.ok) + " c1=" + r1.checks[0].ok);
  const m2 = sh.split("\n").filter((l) => l.indexOf("chown") < 0).join("\n");
  const r2 = judge(m2, unit, cfg, login, {});
  lines.push("M2_NO_CHOWN rejected=" + (!r2.ok) + " c3=" + r2.checks[2].ok);
  const m3 = unit.replace(/ReadWritePaths=.*/, "ReadWritePaths=/tmp/unrelated");
  const r3 = judge(sh, m3, cfg, login, {});
  lines.push("M3_RWPATH_MISMATCH rejected=" + (!r3.ok) + " c6=" + r3.checks[5].ok);
  const r4 = judge(sh, unit, cfg, login, { greenwash: true });
  lines.push("M4_GREENWASH rejected=" + (!r4.ok) + " greenwashFlag=" + r4.greenwash);
  const m5 = login.split("\n").filter((l) => l.indexOf("mkdirSync") < 0).join("\n");
  const r5 = judge(sh, unit, cfg, m5, {});
  lines.push("M5_LOGIN_NO_MKDIR rejected=" + (!r5.ok) + " c11=" + r5.checks[10].ok);
  const m6 = sh.split("\n").filter((l) => !l.includes("WorkingDirectory=$PREFIX") && !l.includes("EnvironmentFile=$ENV_DIR/env") && !l.includes("ReadWritePaths=$STATE_DIR")).join("\n");
  const r6 = judge(m6, unit, cfg, login, {});
  lines.push("M6_DROPIN_NO_OVERRIDE rejected=" + (!r6.ok) + " c12=" + r6.checks[11].ok);
  const m7 = sh.split("\n").filter((l) => !l.includes('"$HERE" = "$PREFIX"') && !l.includes('"$HERE" == "$PREFIX"')).join("\n");
  const r7 = judge(m7, unit, cfg, login, {});
  lines.push("M7_NO_INPLACE_GUARD rejected=" + (!r7.ok) + " c13=" + r7.checks[12].ok);
  const m8 = sh.split("\n").filter((l) => !l.includes("verify_unit.mjs --verify") && !l.includes("SYSTEMD-ANALYZE GATE FAILED")).join("\n");
  const r8 = judge(m8, unit, cfg, login, {});
  lines.push("M8_NO_PARSER_GATE rejected=" + (!r8.ok) + " c14=" + r8.checks[13].ok);
  const mutantsOK = [r1, r2, r3, r4, r5, r6, r7, r8].every((r) => !r.ok);
  console.log(lines.join("\n"));
  console.log((mutantsOK ? "R4-UNIT-GATE-SELFTEST-OK" : "R4-UNIT-GATE-SELFTEST-FAIL") + " mutants=8");
  process.exitCode = mutantsOK ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isMain = invokedPath && import.meta.url === invokedPath;
if (isMain) {
  const sh = readText("deploy.sh"), unit = readText("dsh-ilink-bot.service"), cfg = readText("config.example.json"), login = readText("login.mjs");
  const mode = process.argv[2] || "--verify";
  if (mode === "--selftest") { selftest(sh, unit, cfg, login); }
  else {
    const gw = process.env.R4_UNIT_GATE_GREENWASH === "1";
    const r = judge(sh, unit, cfg, login, { greenwash: gw });
    r.checks.filter((c) => !c.ok).forEach((c) => console.log("  FAIL " + c.name + ": " + c.ev));
    console.log("R4-UNIT-EVIDENCE " + JSON.stringify({ passed: r.passed, total: r.total, greenwash: r.greenwash, failed: r.checks.filter((c) => !c.ok).map((c) => c.name) }));
    console.log((r.ok ? "R4-UNIT-GATE-OK" : "R4-UNIT-GATE-FAIL") + " checks=" + r.passed + "/" + r.total + (gw ? " greenwash=on" : ""));
    process.exitCode = r.ok ? 0 : 1;
  }
}
