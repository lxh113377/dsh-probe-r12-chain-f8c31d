#!/usr/bin/env node
// reboot_acceptance_gate.mjs — "关电脑也能正常使用" 的 fail-closed 达标闸（#47）
// WHY: 该结论只能由「真实 reboot + 非本机常开主机 + 带外关机证据」共同证成；
// 本机 WSL2 / 127.0.0.1 / 假 token / hermetic mock 的离线全绿一律不算数。
// 本件把达标拆成 C1–C10 分组判据（含 C2b/C3b 私网加严）：缺证据 => NOT_PROVEN(rc=2)，证据错 => FAIL(rc=1)，
// 全过才 PASS(rc=0)。它只判定，不部署（部署见 server-deploy/deploy.sh）。
// HOW: CLI 从环境读目标主机与健康 URL，fetch 一次 /_health，交给纯函数 judge() 逐条比对；
// --selftest 用合成 health 注入，对每条判据做消融负控，证明闸门有牙（#44 D10.2）。
// D10.2 现场修正：bot.mjs:385 的 ts 是 ISO 8601 字符串、deploy.sh:153 的 RESTART_TS
// 是 epoch 秒；早期版本直接 Number(iso)=NaN 让 freshness 恒红（判据没对准真物）。
// 现用 toUnixSec() 统一归一到秒，并让 selftest 的 GREEN 用 bot.mjs 同款 ISO ts。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRoutableHost } from "../provision/public_host_guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_BOT = path.join(HERE, "..", "server-deploy", "bot.mjs");
// DECL = "证据缺失"类，判 NOT_PROVEN；其余为"证据存在但错"，判 FAIL。
const DECL = new Set(["NO_TARGET_HOST", "NO_HEALTH_URL", "NO_EXPECT_HASH", "NO_LOCAL_BOT", "NO_REBOOT_WINDOW", "NO_PC_OFF_ATTESTATION"]);

function sha256(file) {
  // 读冻结包本体算期望 sha，杜绝调用方自己编一个 hash 来骗过判据。
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// toUnixSec 把 /_health 的 ts（bot.mjs:385 是 ISO 字符串）与 reboot 窗口戳
// （deploy.sh:153 是 date +%s 的 epoch 秒）统一到 Unix 秒，消掉类型错配。
// 数字 >1e11 视作毫秒；字符串先 Date.parse，失败再退回纯数字；不可解析返回 NaN。
function toUnixSec(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? v / 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n / 1000;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) return num > 1e11 ? num / 1000 : num;
  }
  return NaN;
}

// judge 是纯函数：不读时钟、不联网、不读环境，全部输入由调用方注入，负控可精确复现。
export function judge(o) {
  const f = [];
  const need = (ok, code) => { if (!ok) f.push(code); };
  const host = String(o.host || "").trim();
  const url = String(o.url || "").trim();
  // C1 目标主机已声明
  need(host.length > 0, "NO_TARGET_HOST");
  // C2 非本机回环：WSL2/127.0.0.1 的 green 不算"服务器上"
  need(!/^(127[.]|::1$|localhost$|0[.]0[.]0[.]0$)/i.test(host), "HOST_IS_LOOPBACK");
  // C2b 公网可路由字面加严（P13 round6 + P16 两次独立点名）：原 C2 只挡回环，
  // 10.134.65.165 / 192.168.x / 172.16-31.x / 100.64.x / fc00:: 等「非回环但私网」
  // 字面会被放行骗绿。分类器只加严、让更多声明翻红，绝不推进 PASS。
  need(isRoutableHost(host), "HOST_NOT_PUBLIC_ROUTABLE");
  // C3 健康 URL 已声明、可解析、主机名非回环
  need(url.length > 0, "NO_HEALTH_URL");
  let parsed = null;
  try { parsed = new URL(url); } catch (e) { parsed = null; }
  need(!!parsed, "HEALTH_URL_MALFORMED");
  if (parsed) need(!/^(127[.]|::1$|localhost$)/i.test(parsed.hostname), "HEALTH_URL_LOOPBACK");
  if (parsed) need(isRoutableHost(parsed.hostname), "HEALTH_URL_NOT_PUBLIC_ROUTABLE");
  // C4 期望 codeHash 必须等于本机 BYTE-FROZEN bot.mjs 的实算 sha
  const expect = String(o.expectHash || "").trim();
  need(/^[0-9a-f]{64}$/.test(expect), "NO_EXPECT_HASH");
  let localHash = null;
  try { localHash = sha256(LOCAL_BOT); } catch (e) { localHash = null; }
  need(!!localHash, "NO_LOCAL_BOT");
  need(!!localHash && expect === localHash, "EXPECT_HASH_NOT_FROZEN_PACKAGE");
  // C5 reboot 窗口：后戳严格晚于前戳，且 health.ts 晚于后戳（防重启前陈旧残留冒充）
  const before = toUnixSec(o.rebootBefore);
  const after = toUnixSec(o.rebootAfter);
  need(Number.isFinite(before) && Number.isFinite(after) && after > before, "NO_REBOOT_WINDOW");
  const ts = toUnixSec(o.health && o.health.ts);
  need(Number.isFinite(ts) && ts >= after, "HEALTH_NOT_FRESH_AFTER_REBOOT");
  // C6 带外关机证据：本机无法自证"PC 已断电"，必须显式声明并给证据路径
  const attested = String(o.pcOffAttested || "") === "1";
  const evidence = String(o.pcOffEvidence || "").trim();
  need(attested && evidence.length > 0, "NO_PC_OFF_ATTESTATION");
  // C7 真的取到 /_health 且是合法对象
  need(o.fetchOk === true, "HEALTH_FETCH_FAILED");
  const h = o.health && typeof o.health === "object" ? o.health : {};
  // C8 service 必须逐字是 dsh-ilink-bot（对齐 verify_health.mjs:31，防别的服务冒充）
  need(h.service === "dsh-ilink-bot", "WRONG_SERVICE");
  // C9 线上 codeHash 与冻结包一致（对齐 verify_health.mjs:32）
  need(h.codeHash === expect, "CODEHASH_MISMATCH");
  // C10 服务健康三件套：status=ok / 不需要重登 / 无 lastError
  need(h.status === "ok", "STATUS_NOT_OK");
  need(h.needsRelogin !== true, "NEEDS_RELOGIN");
  need(!h.lastError, "LAST_ERROR_PRESENT");
  const missing = f.some((c) => DECL.has(c));
  const verdict = f.length === 0 ? "PASS" : (missing ? "NOT_PROVEN" : "FAIL");
  return { verdict: verdict, failures: f };
}

