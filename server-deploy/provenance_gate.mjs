// server-deploy/provenance_gate.mjs
// r16 OS-truth provenance gate. Binds the /_health verdict to the process
// systemd JUST restarted, using /proc facts a responder cannot forge.
//
// F4: verify_health.mjs judges codeHash (publicly computable) + status; pid is
// self-reported by whoever holds the port. An out-of-band loopback impostor
// (same sha, forged pid) passed DEPLOY-HEALTH-OK. Numeric health.pid==MainPID
// is ALSO forgeable (the impostor reads MainPID and echoes it), so we never
// compare pids at all.
//
// F2: deriving the endpoint from config.json misses an EnvironmentFile/drop-in
// DSH_ILINK_HEALTH_PORT override => honest false-RED (service 18888, poll 8787).
// F-N2: deriving from env/config passes NaN/0/70000 into the fetch URL.
//
// FIX: discover the endpoint from the OS. systemctl show -p MainPID --value
// on the SYSTEM bus gives the restarted process; /proc/$pid/fd/* lists the
// socket:[inode] it owns; /proc/net/tcp{,6} state=0A LISTEN rows map an inode
// to a local address. The health endpoint MUST be one of those owned inodes.
// A different-socket impostor has a different inode and is never polled. No
// port is ever derived from config/env => F2/F-N2 cannot skew the URL.
//
// H1 (R16-PROVENANCE-DESIGN-2ND): a LISTEN-inode snapshot alone only proves
// MainPID HOLDS a socket; fetch() talks to the accept()-ed ESTABLISHED socket
// (state 01, a DIFFERENT inode) whose server side was never checked. So we
// keep the client socket alive through the response and assert that the
// ESTABLISHED server socket for OUR connection (local port + our ephemeral
// remote port) has an inode owned by MainPID. An SO_REUSEPORT impostor
// accepts on its own inode => not in MainPID fd set => fail-closed. This
// binds the RESPONDER to the process, not just the endpoint, with no bot.mjs
// change (so the r1..r15 codeHash evidence chain stays intact).
//
//   node provenance_gate.mjs --selftest                -> PROVENANCE-SELFTEST-OK  exit 0
//   PROVENANCE_GATE_GREENWASH=1 node ... --selftest     -> ...-FAIL               exit 1
//   node provenance_gate.mjs --check --unit U --prefix P --node N --scope S
//        --since-ts T --expect-port N [--bot-file F]     -> PROVENANCE-OK / -FAIL
//
// Headless: pure HTTP + /proc + systemctl read. No GUI, no WeChat, no token.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
// Single shared port validator: port_gate.mjs and this gate MUST agree on what
// a canonical port is, or a runtime mismatch could be judged green on one side.
import { validPortValue } from './port_gate.mjs';

// N8*: verify_health.mjs captures VERIFY_HEALTH_GREENWASH at MODULE LOAD
// (verify_health.mjs:25) and assertDeployHealth() returns {ok:true} when set -
// a test-only escape hatch. A parent deploy/shell that leaked this var into
// this child would silently wash the five composed health checks green.
// A STATIC import is hoisted and evaluated BEFORE any top-level statement, so
// deleting the env var after it would be too late. Use a DYNAMIC import AFTER
// the delete: verify_health.mjs then re-evaluates with GREENWASH=false and the
// judge keeps its teeth no matter what the caller's environment contained.
// Defence in depth: deploy.sh also strips it (env -u) and check() re-proves
// the teeth behaviourally (composedJudgeHasTeeth) on every real check.
delete process.env.VERIFY_HEALTH_GREENWASH;
const { assertDeployHealth, shaOf } = await import('./verify_health.mjs');

const GREENWASH = process.env.PROVENANCE_GATE_GREENWASH === '1';
const NL = String.fromCharCode(10);

// HOLE 3 (r18 real-integration audit): execFileSync inherits the parent env
// by default. DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/user/1000/bus makes a
// bare `systemctl` resolve to the --user bus, where a same-named unit can
// report a forged MainPID -> bus-confusion fail-open. systemctl falls back to
// its compiled-in SYSTEM bus only when that variable is ABSENT (setting it to
// "" is not enough). systemBusEnv() DELETEs both DBUS keys from a shallow
// copy so the caller's environment is never mutated; check() then calls
// readMainPid() which passes systemctlShowOptions() (env: systemBusEnv()) to
// execFileSync. deploy.sh also strips both vars (defence in depth).
export function systemBusEnv(base) {
  const env = { ...(base === undefined ? process.env : base) };
  delete env.DBUS_SYSTEM_BUS_ADDRESS;
  delete env.DBUS_SESSION_BUS_ADDRESS;
  return env;
}
export function systemctlShowOptions(base) {
  return { encoding: 'utf8', timeout: 8000, env: systemBusEnv(base) };
}
export function readMainPid(unit, run) {
  const fn = run || execFileSync;
  return fn('systemctl', ['show', '-p', 'MainPID', '--value', unit], systemctlShowOptions());
}

