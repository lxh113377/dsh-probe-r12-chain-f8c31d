#!/usr/bin/env node
// provision/render_config.mjs - 部署期 config.json 渲染器（G5 软件侧补齐 / #47）
// WHY: bot.mjs:281 的 healthHost 完全来自 config.json 的 file.healthHost
//   优先级 overrides > file.healthHost > 兜底 "127.0.0.1"，:417 原样传给 listen。
//   默认 config.example.json:5 = "127.0.0.1"，deploy.sh:89 仅在 config.json 不存在时才复制。
//   所以「公网 /_health 结构性不成立」的准确成因是「默认值 + 无公网路由」，不是代码不支持：
//   部署期预置 config.json 覆盖 healthHost="0.0.0.0" 即绑全网卡，代码零改动、24 件封印不动。
// HOW: render(example, opts) 纯函数——深拷贝 example，只改 healthHost 一个字段，
//   递归剔除凭据键（token 只从 env EnvironmentFile 来，绝不落 config.json），
//   校验目标 host 是合法绑定字面，非法或空 -> ok=false 绝不产出静默 loopback 配置。
//   writeConfig 仅在显式 --out 时以 0644 落盘；默认 dry-run 只回显 JSON 不写文件。
//   --selftest 用真 example 形状 + 5 组负控证明判据有牙（#44 D10.2）。import-safe。

import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

function isDigits(t) {
  if (!t) return false;
  for (let i = 0; i < t.length; i += 1) { const c = t.charCodeAt(i); if (c < 48 || c > 57) return false; }
  return true;
}

function ipv4(s) {
  const p = s.split(".");
  if (p.length !== 4) return null;
  const n = [];
  for (const seg of p) { if (!isDigits(seg)) return null; const v = Number(seg); if (v < 0 || v > 255) return null; n.push(v); }
  return n;
}

// classifyBindHost：纯字符串判定，不用正则（避免反斜杠转义坑），fail-closed。
export function classifyBindHost(h) {
  const s = typeof h === "string" ? h.trim() : "";
  if (!s) return { ok: false, kind: "EMPTY" };
  if (s.indexOf("://") >= 0 || s.indexOf("/") >= 0 || s.indexOf("#") >= 0 ||
      s.indexOf("?") >= 0 || s.indexOf(" ") >= 0) return { ok: false, kind: "NOT_A_HOST_LITERAL" };
  if (s === "0.0.0.0" || s === "::" || s === "[::]") return { ok: true, kind: "WILDCARD", loopback: false };
  if (s === "127.0.0.1" || s === "::1" || s === "localhost") return { ok: true, kind: "LOOPBACK", loopback: true };
  const hasColon = s.indexOf(":") >= 0;
  const hasDot = s.indexOf(".") >= 0;
  if (hasColon && hasDot) return { ok: false, kind: "NOT_A_HOST_LITERAL" };
  if (hasColon) return { ok: true, kind: "IPV6", loopback: false };
  if (hasDot) { const n = ipv4(s); if (!n) return { ok: false, kind: "BAD_IPV4" };
    return { ok: true, kind: "IPV4", loopback: n[0] === 127 }; }
  return { ok: false, kind: "UNKNOWN_HOST_LITERAL" };
}

function isCredentialKey(k) {
  const l = String(k).toLowerCase();
  const keys = ["token", "secret", "password", "passwd", "credential", "api_key", "apikey", "bearer"];
  for (const x of keys) if (l.indexOf(x) >= 0) return true;
  return false;
}

// scrub：递归剔除凭据键；config.json 绝不携带 token（凭据只走 env EnvironmentFile）。
export function scrub(node) {
  if (Array.isArray(node)) return node.map(scrub);
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node)) { if (isCredentialKey(k)) continue; out[k] = scrub(node[k]); }
    return out;
  }
  return node;
}

export function render(example, opts) {
  const o = opts || {};
  const src = example && typeof example === "object" && !Array.isArray(example) ? example : null;
  if (!src) return { ok: false, error: "EXAMPLE_NOT_OBJECT", config: null };
  const cls = classifyBindHost(o.healthHost);
  if (!cls.ok) return { ok: false, error: cls.kind, config: null };
  const cfg = scrub(JSON.parse(JSON.stringify(src)));
  cfg.healthHost = String(o.healthHost).trim();
  return { ok: true, config: cfg, bound: cfg.healthHost, kind: cls.kind, loopback: cls.loopback,
    changedFrom: typeof src.healthHost === "string" ? src.healthHost : "(unset)" };
}