// baseInput 的 health 与 bot.mjs:380-386 的 /_health 响应逐字同构：
// service/status/needsRelogin/uptimeSec/messagesReceived/messagesReplied/
// lastError/codeHash/pid/ts(ISO 字符串)。GREEN 用它证明判据对准真物（D10.2）。
function baseInput() {
  const hash = sha256(LOCAL_BOT);
  return {
    host: "bot.example.com",
    url: "https://bot.example.com/_health",
    expectHash: hash,
    rebootBefore: 1000,
    rebootAfter: 2000,
    pcOffAttested: "1",
    pcOffEvidence: "/out-of-band/pc-power-off-proof.txt",
    fetchOk: true,
    health: {
      status: "ok", service: "dsh-ilink-bot", needsRelogin: false,
      uptimeSec: 500, messagesReceived: 1, messagesReplied: 1,
      lastError: null, codeHash: hash, pid: 4242,
      ts: new Date(2500 * 1000).toISOString(),
    },
  };
}

function selftest() {
  const cases = [];
  const green = judge(baseInput());
  cases.push({ name: "GREEN_ISO_TS", ok: green.verdict === "PASS", verdict: green.verdict });
  // 恒绿/恒红负控：全绿输入不得含任何失败码；全空输入必须 NOT_PROVEN 且带多个 DECL 码。
  const empty = judge({});
  cases.push({ name: "EMPTY_NOT_PROVEN", ok: empty.verdict === "NOT_PROVEN" && empty.failures.filter((c) => DECL.has(c)).length >= 4, verdict: empty.verdict });
  // 真物形状正控：直接照抄 bot.mjs:380-386 的字段集，确认判据认得它（不是只认合成瘦对象）。
  const realShape = baseInput();
  const rs = judge(realShape);
  cases.push({ name: "REAL_HEALTH_SHAPE", ok: rs.verdict === "PASS" && realShape.health.ts.indexOf("T") > 0, verdict: rs.verdict });
  // 数字 epoch ts 也须接受（兼容别的实现返回毫秒/秒数字）。
  const numTs = baseInput(); numTs.health.ts = 2500;
  cases.push({ name: "NUMERIC_TS_ACCEPTED", ok: judge(numTs).verdict === "PASS", verdict: judge(numTs).verdict });
  const muts = [
    ["NO_TARGET_HOST", (o) => { o.host = ""; }],
    ["HOST_IS_LOOPBACK", (o) => { o.host = "127.0.0.1"; }],
    ["NO_HEALTH_URL", (o) => { o.url = ""; }],
    ["HEALTH_URL_MALFORMED", (o) => { o.url = "not-a-url"; }],
    ["HEALTH_URL_LOOPBACK", (o) => { o.url = "http://127.0.0.1/_health"; }],
    ["NO_EXPECT_HASH", (o) => { o.expectHash = ""; }],
    ["EXPECT_HASH_NOT_FROZEN_PACKAGE", (o) => { o.expectHash = "0".repeat(64); }],
    ["NO_REBOOT_WINDOW", (o) => { o.rebootAfter = 1000; }],
    ["HEALTH_NOT_FRESH_AFTER_REBOOT", (o) => { o.health.ts = new Date(1500 * 1000).toISOString(); }],
    ["TS_UNPARSEABLE", (o) => { o.health.ts = "not-a-date"; }],
    ["NO_PC_OFF_ATTESTATION", (o) => { o.pcOffAttested = ""; }],
    ["HEALTH_FETCH_FAILED", (o) => { o.fetchOk = false; }],
    ["WRONG_SERVICE", (o) => { o.health.service = "other"; }],
    ["CODEHASH_MISMATCH", (o) => { o.health.codeHash = "0".repeat(64); }],
    ["STATUS_NOT_OK", (o) => { o.health.status = "degraded"; }],
    ["NEEDS_RELOGIN", (o) => { o.health.needsRelogin = true; }],
    ["LAST_ERROR_PRESENT", (o) => { o.health.lastError = "egress blackhole"; }],
    ["HOST_NOT_PUBLIC_ROUTABLE", (o) => { o.host = "10.134.65.165"; }],
    ["HEALTH_URL_NOT_PUBLIC_ROUTABLE", (o) => { o.url = "https://192.168.1.10/_health"; }],
  ];
  // TS_UNPARSEABLE 的期望失败码是 HEALTH_NOT_FRESH_AFTER_REBOOT（NaN 不 fresh），单独映射。
  const expectCodeOf = (name) => name === "TS_UNPARSEABLE" ? "HEALTH_NOT_FRESH_AFTER_REBOOT" : name;
  for (const [name, mutate] of muts) {
    const code = expectCodeOf(name);
    const o = baseInput();
    mutate(o);
    const r = judge(o);
    // 有牙 = 该码必须出现，且 verdict 绝不可能是 PASS。
    cases.push({ name: name, ok: r.verdict !== "PASS" && r.failures.includes(code), verdict: r.verdict });
  }
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log("SELFTEST " + (c.ok ? "OK  " : "FAIL") + " " + c.name + " verdict=" + c.verdict);
  const structural = 4; // GREEN / EMPTY / REAL_HEALTH_SHAPE / NUMERIC_TS
  const teeth = cases.length - structural - bad.length;
  console.log("ACCEPTANCE-SELFTEST-" + (bad.length === 0 ? "OK" : "FAIL") + " cases=" + cases.length + " structural=" + structural + " mutated=" + muts.length + " teeth=" + teeth);
  return bad.length === 0;
}

