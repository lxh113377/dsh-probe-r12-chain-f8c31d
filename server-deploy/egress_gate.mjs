// server-deploy/egress_gate.mjs
// r8 G9: the [6/6] ONLINE outbound-egress signal for deploy.sh, plus its
// offline judge self-test (run in the dev verify chain, NOT a [2/6] gate).
// WHY: verify_health.mjs judges the PROCESS (/_health) only. On a host whose
// outbound TCP to iLink is a blackhole (connection accepted, never answers),
// bot.mjs getUpdates swallows the client-side timeout as a pseudo-success
// {ret:0,msgs:[]}, so runService clears lastError and keeps status=ok. The
// /_health therefore looks healthy while ZERO messages can ever arrive, and
// verify_health.mjs --url ACCEPTS it (reproduced by
// _goal-autochat/r8_checkurl_probe.mjs: blackhole_cli=ACCEPTED). deploy.sh
// [6/6] used to print DEPLOY-OK on such a dead host.
// FIX: [6/6] now ALSO requires a real outbound HTTP round-trip to the
// NON-long-poll iLink getconfig endpoint. It DELIBERATELY sends a fake token,
// so the ONLY correct answer is an explicit iLink rejection (nonzero
// errcode/ret). getconfig is used, NOT getupdates (35s long-poll, eats the
// message buffer with a real token). This module is INDEPENDENT of bot.mjs
// (raw fetch only): a bot bug cannot mask an egress failure. Blackhole,
// zero-egress, captive HTML, 5xx, and a mock that returns {errcode:0} all
// THROW = fail closed (r8 subagent FG-9 / #39: no weaker fix accepted).
//
//   node egress_gate.mjs --selftest      -> EGRESS-GATE-OK ...   (judge self-test, dev chain)
//   EGRESS_GATE_GREENWASH=1 ... --selftest -> EGRESS-GATE-FAIL exit 1
//   node egress_gate.mjs --live          -> EGRESS-OK reached_real_endpoint=true  ([6/6])
//   DSH_EGRESS_HOST=http://127.0.0.1:1/ node egress_gate.mjs --live -> EGRESS-FAIL exit 1
//
// Self-contained: node builtins only. --selftest uses injected transport
// (deterministic, no sockets, no network); --live exercises the real global
// fetch path against the real endpoint. No token, WeChat, GUI.

import { pathToFileURL } from "node:url";

const GREENWASH = process.env.EGRESS_GATE_GREENWASH === "1";
const DEFAULT_HOST = "https://ilinkai.weixin.qq.com/";

function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132102",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from("1234").toString("base64"),
    "Authorization": "Bearer faketoken-not-real"
  };
}

function buildBody() {
  return JSON.stringify({
    base_info: { channel_version: "2.4.6", bot_agent: "DeepSeekHarness/1.1.0" },
    ilink_user_id: ""
  });
}

// The REAL production path. Uses a setTimeout-based AbortController timer
// (NOT AbortSignal.timeout, which is unref in Node and lets the event loop
// exit with an unsettled await on a blackhole, exactly as
// r8_egress_contrast_probe.mjs first hit). Any timeout, transport error,
// empty body, or unrecognized body THROWS so egress is NOT confirmed.
export async function confirmEgress(opts) {
  const o = opts || {};
  const host = o.host || process.env.DSH_EGRESS_HOST || DEFAULT_HOST;
  const timeoutMs = o.timeoutMs || 15000;
  const fetchImpl = o.fetchImpl || fetch;
  const url = new URL("ilink/bot/getconfig", host).toString();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(function () { timedOut = true; ctl.abort(); }, timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url, { method: "POST", headers: buildHeaders(), body: buildBody(), signal: ctl.signal });
    if (!r || typeof r.status !== "number") throw new Error("no-http-response");
    const text = await r.text();
    if (timedOut) throw new Error("timeout-blackhole");
    if (r.status < 200 || r.status >= 300) throw new Error("http-status-" + r.status);
    if (typeof text !== "string" || text.length === 0) throw new Error("empty-response-body");
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!j || typeof j !== "object") throw new Error("unrecognized-response-body");
    // We DELIBERATELY send a fake token. The only correct iLink answer is an
    // explicit rejection (nonzero errcode/ret). A 0/"0" code, or no provider
    // code at all, means a mock/MITM/captive is pretending to be iLink: fail
    // closed. This strictly dominates probe_live.mjs / independent_probe.mjs
    // which print OK without checking the response (r8 subagent FG-9).
    const code = j.errcode !== undefined ? j.errcode : j.ret;
    if (code === undefined) throw new Error("no-provider-rejection-code");
    if (code === 0 || code === "0" || Number(code) === 0) throw new Error("provider-accepted-fake-token");
    return { ok: true, status: r.status, ms: Date.now() - t0, body: text.slice(0, 200) };
  } catch (e) {
    const why = timedOut ? "timeout-blackhole" : (e && e.message ? e.message : String(e));
    throw new Error("egress-unreachable: " + why);
  } finally {
    clearTimeout(timer);
  }
}