// N8*: the composed five-check judge must reject a broken health EVEN IF the
// parent leaked the test-only VERIFY_HEALTH_GREENWASH flag. A fresh child in
// selftest() imports this module and calls this; check() also calls it as a
// behavioural guard (not a string assertion) before trusting any endpoint.
export function composedJudgeHasTeeth() {
  const H = 'a'.repeat(64);
  try { assertDeployHealth({ service: 'dsh-ilink-bot', codeHash: '0'.repeat(64), status: 'ok', needsRelogin: false }, H); return false; }
  catch { return true; }
}

// Freshness (N5 / plan-A step 4): a health reply older than the restart we
// JUST issued is a stale leftover, not this deploy. sinceTs is captured by
// deploy.sh [5/6] BEFORE systemctl restart. Missing/unparseable ts is
// fail-closed when sinceTs>0 (do not silently accept an absent ts).
export function healthNotStale(h, sinceTs) {
  if (!(sinceTs > 0)) return true;
  const t = Date.parse(h && h.ts ? h.ts : '') / 1000;
  if (!Number.isFinite(t)) return false;
  return t >= sinceTs - 2;
}

// C3 (R16-C23-AUDIT H3): a real --check MUST carry a canonical positive
// integer --since-ts. Number(v)>0 alone accepts 1e3/0x50/' 123 '/1.5, which
// would make healthNotStale silently fail-open again. Strict decimal only;
// callers that omit it are refused before any endpoint is trusted.
export function requireSinceTs(v) {
  const s = String(v == null ? '' : v);
  const n = Number(s);
  if (!/^[0-9]+$/.test(s) || String(n) !== s || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error('--since-ts missing/invalid (need canonical positive integer seconds) - fail-closed');
  }
  return n;
}

// r17 managed-only: --expect-port is MANDATORY (F1). A bare --check with no
// --expect-port used to return null here and silently skip the whole runtime
// assertion => false-GREEN. Now it throws before any endpoint is trusted.
// When given it must be a canonical port (shared validator with port_gate.mjs)
// and check() asserts the OS-discovered MainPID-owned LISTEN endpoint is on
// that exact port. ANY untracked source (stray drop-in / manager env /
// DefaultEnvironment / glob) that moved the real socket elsewhere => runtime
// mismatch => fail-closed. Capstone N4/IMPOSTOR/GW negatives still die earlier
// (:313/:321/:295), so their specific MSG assertions stay intact.
export function requireExpectPort(v) {
  // F1 (R17-CONVERGENCE-2ND): MANDATORY. A missing/empty value used to return
  // null, which silently disabled the whole r17 runtime assertion and let a
  // bare --check print PROVENANCE-OK with zero port binding (false-GREEN).
  // Same-shape fix as requireSinceTs: refuse instead of fail-open.
  if (v === undefined || v === null || v === '') throw new Error('--expect-port missing (mandatory) - fail-closed');
  if (!validPortValue(v)) throw new Error('--expect-port invalid (need canonical decimal 1..65535) - fail-closed');
  return Number(v);
}
export function filterByExpectPort(eps, expectPort) {
  // No caller may pass null any more (requireExpectPort never returns it). A
  // refactor that reintroduces a null path must fail closed, not unfiltered.
  if (expectPort === null || expectPort === undefined) throw new Error('expectPort missing - fail-closed');
  return eps.filter((e) => e.port === expectPort);
}

// ---------- pure helpers (selftestable with no /proc) ----------

// systemctl show -p MainPID --value -> 12345 | 0 | empty | multi-value.
// Fail-closed: anything not a single positive safe integer becomes 0 (reject).
export function parseMainPid(out) {
  const s = String(out == null ? '' : out).trim();
  if (s.length === 0) return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== s) return 0;
  return n;
}

