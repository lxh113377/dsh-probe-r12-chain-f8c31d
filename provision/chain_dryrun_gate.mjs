#!/usr/bin/env node
// provision/chain_dryrun_gate.mjs - 全链 dry-run rc 传播守护闸（round 9 / #47 / #44 D10.2）
// WHY: round 9 实测发现 remote-provision.sh step7 把达标闸 NOT_PROVEN(rc=2) 用
//   `|| { ...; return 0; }` 吞成整链 rc=0 —— 自动调用方会把「链 rc=0」误读成验收 OK。
//   修复后需要机器闸守护 rc 传播不被回归，并让「完整链零副作用预演」一键可复跑。
// HOW: judgeDryRun 纯函数只对 (rc, stdout) 下判定（C1 链 rc==2 / C2 CHAIN 标记 /
//   C3 gate NOT_PROVEN / C4 无 [EXEC] / C5 全链 PLAN>=8）；runChain spawnSync 一次 dry-run；
//   --selftest 用合成输出 6 例（GREEN + 5 负控）证明判据有牙；默认另造一个「吞 rc」变异
//   副本实跑，判据必须翻红（真实回归负控），副本用完即删；isMain 守卫 + 导出纯函数。
// 诚实边界：全绿只证明「编排链零副作用预演如实回 NOT_PROVEN 且 rc 未被吞」，
//   不证明公网可达 / 真 reboot / 真 token / 关电脑还能用；达标仍由 reboot_acceptance_gate 裁决。

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "remote-provision.sh");

// 纯函数：只裁决一次 dry-run 的 (rc, stdout)，不碰磁盘、不联网。
export function judgeDryRun(o) {
  const rc = Number(o.rc);
  const out = String(o.stdout || "");
  const f = [];
  // C1 链退出码必须等于达标闸 NOT_PROVEN(2)；rc=0 即旧版吞 rc 假绿。
  if (rc !== 2) f.push("CHAIN_RC_NOT_2_got_" + rc);
  // C2 必须显式打印 NOT_PROVEN 链标记（修复 A 产物），否则无法证明 rc 传播生效。
  if (!out.includes("ACCEPTANCE-CHAIN=NOT_PROVEN")) f.push("NO_CHAIN_NOT_PROVEN_MARKER");
  // C3 gate 本身如实 NOT_PROVEN（不是被吞掉）。
  if (!out.includes("ACCEPTANCE=NOT_PROVEN")) f.push("NO_GATE_NOT_PROVEN");
  // C4 零副作用：dry-run 绝不允许 [EXEC] 行。
  if (out.includes("[EXEC]")) f.push("EXEC_LINE_PRESENT_side_effect");
  // C5 全链确实跑过（8 步以上 PLAN）。
  const plans = (out.match(/\[PLAN\]/g) || []).length;
  if (plans < 8) f.push("INCOMPLETE_CHAIN_plans_" + plans);
  return { verdict: f.length === 0 ? "PASS" : "FAIL", failures: f, plans: plans };
}

// spawnSync 跑一次完整链 dry-run：强制 DSH_EXECUTE=0 防误执行，假 host 只产 PLAN。
export function runChain(extraEnv) {
  const env = Object.assign({}, process.env, {
    DSH_EXECUTE: "0",
    DSH_TARGET_HOST: "chain-dryrun.invalid",
  }, extraEnv || {});
  const r = spawnSync("bash", [SCRIPT, ""], { env: env, encoding: "utf8", timeout: 90000 });
  return { rc: r.status == null ? -1 : r.status, stdout: (r.stdout || "") + (r.stderr || "") };
}

// 造「吞 rc」变异副本：把 step7 的 return "$grc" 改回 return 0（旧版假绿形态）。
// 只改功能体这一处，STATIC_LITERALS 清单不动（否则静态闸自指恒绿，T6 教训）。
export function runSwallowedRcMutant() {
  const src = readFileSync(SCRIPT, "utf8");
  const needle = "return \"$grc\"";
  if (!src.includes(needle)) return { rc: -9, stdout: "MUTANT_BUILD_FAIL needle missing" };
  const mut = path.join(HERE, ".chain_dryrun_mut.sh");
  writeFileSync(mut, src.replace(needle, "return 0"), "utf8");
  try {
    const env = Object.assign({}, process.env, { DSH_EXECUTE: "0", DSH_TARGET_HOST: "chain-dryrun.invalid" });
    const r = spawnSync("bash", [mut, ""], { env: env, encoding: "utf8", timeout: 90000 });
    return { rc: r.status == null ? -1 : r.status, stdout: (r.stdout || "") + (r.stderr || "") };
  } finally { rmSync(mut, { force: true }); }
}