// Pure judge over the selftest evidence. GREENWASH makes it a liar (returns
// true unconditionally) so the gate self-reports FAIL when forced green.
export function checksFor(ev) {
  return [
    ["C1_answered_accepted", ev.answered === "ok"],
    ["C2_blackhole_rejected", ev.blackhole === "rejected"],
    ["C3_noegress_rejected", ev.noEgress === "rejected"],
    ["C4_captive_rejected", ev.captive === "rejected"],
    ["C5_refd_timeout_fired", /timeout-blackhole/.test(ev.blackholeReason || "")],
    ["C6_fakeok_rejected", ev.fakeok === "rejected"],
    ["C7_http5xx_rejected", ev.http5xx === "rejected"]
  ];
}

export function assertEgressEv(ev) {
  if (GREENWASH) return true;
  for (const c of checksFor(ev)) if (!c[1]) throw new Error(c[0]);
  return true;
}

// Injected transport for the offline selftest: four shapes, no real sockets,
// no network. The blackhole shape rejects only when the confirmEgress timer
// aborts the signal, so the REAL timeout mechanism is what rejects it.
function shapeFetch(shape) {
  return async function (url, o) {
    if (shape === "answered") {
      return { status: 200, text: async () => JSON.stringify({ errcode: -14, errmsg: "session timeout" }) };
    }
    if (shape === "captive") {
      return { status: 200, text: async () => "<html>captive portal</html>" };
    }
    if (shape === "noEgress") {
      throw new Error("fetch failed");
    }
    if (shape === "fakeok") {
      return { status: 200, text: async () => JSON.stringify({ errcode: 0, errmsg: "ok" }) };
    }
    if (shape === "http5xx") {
      return { status: 500, text: async () => JSON.stringify({ errcode: -14 }) };
    }
    if (shape === "blackhole") {
      return await new Promise(function (resolve, reject) {
        const s = o && o.signal;
        if (!s) { reject(new Error("no-signal")); return; }
        s.addEventListener("abort", function () { reject(new Error("aborted")); }, { once: true });
      });
    }
    throw new Error("unknown-shape");
  };
}

async function runShape(shape) {
  try {
    const r = await confirmEgress({ host: "http://shape.invalid/", timeoutMs: 250, fetchImpl: shapeFetch(shape) });
    return { outcome: "ok", reason: "", body: r.body };
  } catch (e) {
    return { outcome: "rejected", reason: (e && e.message) || String(e), body: "" };
  }
}

const negatives = [];
function neg(name, ev) {
  let rejected = false;
  try { assertEgressEv(ev); } catch (e) { rejected = true; }
  negatives.push({ name: name, rejected: rejected });
}

async function selftest() {
  const a = await runShape("answered");
  const b = await runShape("blackhole");
  const c = await runShape("noEgress");
  const d = await runShape("captive");
  const e = await runShape("fakeok");
  const f = await runShape("http5xx");
  const ev = {
    answered: a.outcome, blackhole: b.outcome, noEgress: c.outcome,
    captive: d.outcome, fakeok: e.outcome, http5xx: f.outcome,
    blackholeReason: b.reason, fakeokReason: e.reason, http5xxReason: f.reason
  };
  console.log("EGRESS-GATE-EVIDENCE " + JSON.stringify(ev));

  neg("M1_answered_rejected", Object.assign({}, ev, { answered: "rejected" }));
  neg("M2_blackhole_ok", Object.assign({}, ev, { blackhole: "ok" }));
  neg("M3_noegress_ok", Object.assign({}, ev, { noEgress: "ok" }));
  neg("M4_captive_ok", Object.assign({}, ev, { captive: "ok" }));
  neg("M5_no_refd_timeout", Object.assign({}, ev, { blackholeReason: "network-error" }));
  neg("M6_fakeok_ok", Object.assign({}, ev, { fakeok: "ok" }));
  neg("M7_http5xx_ok", Object.assign({}, ev, { http5xx: "ok" }));

  const checks = checksFor(ev);
  checks.filter(c => !c[1]).forEach(c => console.log("  FAIL " + c[0]));
  negatives.filter(n => !n.rejected).forEach(n => console.log("  NEG-NOT-REJECTED " + n.name));
  let judgeOk = true;
  try { assertEgressEv(ev); } catch (e) { judgeOk = false; }
  const passed = checks.filter(c => c[1]).length;
  const negPassed = negatives.filter(n => n.rejected).length;
  const allGood = judgeOk && passed === checks.length && negPassed === negatives.length && !GREENWASH;
  console.log((allGood ? "EGRESS-GATE-OK" : "EGRESS-GATE-FAIL")
    + " checks=" + passed + "/" + checks.length
    + " teeth=" + negPassed + "/" + negatives.length
    + (GREENWASH ? " greenwash=on" : ""));
  process.exitCode = allGood ? 0 : 1;
}

async function live() {
  try {
    const r = await confirmEgress({});
    console.log("EGRESS-OK reached_real_endpoint=true pure_http=true status=" + r.status + " ms=" + r.ms + " body=" + r.body);
    process.exitCode = 0;
  } catch (e) {
    console.log("EGRESS-FAIL " + (e && e.message));
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked) {
  const mode = process.argv[2] || "--selftest";
  if (mode === "--live") await live();
  else await selftest();
}