function isDigits(s) {
  if (s.length === 0) return false;
  for (const ch of s) if (ch < '0' || ch > '9') return false;
  return true;
}
function hexPort(h) {
  if (h.length === 0) return 0;
  const p = parseInt(h, 16);
  return Number.isSafeInteger(p) && p > 0 && p <= 65535 ? p : 0;
}
function isHex(s, len) {
  if (s.length !== len) return false;
  for (const ch of s) {
    if (!((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F') || (ch >= 'a' && ch <= 'f'))) return false;
  }
  return true;
}
function ipv4FromHex(h) {
  if (!isHex(h, 8)) return null;
  const n = parseInt(h, 16);
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
}
function ipv6FromHex(h) {
  if (!isHex(h, 32)) return null;
  const b = [];
  for (let i = 0; i < 4; i++) {
    const w = parseInt(h.slice(i * 8, i * 8 + 8), 16);
    b.push(w & 255, (w >> 8) & 255, (w >> 16) & 255, (w >>> 24) & 255);
  }
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
  return '[' + g.join(':') + ']';
}

// /proc/net/tcp{,6}: sl local rem st ... inode. state 0A = LISTEN.
export function parseListenEntries(text, isV6) {
  const out = [];
  const lines = String(text == null ? '' : text).split(NL);
  for (let li = 1; li < lines.length; li++) {
    const c = lines[li].trim().split(' ').filter(Boolean);
    if (c.length < 10) continue;
    if (c[3] !== '0A') continue;
    const la = c[1].split(':');
    if (la.length !== 2) continue;
    const port = hexPort(la[1]);
    if (!port) continue;
    const host = isV6 ? ipv6FromHex(la[0]) : ipv4FromHex(la[0]);
    if (!host) continue;
    const inode = c[9];
    if (!isDigits(inode)) continue;
    out.push({ host, port, inode });
  }
  return out;
}

// /proc/net/tcp{,6} ESTABLISHED rows (state 01): the server side of an
// accepted connection. The inode here is NOT the LISTEN inode; it is the
// accepted socket, held as an fd by whoever called accept() (the responder).
export function parseEstablishedEntries(text, isV6) {
  const out = [];
  const lines = String(text == null ? '' : text).split(NL);
  for (let li = 1; li < lines.length; li++) {
    const c = lines[li].trim().split(' ').filter(Boolean);
    if (c.length < 10) continue;
    if (c[3] !== '01') continue;
    const la = c[1].split(':'), ra = c[2].split(':');
    if (la.length !== 2 || ra.length !== 2) continue;
    const localPort = hexPort(la[1]), remPort = hexPort(ra[1]);
    if (!localPort || !remPort) continue;
    const localHost = isV6 ? ipv6FromHex(la[0]) : ipv4FromHex(la[0]);
    const remHost = isV6 ? ipv6FromHex(ra[0]) : ipv4FromHex(ra[0]);
    if (!localHost || !remHost) continue;
    const inode = c[9];
    if (!isDigits(inode)) continue;
    out.push({ localHost, localPort, remHost, remPort, inode });
  }
  return out;
}

// Was OUR request (identified by its ephemeral client port) served by a
// socket whose inode is owned by MainPID? This is the H1 responder binding.
export function responderBound(rows, inodeSet, ep, clientPort) {
  if (!(clientPort > 0)) return false;
  for (const r of rows) {
    if (r.localPort !== ep.port || r.remPort !== clientPort) continue;
    if (!inodeSet.has(r.inode)) continue;
    return true;
  }
  return false;
}

// GET /_health but keep the client socket OPEN (keepAlive) so /proc still
// shows the server-side ESTABLISHED socket when the caller verifies its
// inode owner. done() destroys the agent after the /proc scan.
function httpGetVerify(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.split('[').join('').split(']').join('');
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const req = http.request({ host, port: Number(u.port), path: '/_health', method: 'GET', agent, timeout: 5000 }, (res) => {
      const clientPort = req.socket && req.socket.localPort ? req.socket.localPort : 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, clientPort, done: () => agent.destroy() }));
    });
    req.on('error', (e) => { agent.destroy(); reject(e); });
    req.on('timeout', () => { agent.destroy(); req.destroy(new Error('health request timeout')); });
    req.end();
  });
}

// /proc/$pid/fd/* -> set of socket inodes this process owns.
function fdSocketInodes(pid) {
  const set = new Set();
  let names;
  try { names = readdirSync('/proc/' + pid + '/fd'); }
  catch { return set; }
  for (const name of names) {
    let link = '';
    try { link = readlinkSync(join('/proc/' + pid + '/fd', name)); }
    catch { continue; }
    if (link.startsWith('socket:[') && link.endsWith(']')) {
      const ino = link.slice(8, -1);
      if (isDigits(ino)) set.add(ino);
    }
  }
  return set;
}

// Wildcard bind addresses are not dialable; map them to loopback.
function dialHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '[0:0:0:0:0:0:0:0]') return '[::1]';
  return host;
}

// Only endpoints whose LISTEN inode belongs to MainPID are candidates.
export function ownedListenEndpoints(rows, inodeSet) {
  const out = [];
  for (const r of rows) {
    if (!inodeSet.has(r.inode)) continue;
    out.push({ url: 'http://' + dialHost(r.host) + ':' + r.port + '/_health', host: r.host, port: r.port, inode: r.inode });
  }
  return out;
}