export function writeConfig(outPath, cfg, mode) {
  if (!outPath) return { ok: false, error: "NO_OUT_PATH" };
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2), { mode: mode || 0o644 });
  return { ok: true, path: outPath, bytes: fs.statSync(outPath).size };
}

function selftest() {
  const example = () => ({ _comment: "Copy to config.json on the server. Token MUST come from env.",
    baseUrl: "https://ilinkai.weixin.qq.com/", statePath: "/var/lib/dsh-ilink-bot/state.json",
    healthHost: "127.0.0.1", healthPort: 8787, longPollMs: 35000,
    reply: { rules: [{ match: "ping", reply: "pong (iLink headless bot, running on the server)" }],
      defaultReply: "ok" } });
  const cases = [];
  const add = (name, ok) => cases.push({ name, ok });
  const g = render(example(), { healthHost: "0.0.0.0" });
  add("GREEN_WILDCARD", g.ok && g.bound === "0.0.0.0" && g.changedFrom === "127.0.0.1" && g.loopback === false);
  const ex = example(); render(ex, { healthHost: "0.0.0.0" });
  add("EXAMPLE_UNMUTATED", ex.healthHost === "127.0.0.1");
  add("OTHER_FIELDS_KEPT", g.ok && g.config.statePath === "/var/lib/dsh-ilink-bot/state.json"
    && g.config.healthPort === 8787 && g.config.reply.rules[0].match === "ping" && g.config.longPollMs === 35000);
  const dirty = example(); dirty.token = "ghp_faketoken"; dirty.bot_token = "faketoken";
  const sc = render(dirty, { healthHost: "0.0.0.0" });
  add("CREDENTIALS_SCRUBBED", sc.ok && !("token" in sc.config) && !("bot_token" in sc.config)
    && JSON.stringify(sc.config).indexOf("ghp_") < 0);
  add("NEG_EMPTY_HOST", !render(example(), { healthHost: "" }).ok && !render(example(), {}).ok);
  add("NEG_NOT_HOST_LITERAL", !render(example(), { healthHost: "https://bot.example/_health" }).ok
    && !render(example(), { healthHost: "0.0.0.0:8787" }).ok
    && !render(example(), { healthHost: "999.1.1.1" }).ok);
  const already = example(); already.healthHost = "0.0.0.0";
  const a = render(already, { healthHost: "0.0.0.0" });
  add("NEG_DEFAULT_ASSUMPTION_HAS_TEETH", a.ok && a.changedFrom === "0.0.0.0" && a.bound === "0.0.0.0");
  add("NEG_BAD_EXAMPLE", !render(null, { healthHost: "0.0.0.0" }).ok && !render("x", { healthHost: "0.0.0.0" }).ok);
  const lb = render(example(), { healthHost: "127.0.0.1" });
  add("NEG_LOOPBACK_LABELED", lb.ok && lb.loopback === true && lb.kind === "LOOPBACK");
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log("SELFTEST " + (c.ok ? "OK  " : "FAIL") + " " + c.name);
  console.log("RENDER-CONFIG-SELFTEST-" + (bad.length === 0 ? "OK" : "FAIL")
    + " cases=" + cases.length + " teeth=" + cases.filter((c) => c.name.indexOf("NEG_") === 0).length);
  return bad.length === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest() ? 0 : 1;
  const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ""; };
  const host = arg("--health-host");
  const outPath = arg("--out");
  const exPath = arg("--example");
  let example;
  try {
    const p = exPath || fileURLToPath(new URL("../server-deploy/config.example.json", import.meta.url));
    example = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { console.log("RENDER-CONFIG-FAIL EXAMPLE_UNREADABLE " + e.message); return 2; }
  const r = render(example, { healthHost: host });
  if (!r.ok) { console.log("RENDER-CONFIG-FAIL " + r.error + " (refuse silent loopback config)"); return 2; }
  console.log("RENDER-CONFIG-OK from=" + r.changedFrom + " to=" + r.bound + " kind=" + r.kind + " loopback=" + r.loopback);
  if (outPath) {
    const w = writeConfig(outPath, r.config);
    console.log(w.ok ? "RENDER-CONFIG-WRITE-OK path=" + w.path + " bytes=" + w.bytes : "RENDER-CONFIG-WRITE-FAIL " + w.error);
    return w.ok ? 0 : 2;
  }
  console.log("RENDER-CONFIG-DRYRUN (no --out; config.json NOT written; token never stored)");
  console.log(JSON.stringify(r.config, null, 2));
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked && import.meta.url === invoked) { const rc = await main(); process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc; }
export { selftest };
