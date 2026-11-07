// server-deploy/corrupt_state_gate.mjs
// #47 machine gate G8: corrupt on-disk state.json must degrade observably.
// WHY: loadState used to catch ALL read and parse errors and silently reset to
// an empty cursor + empty seen set. After a power loss (the "PC off" case) a
// truncated state.json was reported as status=ok on /_health, re-polled from an
// empty cursor (iLink may replay history -> duplicate replies), and the only
// forensic copy was overwritten. Fail closed: report corrupt_state, stop
// polling and sending, keep /_health observable, do not overwrite the file.
//
//   node corrupt_state_gate.mjs                            -> CORRUPT-STATE-GATE-OK   exit 0
//   CORRUPT_GATE_GREENWASH=1 node corrupt_state_gate.mjs   -> CORRUPT-STATE-GATE-FAIL  exit 1
//
// Self-contained: imports only bot.mjs + node builtins. No network, token,
// WeChat, or GUI.

import { runService, codeHash, loadState } from "./bot.mjs";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const GREENWASH = process.env.CORRUPT_GATE_GREENWASH === "1";

export function checksFor(ev) {
  return [
    ["C1_legit_first_boot_ok", ev.boot.status === "ok" && ev.boot.polls >= 1 && ev.boot.loadCorrupt === false],
    ["C2_corrupt_health_degraded", ev.corrupt.healthStatus === "corrupt_state"],
    ["C3_corrupt_stats_degraded", ev.corrupt.statsStatus === "corrupt_state"],
    ["C4_corrupt_no_polling", ev.corrupt.polls === 0],
    ["C5_corrupt_no_sending", ev.corrupt.sends === 0],
    ["C6_corrupt_file_preserved", ev.corrupt.diskPreserved === true],
    ["C7_corrupt_health_keeps_codehash", ev.corrupt.healthHash === codeHash()],
    ["C8_loadstate_shape_teeth", ev.shapeTeeth === true],
  ];
}
export function assertCorruptEv(ev) {
  if (GREENWASH) return true;
  for (const [name, pass] of checksFor(ev)) if (!pass) throw new Error(name);
  return true;
}

const negatives = [];
function neg(name, ev) { let rejected = false; try { assertCorruptEv(ev); } catch { rejected = true; } negatives.push({ name, rejected }); }
const goodEv = {
  boot: { status: "ok", polls: 2, loadCorrupt: false },
  corrupt: { healthStatus: "corrupt_state", statsStatus: "corrupt_state", polls: 0, sends: 0, diskPreserved: true, healthHash: codeHash() },
  shapeTeeth: true,
};
neg("synthetic_corrupt_reported_ok", { boot: goodEv.boot, corrupt: { ...goodEv.corrupt, healthStatus: "ok", statsStatus: "ok" }, shapeTeeth: true });
neg("synthetic_corrupt_hammer_polling", { boot: goodEv.boot, corrupt: { ...goodEv.corrupt, polls: 99 }, shapeTeeth: true });
neg("synthetic_corrupt_sent_message", { boot: goodEv.boot, corrupt: { ...goodEv.corrupt, sends: 1 }, shapeTeeth: true });
neg("synthetic_corrupt_file_overwritten", { boot: goodEv.boot, corrupt: { ...goodEv.corrupt, diskPreserved: false }, shapeTeeth: true });
neg("synthetic_shape_teeth_missing", { boot: goodEv.boot, corrupt: goodEv.corrupt, shapeTeeth: false });

const shapeDir = mkdtempSync(join(tmpdir(), "dsh-r7-shape-"));
function shapeVal(name, content) {
  const p = join(shapeDir, name);
  if (content === null) { if (existsSync(p)) rmSync(p); } else writeFileSync(p, content);
  return loadState(p).corrupt;
}
const validCanonical = JSON.stringify({ getUpdatesBuf: "BUF-X", seen: ["m1"] });
const shape = {
  missing: shapeVal("missing.json", null),
  validEmpty: shapeVal("valid_empty.json", "{}"),
  validCanonical: shapeVal("valid_canonical.json", validCanonical),
  truncated: shapeVal("truncated.json", validCanonical.slice(0, 18)),
  garbage: shapeVal("garbage.json", "not json at all"),
  seenWrongType: shapeVal("seen_wrong.json", JSON.stringify({ getUpdatesBuf: "BUF-X", seen: "m1" })),
  bufWrongType: shapeVal("buf_wrong.json", JSON.stringify({ getUpdatesBuf: 42, seen: [] })),
  rootArray: shapeVal("root_array.json", "[]"),
};
const shapeTeeth = shape.missing === false && shape.validEmpty === false && shape.validCanonical === false
  && shape.truncated === true && shape.garbage === true && shape.seenWrongType === true
  && shape.bufWrongType === true && shape.rootArray === true;