// C2 (R16-PRODUCT-AUDIT-2ND MEDIUM): MainPID cmdline must EQUAL the exact
// two-token ExecStart argv, not merely contain it as substrings. Stops PID
// reuse, bot.mjs.evil suffixes and embedded-shell impersonators (N5).
export function cmdlineMatches(cmdline, nodeBin, prefix) {
  // Normalize BOTH sides to forward slashes: /proc cmdlines are Linux-form,
  // but the selftest also runs on Windows where path.join emits backslashes.
  const fwd = (v) => String(v == null ? '' : v).split(String.fromCharCode(92)).join('/');
  const argv = fwd(cmdline).split(String.fromCharCode(0));
  // A real /proc/<pid>/cmdline read as utf8 ends in a final NUL -> one
  // trailing empty token. Pop it CONDITIONALLY (selftest :363 has none).
  // NEVER filter(Boolean): that drops an EMBEDDED empty token, letting a
  // forged node\0\0prefix/bot.mjs collapse into the 2 expected tokens.
  if (argv.length && argv[argv.length - 1] === '') argv.pop();
  const p = fwd(prefix).replace(/\/+$/, '');
  const expected = [fwd(nodeBin), p + '/bot.mjs'];
  return argv.length === expected.length && argv.every((a, i) => a === expected[i]);
}

// ---------- the real check (systemd SYSTEM bus + /proc) ----------

export async function check(opts) {
  // D10.2: greenwash is NOT a free pass. On a real check it must fail.
  if (GREENWASH) throw new Error('PROVENANCE_GATE_GREENWASH set on a real check - fail-closed');
  // N8*: prove the composed judge has REAL teeth on every check (the dynamic
  // import above guarantees it, but a behavioural guard survives refactors).
  if (!composedJudgeHasTeeth()) throw new Error('composed five-check judge has no teeth - fail-closed (N8*)');
  const unit = opts.unit, prefix = opts.prefix, nodeBin = opts.nodeBin;
  const scope = opts.scope || 'confirmed';
  // C3: refuse a missing/non-canonical --since-ts rather than silently
  // disabling freshness (sinceTs=0 used to be a fail-open shortcut).
  const sinceTs = requireSinceTs(opts.sinceTs);
  const botFile = opts.botFile || join(prefix, 'bot.mjs');
  if (!unit || !prefix || !nodeBin) throw new Error('missing --unit/--prefix/--node');

  // 1. MainPID from the SYSTEM bus (never --user; that is the wrong bus).
  // HOLE 3: readMainPid() runs systemctl with env: systemBusEnv() so an
  // ambient DBUS_SYSTEM_BUS_ADDRESS (pointing at the --user bus) cannot
  // redirect the lookup to a forged same-named --user unit.
  let raw;
  try {
    raw = readMainPid(unit);
  } catch (e) { throw new Error('systemctl show MainPID failed: ' + (e && e.message || e)); }
  const pid = parseMainPid(raw);
  if (!pid) throw new Error('MainPID unavailable/0/non-integer - fail-closed (N4)');

  // 2. liveness + ExecStart cmdline (N5).
  try { process.kill(pid, 0); }
  catch { throw new Error('MainPID not alive (kill -0) - fail-closed'); }
  let cmdline;
  try { cmdline = readFileSync('/proc/' + pid + '/cmdline', 'utf8'); }
  catch { throw new Error('cannot read /proc/' + pid + '/cmdline'); }
  if (!cmdlineMatches(cmdline, nodeBin, prefix)) throw new Error('MainPID cmdline != ExecStart - fail-closed (N5)');

  // 3. LISTEN sockets owned by MainPID. An out-of-band impostor sits on a
  //    DIFFERENT inode and is excluded here (N1/N6).
  const inodeSet = fdSocketInodes(pid);
  if (inodeSet.size === 0) throw new Error('MainPID owns no socket inode - fail-closed');
  const rows = [];
  for (const pair of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    try { rows.push(...parseListenEntries(readFileSync(pair[0], 'utf8'), pair[1])); }
    catch { /* a missing tcp6 table is fine */ }
  }
  const eps = ownedListenEndpoints(rows, inodeSet);
  if (eps.length === 0) throw new Error('no LISTEN socket owned by MainPID - fail-closed (impostor on another socket, N1/N6)');
  // r17: bind the OS-truth endpoint to the port port_gate computed from the
  // two MANAGED sources. A source we did not enumerate that changed the real
  // bound port cannot deploy green: no owned endpoint will match.
  const expectPort = requireExpectPort(opts.expectPort);
  const cand = filterByExpectPort(eps, expectPort);
  if (cand.length === 0) throw new Error('owned port(s) ' + eps.map((e) => e.port).join(',') + ' != --expect-port ' + expectPort + ' - fail-closed (untracked port source)');

  // 4. Bind the RESPONDER to MainPID (H1), then judge the SAME five checks.
  //    The LISTEN-inode snapshot only proves MainPID holds a socket; the
  //    accept()-ed ESTABLISHED socket (state 01, another inode) is checked
  //    here against MainPID's fd set WHILE our client socket is still open.
  //    fetch() could not expose this; http.Agent keepAlive can.
  const expected = shaOf(botFile);
  let lastErr = null, hit = null;
  for (const ep of cand) {
    let v = null;
    try {
      v = await httpGetVerify(ep.url);
      if (v.status !== 200) throw new Error('health http ' + v.status);
      const fdAfter = fdSocketInodes(pid);
      const est = [];
      for (const pair of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
        try { est.push(...parseEstablishedEntries(readFileSync(pair[0], 'utf8'), pair[1])); }
        catch { /* a missing tcp6 table is fine */ }
      }
      if (!responderBound(est, fdAfter, ep, v.clientPort)) {
        throw new Error('ESTABLISHED responder socket not owned by MainPID - fail-closed (H1)');
      }
      const h = JSON.parse(v.body);
      if (!healthNotStale(h, sinceTs)) throw new Error('stale/missing health.ts predates restart - fail-closed (freshness)');
      assertDeployHealth(h, expected);
      hit = { ep, clientPort: v.clientPort };
    } catch (e) { lastErr = e; }
    finally { if (v && v.done) v.done(); }
    if (hit) break;
  }
  if (!hit) throw new Error('no owned endpoint passed responder binding + health judge: ' + (lastErr && lastErr.message || lastErr));
  return {
    ok: true,
    line: 'PROVENANCE-OK scope=' + scope + ' mainPid=' + pid + ' endpoint=' + hit.ep.host + ':' + hit.ep.port
      + ' inode=' + hit.ep.inode + ' responder=bound sha=' + expected.slice(0, 16)
      + ' expectPort=' + (expectPort === null ? 'none' : expectPort),
  };
}

