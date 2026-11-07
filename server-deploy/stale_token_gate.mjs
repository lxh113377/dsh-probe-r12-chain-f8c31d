// server-deploy/stale_token_gate.mjs
// #47 machine gate for the token-expiry (stale-token / errcode -14) code path.
// WHY: bot.mjs used to rethrow on stale-token; the main entry then called
// process.exit(1); with systemd Restart=always + RestartSec=5 that becomes a
// 5-second infinite crash loop that keeps hammering iLink with NO observable
// needs-relogin signal. On a server nobody watches, token expiry is inevitable,
// so this path MUST degrade gracefully and stay observable.
//
//   node stale_token_gate.mjs                          -> STALE-GATE-OK   exit 0
//   STALE_GATE_GREENWASH=1 node stale_token_gate.mjs   -> STALE-GATE-FAIL  exit 1
//        (judge forced always-true; synthetic mutants no longer rejected)
//
// The gate runs the REAL runService() against a mock iLink that ALWAYS answers
// errcode -14. No network egress, no WeChat, no GUI, no token plaintext.

import { runService, codeHash } from './bot.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GREENWASH = process.env.STALE_GATE_GREENWASH === '1';
const results = [];
const negatives = [];
function ok(name, cond, msg) { results.push({ name, ok: !!cond, msg: cond ? '' : (msg || 'assertion failed') }); }

// THE JUDGE: the contract a correct stale-token state must satisfy.
export function assertStaleDegraded(ev) {
  if (GREENWASH) return true;
  if (!ev) throw new Error('no evidence captured');
  if (ev.threw !== false) throw new Error('runService threw/exited on stale token -> crash loop');
  if (ev.statsStatus !== 'needs_relogin') throw new Error('stats.status not degraded: ' + ev.statsStatus);
  if (ev.healthStatus !== 'needs_relogin') throw new Error('health did not report needs_relogin: ' + ev.healthStatus);
  if (ev.needsRelogin !== true) throw new Error('health needsRelogin flag missing');
  if (ev.getUpdatesCalls !== 1) throw new Error('polling did not stop (hammering): ' + ev.getUpdatesCalls);
  if (ev.sendCalls !== 0) throw new Error('sent a message while degraded');
  if (!ev.codeHash || ev.codeHash !== codeHash()) throw new Error('health lost running codeHash');
  return true;
}

// Synthetic mutants: each MUST be rejected by the judge (proof it has teeth).
function neg(name, ev) { let rejected = false; try { assertStaleDegraded(ev); } catch { rejected = true; } negatives.push({ name, rejected }); }
neg('synthetic_crash_loop', { threw: true, statsStatus: 'ok', healthStatus: 'ok', needsRelogin: false, getUpdatesCalls: 1, sendCalls: 0, codeHash: codeHash() });
neg('synthetic_hammer_polling', { threw: false, statsStatus: 'needs_relogin', healthStatus: 'needs_relogin', needsRelogin: true, getUpdatesCalls: 99, sendCalls: 0, codeHash: codeHash() });
neg('synthetic_no_relogin_signal', { threw: false, statsStatus: 'needs_relogin', healthStatus: 'ok', needsRelogin: false, getUpdatesCalls: 1, sendCalls: 0, codeHash: codeHash() });

// ---- REAL evidence: run the service loop against an always-stale mock iLink ----
const dir = mkdtempSync(join(tmpdir(), 'dsh-stale-gate-'));
const statePath = join(dir, 'state.json');
let stats = null, healthJson = null, threw = false, getUpdatesCalls = 0, sendCalls = 0;
const fetchImpl = async (url, init) => {
  const u = String(url);
  if (u.indexOf('getupdates') >= 0) {
    getUpdatesCalls += 1;
    return { ok: true, json: async () => ({ errcode: -14, errmsg: 'session timeout' }) };
  }
  if (u.indexOf('sendmessage') >= 0) { sendCalls += 1; return { ok: true, json: async () => ({ ret: 0 }) }; }
  return { ok: true, json: async () => ({ ret: 0 }) };
};
try {
  stats = await runService(
    { token: 'stale-gate-fake-token', baseUrl: 'https://ilinkai.weixin.qq.com/', statePath, healthPort: 0, configPath: '/nope' },
    { fetchImpl, fastFail: true, maxCycles: 1000000, reloginIdleMs: 20, maxIdleTicks: 3,
      logger: { log(){}, error(){}, warn(){} },
      onListen: async () => {},
      onDegraded: async (port) => {
        const r = await fetch('http://127.0.0.1:' + port + '/_health');
        healthJson = await r.json();
      } }
  );
} catch (e) { threw = true; }
finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

const ev = {
  threw,
  statsStatus: stats && stats.status,
  healthStatus: healthJson && healthJson.status,
  needsRelogin: healthJson && healthJson.needsRelogin,
  getUpdatesCalls, sendCalls,
  codeHash: healthJson && healthJson.codeHash,
};
console.log('STALE-EVIDENCE ' + JSON.stringify(ev));

ok('judge_accepts_real_evidence', (() => { try { assertStaleDegraded(ev); return true; } catch { return false; } })());
ok('no_crash_on_stale_token', threw === false);
ok('service_enters_degraded_state', stats && stats.status === 'needs_relogin');
ok('health_reports_needs_relogin', healthJson && healthJson.status === 'needs_relogin' && healthJson.needsRelogin === true);
ok('polling_stopped_after_stale', getUpdatesCalls === 1);
ok('no_send_while_degraded', sendCalls === 0);
ok('health_keeps_running_codehash', healthJson && healthJson.codeHash === codeHash());

const passed = results.filter(r => r.ok).length;
const negPassed = negatives.filter(n => n.rejected).length;
results.filter(r => !r.ok).forEach(r => console.log('  FAIL ' + r.name + ': ' + r.msg));
negatives.filter(n => !n.rejected).forEach(n => console.log('  NEG-NOT-REJECTED ' + n.name));
const allGood = passed === results.length && negPassed === negatives.length;
console.log((allGood ? 'STALE-GATE-OK' : 'STALE-GATE-FAIL') + ' checks=' + passed + '/' + results.length + ' negatives=' + negPassed + '/' + negatives.length + (GREENWASH ? ' greenwash=on' : ''));
process.exit(allGood ? 0 : 1);
