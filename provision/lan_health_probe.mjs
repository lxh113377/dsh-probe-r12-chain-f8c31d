#!/usr/bin/env node
// provision/lan_health_probe.mjs - 真 OS 子进程 + 真 TCP 的非回环 /_health 实证（#47 / #44 D10.2）
// KIND=DEV-DRILL NOT-IN-DEPLOY-CHAIN NO-C1-C10-EVIDENCE（round 10 定性，P19 O1 收口）
// 本件只作本机子进程 LAN 绑定面实证，故意不接入 remote-provision.sh 部署链、不生产真机 C1–C10 证据；
// LAN 私网 != 公网可达 != 关电脑还能用，误接进部署链 = #39 折中 / #36 假绿。
// WHY: 证明 bot.mjs 的 /_health 能绑非回环地址、从非回环地址 fetch 回 codeHash
//   == sha256(冻结 bot.mjs)。弥合 P10 G5「公网 /_health」里本机唯一能做实的一环（绑定面）。
//   诚实标注：LAN 可达 != 公网可达 != 关电脑还能用（LAN IP 随 PC 关机消失）。
// HOW: fork 子进程跑真 runService（overrides.healthHost=绑定目标，mock fetch，零 WAN），
//   父进程从非回环 LAN IP fetch /_health，喂既有判据 check_health.mjs 的 judgeHealth
//   判 codeHash（裁决权不另立）。6 组：3 正控 + 3 负控，负控有牙。import-safe。

import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { judgeHealth } from "./check_health.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT = path.join(HERE, "..", "server-deploy", "bot.mjs");
const REAL_HASH = createHash("sha256").update(readFileSync(BOT)).digest("hex");

export function pickLan() {
  const ifs = networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of (ifs[k] || [])) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

if (process.env.DSH_LAN_CHILD === "1") {
  const bind = String(process.env.DSH_LAN_BIND || "127.0.0.1");
  const mod = await import("../server-deploy/bot.mjs");
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.indexOf("getupdates") >= 0) {
      await new Promise((rs) => setTimeout(rs, 50));
      return { ok: true, json: async () => ({ ret: 0, get_updates_buf: "lan-cursor", msgs: [
        { message_id: "lan-1", from_user_id: "lan@im.wechat", create_time_ms: Date.now(),
          context_token: "ctx-lan", item_list: [{ type: 1, text_item: { text: "ping" } }] } ] }) };
    }
    return { ok: true, json: async () => ({ ret: 0 }) };
  };
  await mod.runService(
    { token: "lan-probe-fake-token", baseUrl: "https://ilinkai.weixin.qq.com/",
      statePath: String(process.env.DSH_LAN_STATE), healthPort: 0, healthHost: bind,
      configPath: "/nope" },
    { fetchImpl, fastFail: true,
      logger: { log() {}, error() {}, warn() {} },
      onListen: async (port) => { if (process.send) process.send({ ready: true, port }); } }
  );
  process.exit(0);
}

export function fetchFrom(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/_health", timeout: 3000 }, (res) => {
      let s = ""; res.on("data", (d) => { s += d; });
      res.on("end", () => { try { resolve({ ok: true, json: JSON.parse(s) }); }
        catch (e) { resolve({ ok: false, err: "BAD_JSON" }); } });
    });
    req.on("error", (e) => resolve({ ok: false, err: e.code || e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, err: "TIMEOUT" }); });
  });
}

function startChild(bind) {
  return new Promise((resolve, reject) => {
    const statePath = path.join(tmpdir(), "dsh-lan-probe-" + process.pid + "-"
      + Math.random().toString(16).slice(2) + ".json");
    const child = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, DSH_LAN_CHILD: "1", DSH_LAN_BIND: bind, DSH_LAN_STATE: statePath },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch (e) {}
      if (!settled) { settled = true; reject(new Error("ready timeout")); } }, 8000);
    child.on("message", (m) => { if (m && m.ready && !settled) {
      settled = true; clearTimeout(timer); resolve({ child, port: m.port, statePath }); } });
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("exit", (c) => { if (!settled) { settled = true; clearTimeout(timer);
      reject(new Error("child exited early code=" + c)); } });
  });
}

async function probe(bind, fromHost) {
  const c = await startChild(bind);
  const r = await fetchFrom(fromHost, c.port);
  try { c.child.kill("SIGTERM"); } catch (e) {}
  try { rmSync(c.statePath, { force: true }); } catch (e) {}
  return r;
}

async function main() {
  const lan = pickLan();
  if (!lan) { console.log("LAN-HEALTH-PROBE-FAIL NO_NON_LOOPBACK_IP"); return 2; }
  console.log("LAN-HEALTH-PROBE host=" + lan + " realHash=" + REAL_HASH.slice(0, 12) + "...");
  const cases = [];
  const add = (name, ok, note) => { cases.push({ name, ok });
    console.log((ok ? "OK  " : "FAIL") + " " + name + (note ? " " + note : "")); };
  let allHealth = null;
  for (const pair of [["POS_ALL", "0.0.0.0"], ["POS_LAN", lan]]) {
    const r = await probe(pair[1], lan);
    const j = r.ok ? judgeHealth(r.json, REAL_HASH) : { ok: false, failures: ["FETCH"] };
    if (pair[0] === "POS_ALL" && r.ok) allHealth = r.json;
    add(pair[0], r.ok && j.ok && r.json.codeHash === REAL_HASH,
      "reachable=" + r.ok + " codeHashMatch=" + (r.ok && r.json.codeHash === REAL_HASH));
  }
  const lbSelf = await probe("127.0.0.1", "127.0.0.1");
  add("POS_LOOPBACK_SELF", lbSelf.ok && judgeHealth(lbSelf.json, REAL_HASH).ok, "reachable=" + lbSelf.ok);
  const lbLan = await probe("127.0.0.1", lan);
  add("NEG_LOOPBACK_FROM_LAN_REFUSED", !lbLan.ok && lbLan.err === "ECONNREFUSED", "err=" + String(lbLan.err));
  let jWrong = { ok: true, failures: [] };
  if (allHealth) jWrong = judgeHealth(allHealth, "0".repeat(64));
  add("NEG_CODEHASH_MISMATCH", allHealth !== null && !jWrong.ok && jWrong.failures.includes("CODEHASH_MISMATCH"));
  let jSvc = { ok: true, failures: [] };
  if (allHealth) jSvc = judgeHealth(Object.assign({}, allHealth, { service: "other" }), REAL_HASH);
  add("NEG_WRONG_SERVICE", allHealth !== null && !jSvc.ok && jSvc.failures.includes("WRONG_SERVICE"));
  const bad = cases.filter((c) => !c.ok);
  console.log("LAN-HEALTH-PROBE-" + (bad.length === 0 ? "OK" : "FAIL")
    + " pos=3 neg=3 teeth=3 realHash=" + REAL_HASH.slice(0, 12) + " lan=" + lan);
  if (bad.length) console.log("FAILED=" + bad.map((c) => c.name).join(","));
  return bad.length === 0 ? 0 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked && process.env.DSH_LAN_CHILD !== "1") { const rc = await main(); process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc; }
export { probe, startChild };