// ---------- selftest: positives + mutants (judge self-proof) ----------

function selftest() {
  const res = [], neg = [];
  const ok = (n, c) => res.push({ name: n, ok: !!c });
  const bad = (n, fn) => { let r = false; try { fn(); } catch { r = true; } neg.push({ name: n, rejected: r }); };
  const H = 'a'.repeat(64);

  ok('parse_mainpid_ok', parseMainPid('12345' + NL) === 12345);
  ok('parse_mainpid_trim', parseMainPid('  42  ') === 42);
  ok('M_empty_mainpid_rejected', parseMainPid('') === 0);
  ok('M_zero_mainpid_rejected', parseMainPid('0' + NL) === 0);
  ok('M_nan_mainpid_rejected', parseMainPid('abc') === 0);
  ok('M_multivalue_mainpid_rejected', parseMainPid('12345' + NL + '0' + NL) === 0);

  const sample = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid timeout inode',
    '   0: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000  0 12345 1 0 100 0 0 10 0',
    '   1: 0100007F:22B8 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000  0 99999 1 0 100 0 0 10 0',
  ].join(NL);
  const listen = parseListenEntries(sample, false);
  ok('parse_listen_rows', listen.length === 1);
  ok('parse_listen_localhost_8888', listen[0] && listen[0].host === '127.0.0.1' && listen[0].port === 8888);
  ok('parse_listen_inode', listen[0] && listen[0].inode === '12345');
  ok('M_nonlisten_row_excluded', parseListenEntries(sample.replace('0A 00000000', '01 00000000'), false).length === 0);

  const owned = ownedListenEndpoints(listen, new Set(['12345']));
  ok('owned_endpoint_found', owned.length === 1 && owned[0].port === 8888);
  ok('owned_endpoint_url', owned[0] && owned[0].url === 'http://127.0.0.1:8888/_health');
  ok('M_impostor_inode_excluded', ownedListenEndpoints(listen, new Set(['99999'])).length === 0);
  ok('M_no_owned_inode_excluded', ownedListenEndpoints(listen, new Set([])).length === 0);
  ok('M_ipv6_wildcard_dialable', ownedListenEndpoints([{ host: '[0:0:0:0:0:0:0:0]', port: 8787, inode: '7' }], new Set(['7']))[0].url === 'http://[::1]:8787/_health');

  const N0 = String.fromCharCode(0);
  ok('cmdline_matches', cmdlineMatches('/usr/bin/node' + N0 + '/opt/dsh-ilink-bot/bot.mjs', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_foreign_cmdline_rejected', !cmdlineMatches('/bin/sh' + N0 + 'x', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('cmdline_matches_trailing_nul', cmdlineMatches('/usr/bin/node'+N0+'/opt/dsh-ilink-bot/bot.mjs'+N0, '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_cmdline_bot_mjs_evil_suffix_rejected', !cmdlineMatches('/usr/bin/node'+N0+'/opt/dsh-ilink-bot/bot.mjs.evil', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_cmdline_extra_argv_rejected', !cmdlineMatches('/usr/bin/node'+N0+'/opt/dsh-ilink-bot/bot.mjs'+N0+'evil', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_cmdline_substring_embedded_rejected', !cmdlineMatches('/bin/sh'+N0+'-c'+N0+'echo /usr/bin/node /opt/dsh-ilink-bot/bot.mjs', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_cmdline_embedded_empty_rejected', !cmdlineMatches('/usr/bin/node'+N0+N0+'/opt/dsh-ilink-bot/bot.mjs', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_cmdline_reordered_rejected', !cmdlineMatches('/opt/dsh-ilink-bot/bot.mjs'+N0+'/usr/bin/node', '/usr/bin/node', '/opt/dsh-ilink-bot'));
  ok('M_cmdline_space_joined_rejected', !cmdlineMatches('/usr/bin/node /opt/dsh-ilink-bot/bot.mjs', '/usr/bin/node', '/opt/dsh-ilink-bot'));

  // N8: the composed five checks still have teeth.
  const base = { service: 'dsh-ilink-bot', codeHash: H, status: 'ok', needsRelogin: false };
  bad('M_wrong_hash_rejected', () => assertDeployHealth({ ...base, codeHash: '0'.repeat(64) }, H));
  bad('M_stale_token_rejected', () => assertDeployHealth({ ...base, status: 'needs_relogin', needsRelogin: true }, H));
  bad('M_lasterror_rejected', () => assertDeployHealth({ ...base, lastError: 'network down' }, H));
  bad('M_corrupt_state_rejected', () => assertDeployHealth({ ...base, status: 'corrupt_state', lastError: 'bad state' }, H));
  bad('M_wrong_service_rejected', () => assertDeployHealth({ ...base, service: 'other' }, H));

  // N8*: prove the composed judge keeps its teeth in a FRESH child process
  // even when the parent leaked VERIFY_HEALTH_GREENWASH=1. The child imports
  // THIS module (which deletes the flag before importing verify_health.mjs),
  // then calls composedJudgeHasTeeth(); exit 0 == teeth. A mutant that drops
  // the delete must make the leaked child exit 1 (proven by capstone mutant).
  const selfUrl = new URL('./provenance_gate.mjs', import.meta.url).href;
  const probe = 'import(' + JSON.stringify(selfUrl) + ').then(m=>process.exit(m.composedJudgeHasTeeth()?0:1)).catch(()=>process.exit(2))';
  let teethClean = false, teethLeaked = false;
  try { execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, VERIFY_HEALTH_GREENWASH: '' } }); teethClean = true; } catch { teethClean = false; }
  try { execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, VERIFY_HEALTH_GREENWASH: '1' } }); teethLeaked = true; } catch { teethLeaked = false; }
  ok('N8_composed_judge_teeth_clean_env', teethClean);
  ok('N8_composed_judge_teeth_leaked_greenwash', teethLeaked);
  ok('freshness_no_sinceTs_passes', healthNotStale({ ts: '2020-01-01T00:00:00Z' }, 0));
  ok('freshness_recent_passes', healthNotStale({ ts: new Date().toISOString() }, Math.floor(Date.now() / 1000) - 1));
  ok('M_stale_ts_rejected', !healthNotStale({ ts: '2020-01-01T00:00:00Z' }, Math.floor(Date.now() / 1000)));
  ok('M_missing_ts_rejected_when_since_set', !healthNotStale({}, Math.floor(Date.now() / 1000)));
  ok('sinceTs_positive_accepted', requireSinceTs(String(Math.floor(Date.now()/1000))) > 0);
  ok('sinceTs_1_accepted', requireSinceTs('1') === 1);
  bad('M_sinceTs_missing_rejected', ()=>requireSinceTs(undefined));
  bad('M_sinceTs_empty_rejected', ()=>requireSinceTs(''));
  bad('M_sinceTs_abc_rejected', ()=>requireSinceTs('abc'));
  bad('M_sinceTs_zero_rejected', ()=>requireSinceTs('0'));
  bad('M_sinceTs_neg_rejected', ()=>requireSinceTs('-1'));
  bad('M_sinceTs_1e3_rejected', ()=>requireSinceTs('1e3'));
  bad('M_sinceTs_float_rejected', ()=>requireSinceTs('1.5'));
  bad('M_sinceTs_spaces_rejected', ()=>requireSinceTs(' 123 '));
  bad('M_sinceTs_hex_rejected', ()=>requireSinceTs('0x50'));
  bad('M_sinceTs_leadingzero_rejected', ()=>requireSinceTs('0123'));

  // r17 D10.2: the managed-only --expect-port runtime assertion MUST be
  // exercised here. Earlier selftest (41/41) never called requireExpectPort /
  // filterByExpectPort, so a mutant that gutted the r17 assertion still passed
  // green. Positives prove validator + filter; negatives (mutants) prove
  // fail-closed on every malformed port; the empty-filter case is the exact
  // condition check() turns into "fail-closed (untracked port source)".
  // F1: missing/empty is now a REJECTED mutant, not a null-returning pass -
  // a bare --check must never silently disable the assertion (false-GREEN).
  ok('expectPort_canonical_accepted', requireExpectPort('8787') === 8787);
  ok('expectPort_min_accepted', requireExpectPort('1') === 1);
  ok('expectPort_max_accepted', requireExpectPort('65535') === 65535);
  bad('M_expectPort_omitted_rejected', ()=>requireExpectPort(undefined));
  bad('M_expectPort_empty_rejected', ()=>requireExpectPort(''));
  bad('M_expectPort_filter_null_rejected', ()=>filterByExpectPort([{port:8787}], null));
  ok('expectPort_filter_matches', filterByExpectPort([{port:8787},{port:9999}], 8787).length === 1);
  ok('expectPort_filter_no_match_empty_fails_closed', filterByExpectPort([{port:8787},{port:9999}], 12345).length === 0);
  bad('M_expectPort_zero_rejected', ()=>requireExpectPort('0'));
  bad('M_expectPort_over_max_rejected', ()=>requireExpectPort('65536'));
  bad('M_expectPort_nan_rejected', ()=>requireExpectPort('abc'));
  bad('M_expectPort_hex_rejected', ()=>requireExpectPort('0x50'));
  bad('M_expectPort_spaces_rejected', ()=>requireExpectPort(' 80 '));
  bad('M_expectPort_exponent_rejected', ()=>requireExpectPort('1e3'));
  bad('M_expectPort_float_rejected', ()=>requireExpectPort('80.5'));
  bad('M_expectPort_negative_rejected', ()=>requireExpectPort('-1'));
  bad('M_expectPort_whitespace_rejected', ()=>requireExpectPort(' '));

  // H1 responder-binding helpers: parse state-01 rows, bind by client port
  // + inode, and reject wrong inode / wrong client port / zero client port.
  const estSample = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid timeout inode',
    '   0: 0100007F:22B8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000  0 55555 1 0 100 0 0 10 0',
    '   1: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000  0 12345 1 0 100 0 0 10 0',
  ].join(NL);
  const est = parseEstablishedEntries(estSample, false);
  ok('parse_established_rows', est.length === 1);
  ok('parse_established_ports', est[0] && est[0].localPort === 8888 && est[0].remPort === 50000);
  ok('parse_established_inode', est[0] && est[0].inode === '55555');
  ok('M_listen_row_not_returned_as_established', est.length === 1);
  const epSample = { host: '127.0.0.1', port: 8888, inode: '12345' };
  ok('responder_bound_true', responderBound(est, new Set(['55555']), epSample, 50000));
  ok('M_responder_wrong_inode_rejected', !responderBound(est, new Set(['99999']), epSample, 50000));
  ok('M_responder_wrong_clientport_rejected', !responderBound(est, new Set(['55555']), epSample, 50001));
  ok('M_responder_zero_clientport_rejected', !responderBound(est, new Set(['55555']), epSample, 0));
  ok('M_no_established_rows_rejected', !responderBound([], new Set(['55555']), epSample, 50000));

  // HOLE 3 (r18): the DBUS bus-confusion fix must have teeth. Pure checks
  // prove the scrub + options; reflection proves readMainPid() actually routes
  // through systemctlShowOptions(); a spawned child proves the exported
  // systemBusEnv() scrubs a REAL poisoned environment (negative control: the
  // child must also observe that the poison really arrived, else BAD).
  const poisonBase = { PATH: '/bin', DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  const scrubbed = systemBusEnv(poisonBase);
  ok('N9_bus_scrub_drops_both', !('DBUS_SYSTEM_BUS_ADDRESS' in scrubbed) && !('DBUS_SESSION_BUS_ADDRESS' in scrubbed));
  ok('N9_bus_scrub_keeps_path', scrubbed.PATH === '/bin');
  ok('N9_bus_scrub_no_mutate_input', 'DBUS_SYSTEM_BUS_ADDRESS' in poisonBase);
  ok('N9_show_options_scrubs_env', !('DBUS_SYSTEM_BUS_ADDRESS' in systemctlShowOptions(poisonBase).env));
  ok('N9_show_options_has_timeout', systemctlShowOptions(poisonBase).timeout === 8000);
  ok('N9_readMainPid_uses_show_options', readMainPid.toString().indexOf('systemctlShowOptions') !== -1);
  // BEHAVIORAL teeth (stronger than reflection): poison the AMBIENT env, then
  // inject a spy runner that records the exact options object readMainPid()
  // passes to execFileSync. The spy must see env WITHOUT both DBUS keys. A
  // mutant that reverts to bare {encoding,timeout} (the real HOLE 3 fail-open)
  // or inlines process.env fails this check even if the reflection string stays.
  const savedSys = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  const savedSes = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
  let spyOpts = null, spyBin = '', spyArgs = null;
  readMainPid('dsh-ilink-bot.service', (bin, args, opts) => { spyBin = bin; spyArgs = args; spyOpts = opts; return 'MainPID=123' + NL; });
  if (savedSys === undefined) delete process.env.DBUS_SYSTEM_BUS_ADDRESS; else process.env.DBUS_SYSTEM_BUS_ADDRESS = savedSys;
  if (savedSes === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = savedSes;
  ok('N9_readMainPid_spy_called_systemctl', spyBin === 'systemctl' && Array.isArray(spyArgs) && spyOpts !== null);
  ok('N9_readMainPid_env_scrubs_ambient', !!spyOpts && !!spyOpts.env && !('DBUS_SYSTEM_BUS_ADDRESS' in spyOpts.env) && !('DBUS_SESSION_BUS_ADDRESS' in spyOpts.env));
  const busProbe = 'import(' + JSON.stringify(selfUrl) + ').then(function(m){'
    + 'var poison=("DBUS_SYSTEM_BUS_ADDRESS" in process.env)&&("DBUS_SESSION_BUS_ADDRESS" in process.env);'
    + 'var s=m.systemBusEnv();'
    + 'var clean=!("DBUS_SYSTEM_BUS_ADDRESS" in s)&&!("DBUS_SESSION_BUS_ADDRESS" in s);'
    + 'process.stdout.write((poison&&clean)?"OK":"BAD");'
    + '}).catch(function(){process.stdout.write("ERR");});';
  let busOut = '';
  try { busOut = execFileSync(process.execPath, ['-e', busProbe], { encoding: 'utf8', timeout: 8000, env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } }).trim(); } catch { busOut = 'ERR'; }
  ok('N9_bus_scrub_behavioral', busOut === 'OK');

  const passed = res.filter((r) => r.ok).length;
  const negPassed = neg.filter((n) => n.rejected).length;
  res.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name));
  neg.filter((n) => !n.rejected).forEach((n) => console.log('  NEG-NOT-REJECTED ' + n.name));
  // GREENWASH is not a free pass: with the flag set the selftest must FAIL.
  const allGood = passed === res.length && negPassed === neg.length && !GREENWASH;
  console.log((allGood ? 'PROVENANCE-SELFTEST-OK' : 'PROVENANCE-SELFTEST-FAIL')
    + ' checks=' + passed + '/' + res.length + ' negatives=' + negPassed + '/' + neg.length
    + (GREENWASH ? ' greenwash=on' : ''));
  return allGood;
}

// ---------- CLI ----------
const args = process.argv.slice(2);
// Skip the CLI when this module is imported by the N8* selftest child
// (node -e has no argv[1]); otherwise the usage branch would force exit 2.
const invokedDirectly = !!(process.argv[1] && process.argv[1].endsWith('provenance_gate.mjs'));
if (invokedDirectly && args.indexOf('--selftest') >= 0) {
  process.exitCode = selftest() ? 0 : 1;
} else if (invokedDirectly && args.indexOf('--check') >= 0) {
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  const opts = { unit: get('--unit'), prefix: get('--prefix'), nodeBin: get('--node'), scope: get('--scope'), sinceTs: get('--since-ts'), botFile: get('--bot-file'), expectPort: get('--expect-port') };
  try {
    const r = await check(opts);
    console.log(r.line);
    process.exitCode = 0;
  } catch (e) {
    console.log('PROVENANCE-FAIL ' + (e && e.message || e));
    process.exitCode = 1;
  }
} else if (invokedDirectly) {
  console.log('usage: --selftest | --check --unit U --prefix P --node N [--scope S] --since-ts T --expect-port N [--bot-file F]');
  process.exitCode = 2;
}
