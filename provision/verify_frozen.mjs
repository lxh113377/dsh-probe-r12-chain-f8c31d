#!/usr/bin/env node
// provision/verify_frozen.mjs — BYTE-FROZEN 包逐文件字节冻结校验（fail-closed，#47 / #44 D10.2）
// WHY: P5 缺口① —— README.md:60 的 scp -r 推包后，远端没有任何逐文件复算 sha 并与封印比对的判据；
// 全 server-deploy/ 对 sha256sum|MANIFEST-VERIFY 零命中；r16 权威清单又不在随包 24 件内（scp 带不过去）。
// 本件把封印做成随 provision/ 走、可被远端 sha256sum -c 或本件直接消费的机器闸，弥合该缺口。
// HOW: 读 MANIFEST.sha256（24 行 "64hex  文件名"，sha256sum -c 兼容格式），对目标目录逐文件实算 sha256，
// 双向 fail-closed：期望文件缺 / 哈希漂移 / 多出未登记文件，任一即 FAIL(rc=1)。
// --selftest 用内存副本做 改一字节 / 加一文件 / 删一文件 三负控，证明闸门有牙（不是恒绿）。
// import-safe：导出纯函数 verify()，顶层不 process.exit；父级可独立复跑（Round 3 达标闸的教训）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(HERE, "MANIFEST.sha256");

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

// parseManifest 只认 "64hex + 两空格 + 文件名" 的 sha256sum -c 可消费格式，畸形即抛（不静默吞）。
export function parseManifest(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!m) throw new Error("MANIFEST_MALFORMED: " + line.slice(0, 80));
    rows.push({ hash: m[1], name: m[2] });
  }
  return rows;
}

// verify 是纯函数：不读时钟、不联网、不读环境；files = Map<name, Buffer> 全部由调用方注入，负控可精确复现。
export function verify(files, manifestText) {
  const failures = [];
  const rows = parseManifest(manifestText);
  const expected = new Map(rows.map((r) => [r.name, r.hash]));
  const seen = new Set();
  for (const [name, buf] of files) {
    if (!expected.has(name)) { failures.push("UNEXPECTED_FILE:" + name); continue; }
    seen.add(name);
    if (sha256(buf) !== expected.get(name)) failures.push("HASH_MISMATCH:" + name);
  }
  for (const r of rows) if (!seen.has(r.name)) failures.push("MISSING_FILE:" + r.name);
  return { ok: failures.length === 0, count: rows.length, failures };
}

// readDir 把真实目录 readdir 成 Map<name, Buffer>（只读一层普通文件，跳过子目录）。
export function readDir(dir) {
  const out = new Map();
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isFile()) out.set(n, fs.readFileSync(p));
  }
  return out;
}

function selftest() {
  const cases = [];
  const manifest = fs.readFileSync(DEFAULT_MANIFEST, "utf8");
  const pkg = path.join(HERE, "..", "server-deploy");
  const green = verify(readDir(pkg), manifest);
  cases.push({ name: "GREEN_FROZEN", ok: green.ok && green.count === 24 });
  // 负控 1：改 bot.mjs 一字节（哈希漂移）——只在内存副本上改，不碰磁盘。
  const mut = readDir(pkg); const b = Buffer.from(mut.get("bot.mjs")); b[0] = b[0] ^ 0x01; mut.set("bot.mjs", b);
  const r1 = verify(mut, manifest);
  cases.push({ name: "MUTATED_BYTE_FAILS", ok: !r1.ok && r1.failures.includes("HASH_MISMATCH:bot.mjs") });
  // 负控 2：塞一个未登记文件（双向 fail-closed 的"多"向）。
  const extra = readDir(pkg); extra.set("INJECTED.txt", Buffer.from("x"));
  const r2 = verify(extra, manifest);
  cases.push({ name: "EXTRA_FILE_FAILS", ok: !r2.ok && r2.failures.includes("UNEXPECTED_FILE:INJECTED.txt") });
  // 负控 3：删一个期望文件（"缺"向）。
  const miss = readDir(pkg); miss.delete("deploy.sh");
  const r3 = verify(miss, manifest);
  cases.push({ name: "MISSING_FILE_FAILS", ok: !r3.ok && r3.failures.includes("MISSING_FILE:deploy.sh") });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log("SELFTEST " + (c.ok ? "OK  " : "FAIL") + " " + c.name);
  console.log("MANIFEST-SELFTEST-" + (bad.length === 0 ? "OK" : "FAIL") + " cases=" + cases.length + " teeth=" + (cases.length - 1 - bad.length));
  return bad.length === 0;
}

async function main() {
  if (process.argv.slice(2).includes("--selftest")) return selftest() ? 0 : 1;
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const pkg = args[0] || path.join(HERE, "..", "server-deploy");
  // W1 修复（round 10）：args[1] 是编排层传入的清单路径，必须真正消费；
  // 此前只读 DEFAULT_MANIFEST，换清单会被静默忽略（P19 W1_DEAD_MANIFEST_ARG）。
  const manifestPath = args[1] || DEFAULT_MANIFEST;
  let manifestText;
  try { manifestText = fs.readFileSync(manifestPath, "utf8"); }
  catch (e) { console.log("MANIFEST-VERIFY-FAIL no_manifest " + String(e.message)); return 1; }
  let files;
  try { files = readDir(pkg); }
  catch (e) { console.log("MANIFEST-VERIFY-FAIL unreadable_pkg " + String(e.message)); return 1; }
  const r = verify(files, manifestText);
  const seal = sha256(Buffer.from(manifestText)).slice(0, 12);
  if (r.ok) { console.log("MANIFEST-VERIFY-OK n=" + r.count + " seal=" + seal + " dir=" + pkg); return 0; }
  console.log("MANIFEST-VERIFY-FAIL n=" + r.count + " seal=" + seal + " failures=" + r.failures.slice(0, 8).join(","));
  return 1;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked) {
  const rc = await main();
  process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc;
}
