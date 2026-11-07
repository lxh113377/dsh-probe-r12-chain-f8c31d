#!/usr/bin/env node
// provision/acceptance_drill.mjs - 端到端采集演练：真 /_health -> collect() -> judge()（#47 / #44 D10.2）
// KIND=DEV-DRILL NOT-IN-DEPLOY-CHAIN NO-C1-C10-EVIDENCE（round 10 定性，P19 O1 收口）
// 本件只作本机 mock 端到端演练与 gate 局限反例展示，故意不接入 remote-provision.sh 部署链、
// 不生产真机 C1–C10 证据；误接进部署链会把 mock 当真证据 = #36 假绿来源。
// WHY: 把「绑非回环 -> fetch /_health -> codeHash 同源」与「达标裁决」串成一条可复跑链，
//   证明 (a) 真运行体 codeHash 能被采集器同源采到；(b) 缺 reboot/PC-off 证据时绝不假绿；
//   (c) 如实暴露 P13 指出的 gate 局限——喂齐伪造声明可让 judge() 回 PASS，
//   即 PASS 只裁决证据包自洽、不裁决物理事实。此反例必须展示，不许藏。
// HOW: import lan_health_probe 的 probe() 起真子进程拿真 /_health JSON；
//   import collect_acceptance 的 collect()（内部调 judge，裁决权不另立）；
//   8 组 case（同源+缺口 / 负控 / gate 局限反例），import-safe，零 WAN（mock fetch）。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probe, pickLan } from "./lan_health_probe.mjs";
import { collect } from "./collect_acceptance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT = path.join(HERE, "..", "server-deploy", "bot.mjs");
const REAL_HASH = createHash("sha256").update(readFileSync(BOT)).digest("hex");

function src(host, url, health) {
  return { botPath: BOT, host: host, url: url, receipt: {}, pcOffAttested: false,
    pcOffEvidence: "", fetchOk: true, health: health };
}

async function main() {
  const lan = pickLan();
  if (!lan) { console.log("ACCEPTANCE-DRILL-FAIL NO_NON_LOOPBACK_IP"); return 2; }
  const r = await probe("0.0.0.0", lan);
  if (!r.ok || !r.json) { console.log("ACCEPTANCE-DRILL-FAIL LIVE_HEALTH_UNREACHABLE err=" + String(r.err)); return 2; }
  const live = r.json;
  const url = "http://" + lan + ":8787/_health";
  console.log("ACCEPTANCE-DRILL lan=" + lan + " realHash=" + REAL_HASH.slice(0, 12)
    + " liveCodeHash=" + String(live.codeHash).slice(0, 12) + " service=" + live.service);
  const cases = [];
  const add = (name, ok, note) => { cases.push({ name, ok });
    console.log((ok ? "OK  " : "FAIL") + " " + name + (note ? " " + note : "")); };

  // 同源 + 缺口诚实：真 /_health 喂采集器，缺 reboot/PC-off 一律 NOT_PROVEN。
  const c1 = collect(src(lan, url, live));
  add("SAME_ORIGIN_NOT_PROVEN",
    c1.verdict === "NOT_PROVEN" && c1.o.expectHash === REAL_HASH && c1.o.health.codeHash === REAL_HASH
    && c1.failures.includes("NO_REBOOT_WINDOW") && c1.failures.includes("NO_PC_OFF_ATTESTATION"),
    "verdict=" + c1.verdict + " failures=" + c1.failures.join(","));
  add("LIVE_HASH_IS_FROZEN_PACKAGE", c1.o.expectHash === live.codeHash && live.codeHash === REAL_HASH);

  // 负控：破坏证据必翻红，不恒绿。
  const bad = Object.assign({}, live, { codeHash: "0".repeat(64) });
  const c2 = collect(src(lan, url, bad));
  add("NEG_CODEHASH_MISMATCH", c2.verdict !== "PASS" && c2.failures.includes("CODEHASH_MISMATCH"));
  const c3 = collect(src("127.0.0.1", url, live));
  add("NEG_LOOPBACK_HOST", c3.verdict !== "PASS" && c3.failures.includes("HOST_IS_LOOPBACK"));
  const c4 = collect(src(lan, "http://127.0.0.1:8787/_health", live));
  add("NEG_LOOPBACK_URL", c4.verdict !== "PASS" && c4.failures.includes("HEALTH_URL_LOOPBACK"));
  const c4b = collect(src(lan, url, Object.assign({}, live, { service: "other" })));
  add("NEG_WRONG_SERVICE", c4b.verdict !== "PASS" && c4b.failures.includes("WRONG_SERVICE"));

  // gate 局限反例（P13 的 S2）：喂齐伪造声明，judge() 会回 PASS——
  // 证明 PASS 只裁决证据包自洽，不裁决物理事实。
  // round8 C2b/C3b 加严后，私网字面本身已被拒；要诚实展示这条局限，host/url
  // 必须换成「公网形态」字面（域名，静态不可证 WAN 可达，由 C7 真 fetch 裁决）。
  const publicHost = "bot.example.com";
  const publicUrl = "https://bot.example.com/_health";
  const forged = src(publicHost, publicUrl, live);
  forged.receipt = { rebootBefore: 1000, rebootAfter: 2000 };
  forged.pcOffAttested = true;
  forged.pcOffEvidence = "FORGED-selftest-only-not-a-real-PC-off-attestation";
  const c5 = collect(forged);
  add("GATE_LIMIT_FORGED_PACK_PASSES", c5.verdict === "PASS",
    "verdict=" + c5.verdict + " (expected PASS: gate judges pack self-consistency, NOT physical truth)");
  console.log("GATE_LIMIT_NOTE: 该 PASS 由伪造 reboot/PC-off 声明 + 公网形态域名换得；域名静态不可证 WAN 可达、C6 带外证据本机不可自证。达标不能只看 gate 绿。");

  // 加严生效反例：把同一份伪造包的 host/url 换回本机 LAN 私网字面，必翻红且点名新拒绝码。
  const privateForged = Object.assign({}, forged, { host: lan, url: url });
  const c6 = collect(privateForged);
  add("NEG_PRIVATE_HOST_NOW_RED",
    c6.verdict !== "PASS" && c6.failures.includes("HOST_NOT_PUBLIC_ROUTABLE"),
    "verdict=" + c6.verdict + " failures=" + c6.failures.join(","));

  const badCases = cases.filter((c) => !c.ok);
  const teeth = cases.filter((c) => c.name.indexOf("NEG_") === 0).length;
  console.log("ACCEPTANCE-DRILL-" + (badCases.length === 0 ? "OK" : "FAIL")
    + " cases=" + cases.length + " teeth=" + teeth + " gate_limit_shown=true realHash=" + REAL_HASH.slice(0, 12));
  if (badCases.length) console.log("FAILED=" + badCases.map((c) => c.name).join(","));
  return badCases.length === 0 ? 0 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked && process.env.DSH_LAN_CHILD !== "1") { const rc = await main(); process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc; }
export { src };
