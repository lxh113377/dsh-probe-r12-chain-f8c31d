// server-deploy/gate.mjs
// #47 machine gate: a restart/deploy only takes effect after this passes.
// It tests the REAL bot.mjs (imports it), with a mock iLink server (headless,
// no WeChat, no GUI, no network egress) and PROVEN negative controls.
//
// WHY a judge + mutants (#44 D8/D10.2): a checker that is always green is not a
// gate. assertWireShape() is the judge; the 3 mutants MUST be rejected by it.
// --greenwash (env GATE_INJECT_GREENWASH=1) deliberately makes the judge恒绿;
// running the gate with that env MUST print GATE-FAIL and exit 1. That proves
// the gate itself has teeth, not just the code it checks.
//
// Modes:
//   node gate.mjs                     -> GATE-OK checks=N/N negatives=3/3 (exit 0)
//   GATE_INJECT_GREENWASH=1 node ... -> GATE-FAIL (exit 1) [negative control]

import * as bot from './bot.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GREENWASH = process.env.GATE_INJECT_GREENWASH === "1";
const results = [];
const negatives = [];
function ok(name, cond, msg) { results.push({ name, ok: !!cond, msg: cond ? "" : (msg || "assertion failed") }); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---- THE JUDGE: exact iLink wire shape (copied from ILINK-WIRE-CHECKLIST.md) ----
export function assertWireShape(s) {
  if (GREENWASH) return true; // deliberate恒绿 mutation, only for gate self-test
  const h = s.headers, b = s.sendBody, g = s.getUpdatesBody;
  if (!h || h['iLink-App-Id'] !== 'bot') throw new Error('missing iLink-App-Id');
  if (h['iLink-App-ClientVersion'] !== String((2<<16)|(4<<8)|6)) throw new Error('bad client version');
  if (h['content-type'] !== 'application/json') throw new Error('bad content-type');
  if (h['AuthorizationType'] !== 'ilink_bot_token') throw new Error('M1: missing AuthorizationType');
  if (typeof h['X-WECHAT-UIN'] !== 'string' || !h['X-WECHAT-UIN']) throw new Error('missing X-WECHAT-UIN');
  if (!h['Authorization'] || h['Authorization'].indexOf('Bearer ') !== 0) throw new Error('missing Bearer');
  if (!b || !b.msg) throw new Error('missing send msg');
  if (b.msg.from_user_id !== '') throw new Error('M2: from_user_id must be empty');
  if (b.msg.message_type !== 2) throw new Error("M3: message_type must be 2");
  if (b.msg.message_state !== 2) throw new Error("message_state must be 2");
  if (typeof b.msg.to_user_id !== "string" || !b.msg.to_user_id) throw new Error("missing to_user_id");
  if (typeof b.msg.client_id !== "string" || b.msg.client_id.indexOf("dsh-weixin-") !== 0) throw new Error("bad client_id");
  if (!Array.isArray(b.msg.item_list) || b.msg.item_list.length !== 1
      || b.msg.item_list[0].type !== 1 || !b.msg.item_list[0].text_item) throw new Error("bad item_list");
  if (!b.base_info || b.base_info.channel_version !== '2.4.6'
      || b.base_info.bot_agent !== 'DeepSeekHarness/1.1.0') throw new Error('bad base_info');
  if (!g || typeof g.get_updates_buf !== "string" || !g.base_info) throw new Error("bad getupdates body");
  return true;
}

function goodSample() {
  const headers = bot.authenticatedHeaders('unit-test-token');
  const sendBody = bot.buildSendTextBody({ toUserId: 'wxid_demo@im.wechat', text: 'ping', clientId: 'fixed-id' });
  const getUpdatesBody = bot.buildGetUpdatesBody('cursor-1');
  return { headers, sendBody, getUpdatesBody };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
function mutantMissingAuthType() { const s = goodSample(); delete s.headers["AuthorizationType"]; return s; }
function mutantFromUserId() { const s = goodSample(); s.sendBody.msg.from_user_id = 'fake-sender'; return s; }
function mutantMessageType() { const s = goodSample(); s.sendBody.msg.message_type = 1; return s; }

// ---- positive checks ----
ok("schema_valid_config", (() => { try { bot.validateConfig(bot.loadConfig({ token:"x", baseUrl:"https://ilinkai.weixin.qq.com/", configPath:"/nope" })); return true; } catch { return false; } })());
ok("schema_missing_token_rejected", (() => { try { bot.validateConfig(bot.loadConfig({ token:null, configPath:"/nope" })); return false; } catch(e){ return /missing token/.test(e.message); } })());
ok("schema_untrusted_base_rejected", (() => { try { bot.validateConfig(bot.loadConfig({ token:"x", baseUrl:"https://evil.example.com/", configPath:"/nope" })); return false; } catch(e){ return /untrusted|invalid-base/.test(e.message); } })());
ok("headers_have_all_5_fields", (() => { const h = bot.authenticatedHeaders("tok"); return h["iLink-App-Id"]==="bot" && h["AuthorizationType"]==="ilink_bot_token" && h["content-type"]==="application/json" && "X-WECHAT-UIN" in h && h["Authorization"]==="Bearer tok"; })());
ok("headers_no_bearer_without_token", (() => { const h = bot.authenticatedHeaders(null); return !("Authorization" in h) && h["AuthorizationType"]==="ilink_bot_token"; })());
ok("getupdates_body_exact", eq(bot.buildGetUpdatesBody("abc"), { get_updates_buf:"abc", base_info:{ channel_version:"2.4.6", bot_agent:"DeepSeekHarness/1.1.0" } }));
ok("sendtext_body_exact", (() => { const b = bot.buildSendTextBody({ toUserId:"u@im.wechat", text:"hi", clientId:"cid" }); return b.msg.from_user_id==="" && b.msg.to_user_id==="u@im.wechat" && b.msg.client_id==="dsh-weixin-cid" && b.msg.message_type===2 && b.msg.message_state===2 && b.msg.item_list[0].type===1 && b.msg.item_list[0].text_item.text==="hi" && b.base_info.channel_version==="2.4.6"; })());
ok("context_token_conditional", (() => { const a = bot.buildSendTextBody({toUserId:"u",text:"t"}); const b = bot.buildSendTextBody({toUserId:"u",text:"t",contextToken:"  ctx  "}); return !("context_token" in a.msg) && b.msg.context_token==="ctx"; })());
ok("reject_ret_semantics", bot.rejectedProviderResponse({ret:0})===null && bot.rejectedProviderResponse({ret:-14})==="-14" && bot.rejectedProviderResponse({errcode:"0"})===null && bot.rejectedProviderResponse({})===null);
ok("direct_conversation_reply_target", (() => { const c = bot.directConversation({ from_user_id:"u@im.wechat", message_id:1, item_list:[{type:1,text_item:{text:"hi"}}] }); return c && c.replyTarget==="u@im.wechat" && c.kind==="direct"; })());
ok("group_source_rejected", bot.directConversation({ source:"uia-wechat-group/v1", from_user_id:"x" })===null);
ok("judge_accepts_valid_wire", (() => { try { assertWireShape(goodSample()); return true; } catch { return false; } })());
ok("codehash_deterministic", bot.codeHash()===bot.codeHash() && /^[0-9a-f]{64}$/.test(bot.codeHash()));

// ---- negative controls: each mutant MUST be rejected by the judge ----
function neg(name, fn) {
  let rejected = false;
  try { assertWireShape(fn()); } catch { rejected = true; }
  negatives.push({ name, rejected });
}
neg("M1_missing_AuthorizationType", mutantMissingAuthType);
neg("M2_from_user_id_nonempty", mutantFromUserId);
neg("M3_message_type_1", mutantMessageType);

// ---- headless smoke: run the REAL service loop against a mock iLink server ----
async function smoke() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ilink-gate-"));
  const statePath = join(dir, "state.json");
  const sent = [];
  let healthJson = null;
  const inbound = {
    message_id: "m-001",
    from_user_id: "wxid_owner@im.wechat",
    create_time_ms: 1700000000000,
    context_token: "ctx-abc",
    item_list: [{ type: 1, text_item: { text: "ping" } }],
  };
  // Mock iLink: getupdates always returns the same inbound (proves dedup across cycles);
  // sendmessage is captured and returns ret:0. No real network is touched.
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (u.indexOf("getupdates") >= 0) {
      return { ok:true, json: async () => ({ ret:0, msgs:[inbound], get_updates_buf:"cursor-2" }) };
    }
    if (u.indexOf("sendmessage") >= 0) {
      sent.push({ headers: init.headers, body });
      return { ok:true, json: async () => ({ ret:0 }) };
    }
    return { ok:true, json: async () => ({ ret:0 }) };
  };
  let stats;
  try {
    stats = await bot.runService(
      { token:"gate-fake-token", baseUrl:"https://ilinkai.weixin.qq.com/", statePath, healthPort:0, configPath:"/nope" },
      { fetchImpl, fastFail:true, maxCycles:3,
        logger: { log(){}, error(){}, warn(){} },
        onListen: async (port) => {
          const r = await fetch("http://127.0.0.1:" + port + "/_health");
          healthJson = await r.json();
        } }
    );
  } finally { try { rmSync(dir, { recursive:true, force:true }); } catch {} }
  return { stats, sent, healthJson };
}

