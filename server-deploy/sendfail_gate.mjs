// server-deploy/sendfail_gate.mjs
// #47 machine gate for the processInbound sendmessage-failure boundary.
// WHY: the shipped build used to call seen.add(mid) BEFORE await sendText;
// a transient sendmessage transport failure then permanently swallowed the
// message (at-most-once silent drop, invisible on /_health). The fix moved
// seen.add(mid) AFTER the successful await, giving at-least-once retry.
// This gate runs the REAL runService twice in-process (control + fail-first)
// against a mock iLink that re-delivers one message and can fail the first
// send. It judges OBSERVED counters, never reasoning alone.
//
//   node sendfail_gate.mjs                            -> SENDFAIL-GATE-OK   exit 0
//   SENDFAIL_GATE_GREENWASH=1 node sendfail_gate.mjs -> SENDFAIL-GATE-FAIL exit 1
//
// Self-contained: only imports ./bot.mjs + node builtins. No _goal-autochat,
// no network egress, no WeChat, no GUI, no token plaintext, no Windows paths.

import { runService, codeHash } from "./bot.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GREENWASH = process.env.SENDFAIL_GATE_GREENWASH === "1";
const MID = "r6-sf-m1";

// THE CONTRACT: five named checks over the captured real evidence.
export function checksFor(ev) {
  const c = ev && ev.control, f = ev && ev.failFirst;
  return [
    ["C1_control_replied", !!(c && c.stats && c.stats.replied === 1)],
    ["C2_control_seen_persisted", !!(c && c.diskState && c.diskState.seen && c.diskState.seen.indexOf(MID) >= 0)],
    ["C3_failfirst_retried", !!(f && f.counters && f.counters.sendAttempts >= 2)],
    ["C4_failfirst_eventually_replied", !!(f && f.stats && f.stats.replied >= 1)],
    ["C5_failfirst_no_silent_drop", !!(f && f.stats && f.counters && !(f.stats.replied === 0 && f.counters.sendFailed >= 1))],
  ];
}
export function assertSendfailEv(ev) {
  if (GREENWASH) return true; // liar: must be caught by the synthetic teeth
  for (const [name, pass] of checksFor(ev)) if (!pass) throw new Error(name);
  return true;
}

// Synthetic teeth: GOOD must pass, four mutants MUST be rejected.
function clone(o) { return JSON.parse(JSON.stringify(o)); }
const GOOD = {
  control: { counters: { sendAttempts: 1, sendSuccess: 1, sendFailed: 0 }, stats: { received: 1, replied: 1, status: "ok", lastError: null }, diskState: { getUpdatesBuf: "BUF-CONST", seen: [MID] } },
  failFirst: { counters: { sendAttempts: 2, sendSuccess: 1, sendFailed: 1 }, stats: { received: 1, replied: 1, status: "ok", lastError: null }, diskState: { getUpdatesBuf: "BUF-CONST", seen: [MID] } },
};
function mut(fn) { const c = clone(GOOD); fn(c); return c; }
const teeth = [
  { name: "GOOD_retry_then_reply", ev: GOOD, expectPass: true },
  { name: "BAD_silent_drop", ev: mut((c) => { c.failFirst.counters.sendAttempts = 1; c.failFirst.counters.sendSuccess = 0; c.failFirst.stats.replied = 0; c.failFirst.stats.received = 0; }), expectPass: false },
  { name: "M1_no_retry", ev: mut((c) => { c.failFirst.counters.sendAttempts = 1; }), expectPass: false },
  { name: "M2_control_dropped", ev: mut((c) => { c.control.stats.replied = 0; }), expectPass: false },
  { name: "M3_failfirst_dropped", ev: mut((c) => { c.failFirst.stats.replied = 0; c.failFirst.counters.sendAttempts = 1; }), expectPass: false },
];
let teethOk = 0;
for (const t of teeth) {
  let threw = false;
  try { assertSendfailEv(t.ev); } catch { threw = true; }
  const correct = (threw === !t.expectPass);
  if (correct) teethOk += 1; else console.log("TEETH-FAIL " + t.name);
}

// ---- REAL evidence: two independent in-process runService calls ----------
async function runCase(failFirst) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-sendfail-gate-"));
  const statePath = join(dir, "state.json");
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ reply: { rules: [{ match: "alpha", reply: "ACK-alpha" }], defaultReply: "ACK" } }));
  const msgA = { from_user_id: "wxid_r6sf@im.wechat", message_id: MID, message_type: 1,
    create_time_ms: 1000, context_token: "r6-sf-ct", item_list: [{ type: 1, text_item: { text: "alpha" } }] };
  const counters = { getCalls: 0, sendAttempts: 0, sendSuccess: 0, sendFailed: 0 };
  const fetchImpl = async (url, opts) => {
    await new Promise((rs) => setTimeout(rs, 5));
    const u = String(url);
    if (u.indexOf("getupdates") >= 0) {
      counters.getCalls += 1;
      return { ok: true, json: async () => ({ ret: 0, msgs: [msgA], get_updates_buf: "BUF-CONST" }) };
    }
    if (u.indexOf("sendmessage") >= 0) {
      counters.sendAttempts += 1;
      if (failFirst && counters.sendAttempts === 1) { counters.sendFailed += 1; throw new Error("simulated sendmessage transport failure"); }
      counters.sendSuccess += 1;
      return { ok: true, json: async () => ({ ret: 0 }) };
    }
    return { ok: true, json: async () => ({ ret: 0 }) };
  };
  let stats = null, runErr = null;
  try {
    stats = await runService(
      { configPath, statePath, token: "sendfail-gate-fake-token", baseUrl: "https://ilinkai.weixin.qq.com/", healthPort: 0 },
      { fetchImpl, maxCycles: 6, fastFail: true, logger: { warn() {}, log() {}, error() {} } }
    );
  } catch (e) { runErr = String(e && e.message || e); }
  const disk = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  return { counters, stats: stats ? { received: stats.messagesReceived, replied: stats.messagesReplied, status: stats.status, lastError: stats.lastError } : null, diskState: disk, runErr, codeHash: codeHash().slice(0, 16) };
}

let realEv = null, realErr = null;
try { realEv = { control: await runCase(false), failFirst: await runCase(true) }; }
catch (e) { realErr = String(e && e.message || e); }

console.log("SENDFAIL-GATE-EVIDENCE " + JSON.stringify(realEv ? {
  control: { replied: realEv.control.stats && realEv.control.stats.replied, sendAttempts: realEv.control.counters.sendAttempts },
  failFirst: { replied: realEv.failFirst.stats && realEv.failFirst.stats.replied, sendAttempts: realEv.failFirst.counters.sendAttempts, sendFailed: realEv.failFirst.counters.sendFailed },
  codeHash: realEv.control.codeHash
} : { err: realErr }));

// Named checks on the real evidence.
let checksPass = 0;
const realChecks = checksFor(realEv);
for (const [name, pass] of realChecks) { if (pass) checksPass += 1; else console.log("  FAIL " + name); }
let realAccepted = false;
try { assertSendfailEv(realEv); realAccepted = true; } catch { realAccepted = false; }

const total = realChecks.length;
const allGood = teethOk === teeth.length && checksPass === total && realAccepted && !realErr && !GREENWASH;
console.log((allGood ? "SENDFAIL-GATE-OK" : "SENDFAIL-GATE-FAIL") + " checks=" + checksPass + "/" + total + " teeth=" + teethOk + "/" + teeth.length + (GREENWASH ? " greenwash=on" : "") + (realErr ? " realErr=" + realErr.slice(0, 120) : ""));
process.exit(allGood ? 0 : 1);
