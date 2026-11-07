#!/usr/bin/env node
// provision/check_health.mjs — /_health 响应 fail-closed 判据（#47 / #44 D10.2）
// WHY: 公网 /_health 是 P5 缺口③的确切缺口；把健康判定做成可独立复跑的纯函数，
// 不靠 bash 内联 grep 猜 JSON 形状。对齐 bot.mjs:380-386 真实字段与 verify_health.mjs:28-42 五判。
// HOW: stdin 读 JSON，argv[2] 传 BYTE-FROZEN 期望 sha；service/status/needsRelogin/lastError/codeHash 全过才 exit0。
// --selftest 用真物形状 + 五消融负控证明有牙；import-safe（导出 judgeHealth，顶层不 exit）。
import { fileURLToPath, pathToFileURL } from "node:url";

const FROZEN = "9f4138c534582e583a5de27e3de68950ad6f6b5881947aacee82aa77aff3c268";

export function judgeHealth(h, expect) {
  const f = [];
  if (!h || typeof h !== "object") return { ok: false, failures: ["NOT_OBJECT"] };
  if (h.service !== "dsh-ilink-bot") f.push("WRONG_SERVICE");
  if (h.status !== "ok") f.push("STATUS_NOT_OK");
  if (h.needsRelogin === true) f.push("NEEDS_RELOGIN");
  if (h.lastError) f.push("LAST_ERROR_PRESENT");
  if (h.codeHash !== expect) f.push("CODEHASH_MISMATCH");
  return { ok: f.length === 0, failures: f, codeHash: h.codeHash || "" };
}

function realShape() {
  return { status: "ok", service: "dsh-ilink-bot", needsRelogin: false, uptimeSec: 5,
    messagesReceived: 1, messagesReplied: 1, lastError: null, codeHash: FROZEN, pid: 1,
    ts: new Date().toISOString() };
}

function selftest() {
  const muts = [
    ["WRONG_SERVICE", (o) => { o.service = "other"; }],
    ["STATUS_NOT_OK", (o) => { o.status = "degraded"; }],
    ["NEEDS_RELOGIN", (o) => { o.needsRelogin = true; }],
    ["LAST_ERROR_PRESENT", (o) => { o.lastError = "egress blackhole"; }],
    ["CODEHASH_MISMATCH", (o) => { o.codeHash = "0".repeat(64); }],
  ];
  const cases = [{ name: "GREEN", ok: judgeHealth(realShape(), FROZEN).ok }];
  for (const [name, mutate] of muts) {
    const o = realShape(); mutate(o);
    const r = judgeHealth(o, FROZEN);
    cases.push({ name, ok: !r.ok && r.failures.includes(name) });
  }
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log("SELFTEST " + (c.ok ? "OK  " : "FAIL") + " " + c.name);
  console.log("HEALTH-SELFTEST-" + (bad.length === 0 ? "OK" : "FAIL") + " cases=" + cases.length + " teeth=" + (muts.length - bad.length));
  return bad.length === 0;
}

async function main() {
  if (process.argv.slice(2).includes("--selftest")) return selftest() ? 0 : 1;
  const expect = process.argv[2] || FROZEN;
  let s = "";
  for await (const c of process.stdin) s += c;
  let h; try { h = JSON.parse(s); } catch (e) { console.log("HEALTH-FAIL NOT_OBJECT"); return 2; }
  const r = judgeHealth(h, expect);
  console.log(r.ok ? "HEALTH-OK codeHash=" + r.codeHash : "HEALTH-FAIL " + r.failures.join(","));
  return r.ok ? 0 : 2;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked) { const rc = await main(); process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc; }
