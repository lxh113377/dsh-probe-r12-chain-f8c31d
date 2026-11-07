// server-deploy/port_gate.mjs
// r17 MANAGED-ONLY health-port validation + expected-port computation.
//
// WHY: r16 tried to statically enumerate EVERY source that can set
// DSH_ILINK_HEALTH_PORT (EnvironmentFile chain, unit/drop-in Environment=,
// glob, DefaultEnvironment, systemctl set-environment, /etc/environment).
// Three independent audits (R16-C1-AUDIT) proved that arms race unwinnable:
// a source we did not enumerate can still change the bound port and deploy
// green. r17 STOPS enumerating. It reads ONLY the two sources deploy.sh
// itself manages (--env EnvironmentFile + --config config.json), validates
// their values are canonical decimal 1..65535 (F-N2 fail-fast), and computes
// PORT-EXPECT following bot.mjs resolveHealthPort priority env>config>8787.
// deploy.sh passes PORT-EXPECT to provenance_gate.mjs --check, which asserts
// the REAL bound socket discovered from /proc equals it. ANY untracked source
// that moved the port => runtime mismatch => red. F2 (a valid managed env
// override) stays green because PORT-EXPECT tracks it.
//
// F3 note: deploy.sh also passes --unit/--dropin, but they are INTENTIONALLY
// not read here. Statically enumerating every Environment=/drop-in source is
// exactly the unwinnable arms race r17 stopped. Any untracked source that moves
// the real port is caught at RUNTIME by the now-MANDATORY --expect-port
// assertion in provenance_gate.mjs (F1), not by static scanning.
//
//   node port_gate.mjs --selftest -> PORT-GATE-SELFTEST-OK checks=n/n
//   PORT_GATE_GREENWASH=1 node port_gate.mjs --selftest -> ...-FAIL exit 1
//   node port_gate.mjs --validate --env E --config C
//        -> PORT-EXPECT=<n> / PORT-VALIDATE-OK / PORT-VALIDATE-FAIL (exit 1)
//
// Headless: pure local file reads. No GUI, no WeChat, no token.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GREENWASH = process.env.PORT_GATE_GREENWASH === '1';
const NL = String.fromCharCode(10);
const Q = String.fromCharCode(34);
const DEFAULT_PORT = 8787;

// Canonical port: ASCII decimal digits only, integer 1..65535. Reject hex,
// exponent, float, sign, whitespace, empty, undefined - all fail-closed.
// Manual digit scan (no regex) keeps this file backslash-free; the SAME
// validator is imported by provenance_gate.mjs so the two never diverge.
export function validPortValue(v) {
  const s = String(v == null ? '' : v);
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 && n <= 65535;
}

function trim(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9 || s.charCodeAt(a) === 13 || s.charCodeAt(a) === 10)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9 || s.charCodeAt(b - 1) === 13 || s.charCodeAt(b - 1) === 10)) b--;
  return s.slice(a, b);
}

function stripQuotes(v) {
  const t = trim(String(v == null ? '' : v));
  const q = t.charCodeAt(0);
  if (t.length >= 2 && (q === Q.charCodeAt(0) || q === 39) && t.charCodeAt(t.length - 1) === q) return t.slice(1, -1);
  return t;
}

// Last DSH_ILINK_HEALTH_PORT=... wins (EnvironmentFile + shell export form).
export function envPortFromText(text) {
  let found = null;
  for (const raw of String(text == null ? '' : text).split(NL)) {
    let t = trim(raw);
    if (t.slice(0, 7) === 'export ') t = trim(t.slice(7));
    const key = 'DSH_ILINK_HEALTH_PORT';
    if (t.slice(0, key.length) !== key) continue;
    const rest = t.slice(key.length);
    let k = 0;
    while (k < rest.length && (rest.charCodeAt(k) === 32 || rest.charCodeAt(k) === 9)) k++;
    if (rest.charCodeAt(k) !== 61) continue;
    found = stripQuotes(rest.slice(k + 1));
  }
  return found;
}

export function configPortFromText(text) {
  try {
    const o = JSON.parse(String(text == null ? '' : text));
    return o && o.healthPort !== undefined ? o.healthPort : null;
  } catch { return 'PARSE_ERROR'; }
}

// Follow bot.mjs resolveHealthPort priority for the two MANAGED sources:
// env (EnvironmentFile) > config.json healthPort > 8787. A defined but
// non-canonical value is fail-closed (never silently fall through).
export function resolveExpectPort(envText, configText) {
  const bad = [], seen = [];
  const envVal = envPortFromText(envText);
  const cfgVal = configPortFromText(configText);
  if (cfgVal === 'PARSE_ERROR') bad.push('config=PARSE_ERROR');
  else if (cfgVal !== null) { seen.push('config=' + JSON.stringify(cfgVal)); if (!validPortValue(cfgVal)) bad.push('config=' + JSON.stringify(cfgVal)); }
  if (envVal !== null) { seen.push('env=' + JSON.stringify(envVal)); if (!validPortValue(envVal)) bad.push('env=' + JSON.stringify(envVal)); }
  let port = DEFAULT_PORT;
  if (cfgVal !== null && cfgVal !== 'PARSE_ERROR' && validPortValue(cfgVal)) port = Number(cfgVal);
  if (envVal !== null && validPortValue(envVal)) port = Number(envVal);
  return { ok: bad.length === 0, bad, seen, expectPort: port };
}

export function validate(opts) {
  if (GREENWASH) throw new Error('PORT_GATE_GREENWASH set on a real validate - fail-closed');
  const env = opts.env, config = opts.config;
  if (!env || !existsSync(env) || !config || !existsSync(config)) throw new Error('missing --env/--config file - fail-closed');
  const envText = readFileSync(env, 'utf8');
  const configText = readFileSync(config, 'utf8');
  const r = resolveExpectPort(envText, configText);
  return { ok: r.ok, bad: r.bad, seen: r.seen, expectPort: r.expectPort };
}