function greenStdout() {
  const lines = ["[STEP0] local BYTE-FROZEN freeze check", "FREEZE-OK n=24"];
  for (let i = 1; i <= 8; i++) lines.push("[PLAN] step" + i + " ssh chain-dryrun.invalid noop");
  lines.push("ACCEPTANCE=NOT_PROVEN host=(unset) expectHash=9f4138c53458");
  lines.push("ACCEPTANCE-CHAIN=NOT_PROVEN rc=2 (NEVER claim success)");
  return lines.join("\n");
}

export function selftest() {
  const g = greenStdout();
  const cases = [
    { name: "GREEN", o: { rc: 2, stdout: g } },
    { name: "NEG_SWALLOWED_RC", o: { rc: 0, stdout: g } },
    { name: "NEG_NO_CHAIN_MARKER", o: { rc: 2, stdout: g.replace("ACCEPTANCE-CHAIN=NOT_PROVEN", "X") } },
    { name: "NEG_EXEC_SIDE_EFFECT", o: { rc: 2, stdout: g + "\n[EXEC] ssh real-host reboot" } },
    { name: "NEG_SHORT_CHAIN", o: { rc: 2, stdout: g.split("\n").filter((l) => !l.includes("step")).join("\n") } },
    { name: "NEG_NO_GATE_VERDICT", o: { rc: 2, stdout: g.replace("ACCEPTANCE=NOT_PROVEN", "ACCEPTANCE=PASS") } },
  ];
  const bad = [];
  for (const c of cases) {
    const r = judgeDryRun(c.o);
    // 有牙 = GREEN 必 PASS，其余每个负控必 FAIL 且失败码非空。
    const ok = c.name === "GREEN" ? (r.verdict === "PASS") : (r.verdict === "FAIL" && r.failures.length > 0);
    if (!ok) bad.push(c.name);
    console.log("SELFTEST " + (ok ? "OK  " : "FAIL") + " " + c.name + " verdict=" + r.verdict + " " + r.failures.join(","));
  }
  const teeth = cases.length - 1;
  console.log("CHAIN-DRYRUN-SELFTEST-" + (bad.length === 0 ? "OK" : "FAIL") + " cases=" + cases.length + " teeth=" + teeth);
  return bad.length === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest() ? 0 : 1;
  // 正控：真实全链 dry-run 必须零副作用且如实 NOT_PROVEN rc=2。
  const live = runChain();
  const v = judgeDryRun(live);
  console.log("CHAIN-DRYRUN-LIVE rc=" + live.rc + " plans=" + v.plans + " verdict=" + v.verdict + " " + v.failures.join(","));
  if (v.verdict !== "PASS") { console.log("CHAIN-DRYRUN-FAIL live chain did not hold"); return 1; }
  // 真实回归负控：吞 rc 变异副本跑一次，判据必须翻红（证明守护的不是恒绿）。
  const m = runSwallowedRcMutant();
  const mv = judgeDryRun(m);
  console.log("CHAIN-DRYRUN-NEGCTL mutant_rc=" + m.rc + " verdict=" + mv.verdict + " " + mv.failures.join(","));
  if (m.rc !== 0 || mv.verdict !== "FAIL" || !mv.failures.includes("CHAIN_RC_NOT_2_got_0")) {
    console.log("CHAIN-DRYRUN-NEGCTL-FAIL swallowed-rc mutant not caught"); return 1;
  }
  console.log("CHAIN-DRYRUN-OK live=PASS plans=" + v.plans + " gate_rc=2 negctl=FAIL teeth=1 (zero side effects; NOT a claim of deployment)");
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isMain = invoked && import.meta.url === invoked;
if (isMain) { const rc = await main(); process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc; }