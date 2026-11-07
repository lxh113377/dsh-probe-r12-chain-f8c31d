// server-deploy/verify_health.mjs
// #40 online-verify JUDGE for the restarted service. A deploy is "green" only
// when the running /_health reports: (a) codeHash == sha256(deployed bot.mjs),
// (b) status == "ok", (c) needsRelogin !== true, (d) service == dsh-ilink-bot,
// (e) lastError empty. WHY (c): bot.mjs degrades to needs_relogin on token
// expiry instead of exiting into a Restart=always crash loop; online-verify
// must NOT call that "healthy". WHY (e): a generic transport failure (no
// egress, DNS, http-error) leaves status=ok but sets lastError and receives
// NOTHING; without this check a zero-egress host prints DEPLOY-OK yet works
// not at all (r5 zero-egress false-green, independently reproduced + fixed).
//
//   node verify_health.mjs --selftest                       -> VERIFY-HEALTH-SELFTEST-OK  exit 0
//   VERIFY_HEALTH_GREENWASH=1 node ... --selftest            -> ...-FAIL                  exit 1
//   node verify_health.mjs --url U --file F                  -> DEPLOY-HEALTH-OK / -FAIL
//
// Headless: pure HTTP + local temp file. No token, no WeChat, no window ops.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GREENWASH = process.env.VERIFY_HEALTH_GREENWASH === '1';

// THE JUDGE (single source of truth for deploy.sh [6/6]).
export function assertDeployHealth(health, expectedHash) {
  if (GREENWASH) return { ok: true };
  if (!health || typeof health !== 'object') throw new Error('no health json');
  if (health.service !== 'dsh-ilink-bot') throw new Error('wrong service: ' + health.service);
  if (health.codeHash !== expectedHash) throw new Error('running codeHash != deployed sha256');
  if (health.status !== 'ok') throw new Error('service not ok: ' + health.status);
  if (health.needsRelogin === true) throw new Error('token expired (needs_relogin): run login.mjs once, then redeploy');
  // A host with no egress (or any transport error mid-backoff) keeps status=ok
  // and needsRelogin=false, but sets lastError and long-polls NO messages. The
  // old judge ACCEPTed that. Reject any non-empty lastError => fail-closed.
  if (health.lastError != null && String(health.lastError).trim().length > 0) {
    throw new Error('transport error, no confirmed message flow: ' + health.lastError);
  }
  return { ok: true };
}

export function shaOf(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// CLI path: fetch the running health, judge it against the deployed file.
export async function checkUrl(url, filePath) {
  const expected = shaOf(filePath);
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp || !resp.ok) throw new Error('health http ' + String(resp && resp.status));
  const health = await resp.json();
  assertDeployHealth(health, expected);
  return 'sha=' + String(health.codeHash).slice(0, 16) + '… status=ok needsRelogin=false';
}

function synthetic(hash, over) {
  return { service: 'dsh-ilink-bot', codeHash: hash, status: 'ok', needsRelogin: false, ...over };
}

async function selftest() {
  const results = [];
  const negatives = [];
  const ok = (name, cond) => results.push({ name, ok: !!cond });
  const H = 'a'.repeat(64);
  // Positive: a genuinely healthy service is accepted.
  ok('judge_accepts_healthy', (() => { try { assertDeployHealth(synthetic(H), H); return true; } catch { return false; } })());
  // Positive: a healthy service that explicitly reports lastError=null is accepted.
  ok('judge_accepts_null_lasterror', (() => { try { assertDeployHealth(synthetic(H, { lastError: null }), H); return true; } catch { return false; } })());
  // Negative mutants: each MUST be rejected by the judge (teeth).
  const neg = (name, over) => { let r = false; try { assertDeployHealth(synthetic(H, over), H); } catch { r = true; } negatives.push({ name, rejected: r }); };
  neg('M1_wrong_running_hash', { codeHash: '0'.repeat(64) });
  neg('M2_stale_token_needs_relogin', { status: 'needs_relogin', needsRelogin: true });
  neg('M3_wrong_service', { service: 'other' });
  neg('M4_status_not_ok', { status: 'error' });
  neg('M5_transport_lasterror', { lastError: 'network error' });
  // r7: a corrupt on-disk state degrades to status=corrupt_state; the online
  // verify judge must reject it (fail-closed), not accept it as a healthy host.
  neg('M6_corrupt_state_status', { status: 'corrupt_state', lastError: 'state.json corrupt' });

  // Integration: exercise the REAL CLI fetch path against a local HTTP server.
  // A temp file stands in for the deployed bot.mjs; its sha feeds the judge.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vh-'));
  const file = join(dir, 'bot.mjs');
  writeFileSync(file, '// synthetic deployed file for online-verify selftest\n');
  let payload = synthetic(shaOf(file));
  const server = createServer((req, res) => {
    // connection:close so undici does not hold a keep-alive socket that would
    // collide with server.close() during process teardown (Windows libuv abort).
    res.writeHead(200, { 'content-type': 'application/json', 'connection': 'close' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/_health';
  let healthyLine = null, staleFailed = false;
  try {
    healthyLine = await checkUrl(url, file);
    payload = synthetic(shaOf(file), { status: 'needs_relogin', needsRelogin: true });
    try { await checkUrl(url, file); } catch { staleFailed = true; }
  } finally {
    // Fully drain the listening handle BEFORE returning: awaiting close() avoids
    // the UV_HANDLE_CLOSING double-close abort that a bare process.exit() trips.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
  ok('cli_accepts_live_healthy', !!healthyLine && healthyLine.indexOf('status=ok') >= 0);
  ok('cli_rejects_live_needs_relogin', staleFailed === true);

  const passed = results.filter(r => r.ok).length;
  const negPassed = negatives.filter(n => n.rejected).length;
  results.filter(r => !r.ok).forEach(r => console.log('  FAIL ' + r.name));
  negatives.filter(n => !n.rejected).forEach(n => console.log('  NEG-NOT-REJECTED ' + n.name));
  const allGood = passed === results.length && negPassed === negatives.length;
  console.log((allGood ? 'VERIFY-HEALTH-SELFTEST-OK' : 'VERIFY-HEALTH-SELFTEST-FAIL')
    + ' checks=' + passed + '/' + results.length + ' negatives=' + negPassed + '/' + negatives.length
    + (GREENWASH ? ' greenwash=on' : ''));
  return allGood;
}

// Import-safe: only the CLI block runs when this file is the entry point.
// That lets an E2E test import assertDeployHealth/checkUrl without triggering
// process.exit or the selftest. exitCode (not process.exit) keeps libuv happy.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
const isMain = invokedPath && import.meta.url === invokedPath;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.indexOf('--selftest') >= 0) {
    process.exitCode = (await selftest()) ? 0 : 1;
  } else {
    const ui = args.indexOf('--url'), fi = args.indexOf('--file');
    if (ui < 0 || fi < 0 || !args[ui + 1] || !args[fi + 1]) {
      console.log('usage: --url U --file F | --selftest'); process.exitCode = 2;
    } else {
      try {
        const line = await checkUrl(args[ui + 1], args[fi + 1]);
        console.log('DEPLOY-HEALTH-OK ' + line);
        process.exitCode = 0;
      } catch (e) {
        console.log('DEPLOY-HEALTH-FAIL ' + String(e && e.message || e));
        process.exitCode = 1;
      }
    }
  }
}