const sm = await smoke();
ok("smoke_received_1", sm.stats.messagesReceived===1, "got " + sm.stats.messagesReceived);
ok("smoke_replied_1", sm.stats.messagesReplied===1, "got " + sm.stats.messagesReplied);
ok("smoke_dedup_across_3_cycles", sm.sent.length===1, "sent " + sm.sent.length);
ok("smoke_reply_target_is_sender", sm.sent[0] && sm.sent[0].body.msg.to_user_id==="wxid_owner@im.wechat");
ok("smoke_context_token_forwarded", sm.sent[0] && sm.sent[0].body.msg.context_token==="ctx-abc");
ok("smoke_real_client_wire_accepted", (() => { if (!sm.sent[0]) return false; try { assertWireShape({ headers:sm.sent[0].headers, sendBody:sm.sent[0].body, getUpdatesBody:bot.buildGetUpdatesBody("cursor-2") }); return true; } catch { return false; } })());
ok("health_status_ok", sm.healthJson && sm.healthJson.status==="ok" && sm.healthJson.service==="dsh-ilink-bot");
ok("health_reports_codehash", sm.healthJson && sm.healthJson.codeHash===bot.codeHash());

const passed = results.filter(r => r.ok).length;
const negPassed = negatives.filter(n => n.rejected).length;
results.filter(r => !r.ok).forEach(r => console.log("  FAIL " + r.name + ": " + r.msg));
negatives.filter(n => !n.rejected).forEach(n => console.log("  NEG-NOT-REJECTED " + n.name));
const allGood = passed===results.length && negPassed===negatives.length;
const line = (allGood ? "GATE-OK" : "GATE-FAIL") + " checks=" + passed + "/" + results.length + " negatives=" + negPassed + "/" + negatives.length + (GREENWASH ? " greenwash=on" : "");
console.log(line);
process.exit(allGood ? 0 : 1);