rmSync(shapeDir, { recursive: true, force: true });

const CORRUPT = validCanonical.slice(0, 18);
// connection:close + node:http (not global fetch/undici) so no keep-alive
// socket lingers to trip the Windows libuv UV_HANDLE_CLOSING abort when the
// gate exits with a non-zero code during a RED verdict.
const grab = (port) => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/_health",
    headers: { connection: "close" }, timeout: 5000 }, (res) => {
    let s = ""; res.on("data", (d) => s += d);
    res.on("end", () => { try { resolve(JSON.parse(s)); } catch (err) { reject(err); } });
  });
  req.on("error", reject);
  req.on("timeout", () => { req.destroy(); reject(new Error("health timeout")); });
});
async function runCase(withCorrupt) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-r7-gate-"));
  const statePath = join(dir, "state.json");
  if (withCorrupt) writeFileSync(statePath, CORRUPT);
  let polls = 0, sends = 0, healthAtListen = null, healthAtDegrade = null, threw = false;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.indexOf("getupdates") >= 0) {
      polls += 1;
      return { ok: true, json: async () => ({ ret: 0, msgs: [
        { from_user_id: "wxid_r7gate@im.wechat", message_id: "r7-gate-m1", message_type: 1,
          create_time_ms: 1000, context_token: "ctx-r7gate", item_list: [{ type: 1, text_item: { text: "ping" } }] }
      ], get_updates_buf: "BUF-NEW" }) };
    }
    if (u.indexOf("sendmessage") >= 0) { sends += 1; return { ok: true, json: async () => ({ ret: 0 }) }; }
    return { ok: true, json: async () => ({ ret: 0 }) };
  };
  let stats = null;
  try {
    stats = await runService(
      { token: "r7-gate-fake-token", baseUrl: "https://ilinkai.weixin.qq.com/", statePath, configPath: "/nope", healthPort: 0 },
      { fetchImpl, fastFail: true, maxCycles: 2, reloginIdleMs: 20, maxIdleTicks: 3,
        logger: { log(){}, warn(){}, error(){} },
        onListen: async (port) => { healthAtListen = await grab(port); },
        onDegraded: async (port) => { healthAtDegrade = await grab(port); } }
    );
  } catch (e) { threw = true; }
  const diskAfter = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const loadCorrupt = loadState(statePath).corrupt;
  rmSync(dir, { recursive: true, force: true });
  const h = healthAtDegrade || healthAtListen || {};
  return {
    status: stats && stats.status, healthStatus: h.status, healthHash: h.codeHash,
    polls, sends, threw, diskPreserved: withCorrupt ? diskAfter === CORRUPT : true, loadCorrupt,
  };
}

const boot = await runCase(false);
const corrupt = await runCase(true);
const ev = {
  boot: { status: boot.status, polls: boot.polls, loadCorrupt: boot.loadCorrupt },
  corrupt: { healthStatus: corrupt.healthStatus, statsStatus: corrupt.status, polls: corrupt.polls,
    sends: corrupt.sends, diskPreserved: corrupt.diskPreserved, healthHash: corrupt.healthHash },
  shapeTeeth,
};
console.log("CORRUPT-STATE-EVIDENCE " + JSON.stringify(ev));
const checks = checksFor(ev);
checks.filter(c => !c[1]).forEach(c => console.log("  FAIL " + c[0]));
negatives.filter(n => !n.rejected).forEach(n => console.log("  NEG-NOT-REJECTED " + n.name));
const passed = checks.filter(c => c[1]).length;
const negPassed = negatives.filter(n => n.rejected).length;
let judgeOk = true;
try { assertCorruptEv(ev); } catch { judgeOk = false; }
const allGood = judgeOk && passed === checks.length && negPassed === negatives.length && !GREENWASH;
console.log((allGood ? "CORRUPT-STATE-GATE-OK" : "CORRUPT-STATE-GATE-FAIL")
  + " checks=" + passed + "/" + checks.length + " teeth=" + negPassed + "/" + negatives.length
  + (GREENWASH ? " greenwash=on" : ""));
process.exitCode = allGood ? 0 : 1;