async function main() {
  if (process.argv.slice(2).includes("--selftest")) return selftest();
  let expect = process.env.DSH_ACCEPT_EXPECT_CODEHASH || "";
  if (!expect) { try { expect = sha256(LOCAL_BOT); } catch (e) { expect = ""; } }
  const o = {
    host: process.env.DSH_ACCEPT_HOST || "",
    url: process.env.DSH_ACCEPT_URL || "",
    expectHash: expect,
    rebootBefore: process.env.DSH_ACCEPT_REBOOT_BEFORE,
    rebootAfter: process.env.DSH_ACCEPT_REBOOT_AFTER,
    pcOffAttested: process.env.DSH_ACCEPT_PC_OFF_ATTESTED || "",
    pcOffEvidence: process.env.DSH_ACCEPT_PC_OFF_EVIDENCE || "",
    fetchOk: false,
    health: null,
  };
  // 只有目标已声明才发一次只读请求；缺证据时根本不联网，直接 NOT_PROVEN。
  if (o.host && o.url) {
    try {
      const r = await fetch(o.url, { signal: AbortSignal.timeout(5000) });
      o.health = await r.json();
      o.fetchOk = r.ok;
    } catch (e) {
      o.fetchOk = false;
      o.fetchError = String(e && e.message ? e.message : e);
    }
  }
  const r = judge(o);
  console.log("ACCEPTANCE=" + r.verdict + " host=" + (o.host || "(unset)") + " expectHash=" + String(expect).slice(0, 12));
  console.log("FAILURES=" + (r.failures.length ? r.failures.join(",") : "(none)"));
  console.log("NOTE: 离线 green / WSL2 / 127.0.0.1 / 假 token 一律不计入达标；PC 断电须带外证据。");
  return r.verdict === "PASS" ? 0 : (r.verdict === "FAIL" ? 1 : 2);
}

// isMain 守卫：本件被 import 时只暴露 judge()/toUnixSec()，不跑 CLI、不 process.exit，
// 让父级能独立复跑判据（对齐 server-deploy/verify_health.mjs:125-146 的 import-safe 形态）。
// 早期版本顶层无条件 await main() + process.exit()，父级一 import 就被 exit 杀掉 worker，
// 这是 D10.2「判据自身必须可被独立复跑」抓到的真缺陷。用 process.exitCode 让 libuv 收尾。
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isMain = invoked && import.meta.url === invoked;
if (isMain) {
  const rc = await main();
  process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc;
}
export { toUnixSec };
