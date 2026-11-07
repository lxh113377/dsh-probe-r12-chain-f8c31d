// server-deploy/verify_deploy.mjs
// #40 online-verify evidence, done as a REAL separate OS process (not in-process).
// Parent forks a child that runs the actual runService() loop with a mock iLink
// (no network egress, no WeChat, no GUI). Child binds a real HTTP /_health on an
// ephemeral port and reports it over IPC. Parent curls /_health over TCP, WAITS
// until the service has actually processed >=1 message (avoids the onListen race
// where the first getUpdates cycle has not finished yet), then asserts the running
// codeHash equals sha256 of the deployed bot.mjs on disk.
//
//   node verify_deploy.mjs                      -> DEPLOY-VERIFY-OK sha=...  exit 0
//   DSH_ILINK_EXPECT_WRONG=1 node verify...    -> DEPLOY-VERIFY-NEGCTL-OK   exit 0
//     (negative control: requires service genuinely up (real hash reported) AND
//      a WRONG expected hash to be rejected. If the judge were恒绿 it prints FAIL).

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BOT = join(HERE, "bot.mjs");
const WRONG = process.env.DSH_ILINK_EXPECT_WRONG === "1";

if (process.env.DSH_ILINK_CHILD === "1") {
  const { runService } = await import('./bot.mjs');
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.indexOf('getupdates') >= 0) {
      await new Promise((r) => setTimeout(r, 50));
      return { ok:true, json: async () => ({ ret:0, get_updates_buf:'selfcheck-cursor', msgs:[
        { message_id:'selfcheck-1', from_user_id:'selfcheck@im.wechat', create_time_ms: 1700000000000,
          context_token:'ctx-selfcheck', item_list:[{ type:1, text_item:{ text:'ping' } }] }
      ] }) };
    }
    if (u.indexOf('sendmessage') >= 0) return { ok:true, json: async () => ({ ret:0 }) };
    return { ok:true, json: async () => ({ ret:0 }) };
  };
  await runService(
    { token:'selfcheck-fake-token', baseUrl:'https://ilinkai.weixin.qq.com/', statePath: process.env.DSH_ILINK_STATE,
      healthPort:0, healthHost:"127.0.0.1", configPath:"/nope" },
    { fetchImpl, fastFail:true, maxCycles: 1000000,
      logger:{ log(){}, error(){}, warn(){} },
      onListen: async (port) => { if (process.send) process.send({ ready:true, port }); } }
  );
  process.exit(0);
}

function getJson(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host:'127.0.0.1', port, path:'/_health', timeout:5000 }, (res) => {
      let s=''; res.on('data',(d)=>s+=d); res.on('end',()=>{ try{ resolve(JSON.parse(s)); }catch(e){ reject(e); } });
    });
    req.on('error', reject); req.on('timeout', ()=>{ req.destroy(); reject(new Error('timeout')); });
  });
}

// Poll until the service has ACTUALLY processed a message, not merely listened.
async function waitProcessed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await getJson(port);
      if (Number(last.messagesReceived) >= 1) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  return last;
}

const dir = mkdtempSync(join(tmpdir(), "dsh-ilink-verify-"));
const statePath = join(dir, "state.json");
const child = fork(fileURLToPath(import.meta.url), [], {
  env: { ...process.env, DSH_ILINK_CHILD:"1", DSH_ILINK_STATE: statePath },
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});

let health = null, childErr = null, done = false;
const timer = setTimeout(() => finish(new Error("child did not report ready in 8s")), 8000);
function finish(err) {
  if (done) return; done = true;
  clearTimeout(timer);
  try { child.kill("SIGTERM"); } catch {}
  try { rmSync(dir, { recursive:true, force:true }); } catch {}
  const realHash = createHash("sha256").update(readFileSync(BOT)).digest("hex");
  const expected = WRONG ? "0".repeat(64) : realHash;
  const actual = health && health.codeHash;
  if (err) { console.log("DEPLOY-VERIFY-FAIL " + err.message); process.exit(1); }
  if (WRONG) {
    // Teeth = service genuinely reported the REAL running hash AND the wrong
    // expected hash was rejected. A恒绿 judge would accept the wrong hash.
    const teeth = actual === realHash && expected !== actual;
    console.log(teeth ? 'DEPLOY-VERIFY-NEGCTL-OK (service up, real hash reported, wrong expected hash rejected — judge has teeth)'
                      : 'DEPLOY-VERIFY-NEGCTL-FAIL (judge恒绿 or service not up: actual=' + String(actual).slice(0,16) + ')');
    process.exit(teeth ? 0 : 1);
  }
  const match = actual === expected;
  const good = match && health.status === "ok" && health.service === "dsh-ilink-bot"
    && Number(health.messagesReceived) >= 1 && Number(health.messagesReplied) >= 1;
  console.log((good ? 'DEPLOY-VERIFY-OK' : 'DEPLOY-VERIFY-FAIL')
    + " sha=" + String(actual).slice(0,16) + "…"
    + " status=" + (health && health.status)
    + " received=" + (health && health.messagesReceived)
    + " replied=" + (health && health.messagesReplied)
    + " pid=" + (health && health.pid));
  process.exit(good ? 0 : 1);
}
child.on('message', async (m) => {
  if (m && m.ready) {
    try { health = await waitProcessed(m.port, 6000); finish(null); }
    catch (e) { finish(e); }
  }
});
child.on('error', (e) => { childErr = e; finish(e); });
child.on('exit', (code) => { if (!done) finish(childErr || new Error('child exited early code=' + code)); });