function selftest() {
  const res = [];
  const ok = (n, c) => res.push({ name: n, ok: !!c });
  ok('canonical_8787', validPortValue('8787'));
  ok('canonical_1', validPortValue('1'));
  ok('canonical_65535', validPortValue('65535'));
  ok('canonical_number_18888', validPortValue(18888));
  ok('M_abc_rejected', !validPortValue('abc'));
  ok('M_zero_rejected', !validPortValue('0'));
  ok('M_65536_rejected', !validPortValue('65536'));
  ok('M_neg1_rejected', !validPortValue('-1'));
  ok('M_1e3_rejected', !validPortValue('1e3'));
  ok('M_0x50_rejected', !validPortValue('0x50'));
  ok('M_empty_rejected', !validPortValue(''));
  ok('M_space80_rejected', !validPortValue(' 80 '));
  ok('M_float_rejected', !validPortValue('3.7'));
  ok('M_leadingplus_rejected', !validPortValue('+80'));
  ok('M_undefined_rejected', !validPortValue(undefined));
  ok('M_parse_error_rejected', !validPortValue('PARSE_ERROR'));
  ok('env_extract_last', envPortFromText('X=1' + NL + 'DSH_ILINK_HEALTH_PORT=18888' + NL + 'DSH_ILINK_HEALTH_PORT=9999') === '9999');
  ok('env_extract_quoted', envPortFromText('DSH_ILINK_HEALTH_PORT=' + Q + '18888' + Q) === '18888');
  ok('env_extract_export', envPortFromText('export DSH_ILINK_HEALTH_PORT=19000') === '19000');
  ok('env_absent_null', envPortFromText('X=1') === null);
  ok('config_extract', configPortFromText('{' + Q + 'healthPort' + Q + ':18888}') === 18888);
  ok('config_absent_null', configPortFromText('{}') === null);
  ok('config_parse_error_is_sentinel', configPortFromText('{oops') === 'PARSE_ERROR');
  ok('PRIORITY_default_8787', resolveExpectPort('X=1', '{}').expectPort === 8787);
  ok('PRIORITY_config_wins', resolveExpectPort('X=1', '{' + Q + 'healthPort' + Q + ':18080}').expectPort === 18080);
  ok('PRIORITY_env_wins_over_config', resolveExpectPort('DSH_ILINK_HEALTH_PORT=18888', '{' + Q + 'healthPort' + Q + ':18080}').expectPort === 18888);
  ok('PRIORITY_env_invalid_rejected', resolveExpectPort('DSH_ILINK_HEALTH_PORT=1e3', '{}').ok === false);
  ok('PRIORITY_config_invalid_rejected', resolveExpectPort('X=1', '{' + Q + 'healthPort' + Q + ':' + Q + '0x50' + Q + '}').ok === false);
  ok('PRIORITY_config_parse_error_rejected', resolveExpectPort('X=1', '{oops').ok === false);
  const td = mkdtempSync(join(tmpdir(), 'r17-port-'));
  try {
    const envf = join(td, 'env'); writeFileSync(envf, 'DSH_ILINK_HEALTH_PORT=18888' + NL);
    const cfg = join(td, 'config.json'); writeFileSync(cfg, '{' + Q + 'healthPort' + Q + ':8787}');
    const r = validate({ env: envf, config: cfg });
    ok('VALIDATE_expect_18888', r.ok === true && r.expectPort === 18888);
    writeFileSync(envf, 'DSH_ILINK_HEALTH_PORT=1e3' + NL);
    const r2 = validate({ env: envf, config: cfg });
    ok('VALIDATE_typo_rejected', r2.ok === false && r2.bad.some((x) => x.indexOf('1e3') >= 0));
  } catch (e) { ok('VALIDATE_expect_18888', false); ok('VALIDATE_typo_rejected', false); }
  finally { try { rmSync(td, { recursive: true, force: true }); } catch (e) {} }
  const passed = res.filter((r) => r.ok).length;
  res.filter((r) => !r.ok).forEach((r) => console.log('  FAIL ' + r.name));
  const allGood = passed === res.length && !GREENWASH;
  console.log((allGood ? 'PORT-GATE-SELFTEST-OK' : 'PORT-GATE-SELFTEST-FAIL') + ' checks=' + passed + '/' + res.length + (GREENWASH ? ' greenwash=on' : ''));
  return allGood;
}

const args = process.argv.slice(2);
const invokedDirectly = !!(process.argv[1] && process.argv[1].endsWith('port_gate.mjs'));
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
if (invokedDirectly && args.indexOf('--selftest') >= 0) {
  process.exitCode = selftest() ? 0 : 1;
} else if (invokedDirectly && args.indexOf('--validate') >= 0) {
  try {
    const r = validate({ env: get('--env'), config: get('--config') });
    if (!r.ok) { console.log('PORT-VALIDATE-FAIL bad=' + r.bad.join(' ')); process.exitCode = 1; }
    else {
      console.log('PORT-EXPECT=' + r.expectPort);
      console.log('PORT-VALIDATE-OK expect=' + r.expectPort + ' sources=' + r.seen.length + (r.seen.length ? ' (' + r.seen.join(' ') + ')' : ' (no overrides, canonical default)'));
      process.exitCode = 0;
    }
  } catch (e) { console.log('PORT-VALIDATE-FAIL ' + (e && e.message || e)); process.exitCode = 1; }
} else if (invokedDirectly) {
  console.log('usage: --selftest | --validate --env E --config C');
  process.exitCode = 2;
}
