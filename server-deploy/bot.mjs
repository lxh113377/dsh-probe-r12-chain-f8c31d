// server-deploy/bot.mjs
// Self-contained headless iLink (Weixin Bot HTTP API) DIRECT / 1:1 bot.
// Zero third-party deps: Node >= 18 built-ins only (global fetch, crypto, fs, http, url).
//
// WHY this exists: the group robot in this workspace depends on the Windows
// WeChat GUI (UIA accessibility tree) and CANNOT run on a headless Linux server.
// The official iLink HTTP API is the one channel here that is pure HTTP: no WeChat
// client, no accessibility tree, no window, no mouse, no in-process memory patch.
// This service implements that channel so it can live on a server and keep working
// after this PC is switched off.
//
// HARD BOUNDARY (honest scope): iLink is a DIRECT (bot <-> one user) channel. The
// provider exposes NO endpoint listing conversations/groups/members and no durable
// group message surface. This is a single-chat bot, NOT a group robot. See README.md.
//
// CREDENTIAL: the bot token is read ONLY from env DSH_WEIXIN_ILINK_TOKEN (or an
// override). It is never written to disk, never logged, never printed. systemd
// injects it via an EnvironmentFile with mode 0600.
//
// HOW IT WORKS (line-level):
//  1. requestJson() builds the exact wire shape copied from weixin-api.mjs, calls
//     fetch, parses JSON, folds non-zero ret/errcode into a rejection.
//  2. getUpdates() long-polls ilink/bot/getupdates with a cursor (get_updates_buf).
//  3. processInbound() skips outbound echoes (message_type===2), dedups by
//     message_id, extracts text, computes a reply, sendText() back to the SAME
//     from_user_id (iLink has no group id; reply target = sender).
//  4. cursor + bounded seen-id set persisted atomically to state.json.
//  5. tiny HTTP server exposes /_health (with running-code sha256) for #47 gate.
//  6. SIGTERM/SIGINT stop the loop and health server cleanly.
//  7. stale-token (-14) degrades to needs_relogin (health stays up, polling
//     stops) instead of exiting — no Restart=always crash loop.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';
export const WEIXIN_PROTOCOL_VERSION = '2.4.6';
export const DEFAULT_BOT_TYPE = 3;
export const ILINK_APP_ID = 'bot';
export const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6; // 132102
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;

export class WeixinApiError extends Error {
  constructor(code, message, opts) {
    super(message);
    this.name = 'WeixinApiError';
    this.code = code;
    if (opts && opts.status !== undefined) this.status = opts.status;
    if (opts && opts.providerCode !== undefined) this.providerCode = opts.providerCode;
  }
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isWeixinHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'weixin.qq.com' || h.endsWith('.weixin.qq.com');
}

export function normalizeWeixinApiBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new WeixinApiError('invalid-base-url', 'invalid base url'); }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)
      || (url.port !== '' && url.port !== '443')) {
    throw new WeixinApiError('untrusted-base-url', 'untrusted base url');
  }
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

export function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
  };
}

export function authenticatedHeaders(token) {
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
  };
  const t = nonEmptyString(token);
  if (t) headers.Authorization = 'Bearer ' + t;
  return headers;
}

export function baseInfo() {
  return { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' };
}

export function rejectedProviderResponse(value, fields) {
  const list = fields || ['ret', 'errcode'];
  if (!value || typeof value !== 'object') return null;
  for (const f of list) {
    const v = value[f];
    if (v !== undefined && v !== 0 && v !== '0') return String(v);
  }
  return null;
}

export function buildGetUpdatesBody(buf) {
  return { get_updates_buf: buf || '', base_info: baseInfo() };
}

export function buildSendTextBody(opts) {
  const to = nonEmptyString(opts.toUserId);
  const text = nonEmptyString(opts.text);
  if (!to || !text) throw new TypeError('toUserId and text are required');
  const clientId = 'dsh-weixin-' + (opts.clientId || randomUUID());
  const msg = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
  const ct = nonEmptyString(opts.contextToken);
  if (ct) msg.context_token = ct;
  const rid = nonEmptyString(opts.runId);
  if (rid) msg.run_id = rid;
  return { msg, base_info: baseInfo() };
}

export function extractWeixinText(message) {
  const items = (message && message.item_list) || [];
  for (const it of items) {
    if (it && it.type === 1 && it.text_item && typeof it.text_item.text === 'string') {
      const t = it.text_item.text.trim();
      if (t) return t;
    }
    if (it && it.type === 3 && it.voice_item && typeof it.voice_item.text === 'string') {
      const t = it.voice_item.text.trim();
      if (t) return t;
    }
  }
  return null;
}

export function weixinMessageId(message) {
  if (message && message.message_id !== undefined && message.message_id !== null) return String(message.message_id);
  return nonEmptyString(message && message.client_id);
}

export function directConversation(message) {
  // Only the legacy DIRECT shape is accepted. Any explicit source field (the local
  // UIA group producer) is rejected: iLink carries no group payload.
  if (message && message.source !== undefined) return null;
  const from = nonEmptyString(message && message.from_user_id);
  if (!from) return null;
  return { kind: 'direct', senderId: from, replyTarget: from, addressed: true };
}

export function orderWeixinMessages(msgs) {
  const arr = Array.isArray(msgs) ? msgs.slice() : [];
  return arr.sort((a, b) => {
    const ta = Number(a && a.create_time_ms) || 0;
    const tb = Number(b && b.create_time_ms) || 0;
    if (ta !== tb) return ta - tb;
    const ia = String(weixinMessageId(a) || '');
    const ib = String(weixinMessageId(b) || '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

export function computeReply(text, replyCfg) {
  const rules = (replyCfg && replyCfg.rules) || [];
  for (const r of rules) {
    if (r.match === text || (r.startsWith && text.startsWith(r.startsWith))) return r.reply;
  }
  if (replyCfg && replyCfg.defaultReply) return replyCfg.defaultReply;
  return '已收到（iLink 单聊机器人自动回复）：' + text;
}

async function requestJson(fetchImpl, cfg) {
  const base = normalizeWeixinApiBaseUrl(cfg.baseUrl);
  const url = new URL(cfg.endpoint, base);
  if (!isWeixinHost(url.hostname)) throw new WeixinApiError('untrusted-endpoint', 'untrusted endpoint');
  const controller = new AbortController();
  let timedOut = false;
  const timer = cfg.timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutMs) : null;
  try {
    const resp = await fetchImpl(url, {
      method: cfg.method || 'POST',
      headers: cfg.authenticated === false ? commonHeaders() : authenticatedHeaders(cfg.token),
      ...(cfg.body === undefined ? {} : { body: JSON.stringify(cfg.body) }),
      signal: controller.signal,
    });
    if (!resp || !resp.ok) throw new WeixinApiError('http-error', 'http ' + String(resp && resp.status), { status: resp && resp.status });
    try { return await resp.json(); }
    catch { throw new WeixinApiError('invalid-response', 'bad json'); }
  } catch (e) {
    if (timedOut) throw new WeixinApiError('timeout', 'timeout');
    if (e instanceof WeixinApiError) throw e;
    throw new WeixinApiError('network-error', 'network error');
  } finally { if (timer) clearTimeout(timer); }
}

export function createClient(opts) {
  const fetchImpl = opts.fetchImpl || fetch;
  const baseUrl = normalizeWeixinApiBaseUrl(opts.baseUrl || WEIXIN_QR_BASE_URL);
  const token = nonEmptyString(opts.token);
  const longPollMs = opts.longPollMs || DEFAULT_LONG_POLL_TIMEOUT_MS;

  function post(endpoint, body, timeoutMs) {
    return requestJson(fetchImpl, { method: 'POST', baseUrl, endpoint, body, token, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS });
  }

  return {
    async beginLogin() {
      const r = await post('ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(DEFAULT_BOT_TYPE), { local_token_list: [] }, 10000);
      const rej = rejectedProviderResponse(r, ['errcode', 'ret']);
      if (rej) throw new WeixinApiError('qr-request-rejected', 'qr rejected', { providerCode: rej });
      if (!nonEmptyString(r && r.qrcode)) throw new WeixinApiError('invalid-qr', 'no qrcode');
      return { qrcode: r.qrcode, qrcodeUrl: r.qrcode_img_content };
    },
    async getUpdates(buf) {
      try {
        return await post('ilink/bot/getupdates', buildGetUpdatesBody(buf), longPollMs);
      } catch (e) {
        if (e instanceof WeixinApiError && e.code === 'timeout') {
          return { ret: 0, msgs: [], get_updates_buf: buf || '' };
        }
        throw e;
      }
    },
    async sendText(o) {
      const body = buildSendTextBody(o);
      const r = await post('ilink/bot/sendmessage', body, DEFAULT_TIMEOUT_MS);
      const rej = rejectedProviderResponse(r);
      if (rej) throw new WeixinApiError('send-rejected', 'send rejected', { providerCode: rej });
      return { ...(r && typeof r === 'object' ? r : {}), providerMessageIds: [body.msg.client_id] };
    },
    async pollLogin(qrcode, verifyCode) {
      let endpoint = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
      const vc = nonEmptyString(verifyCode);
      if (vc) endpoint += '&verify_code=' + encodeURIComponent(vc);
      const r = await requestJson(fetchImpl, { method: 'GET', baseUrl, endpoint, timeoutMs: longPollMs, authenticated: false });
      const allowed = ['wait','scaned','confirmed','expired','scaned_but_redirect','need_verifycode','verify_code_blocked','binded_redirect'];
      if (!r || !allowed.includes(r.status)) throw new WeixinApiError('invalid-login-status', 'unknown login status');
      return r;
    },
    async getConfig(toUserId, contextToken) {
      const b = { ilink_user_id: toUserId, base_info: baseInfo() };
      const ct = nonEmptyString(contextToken); if (ct) b.context_token = ct;
      return post('ilink/bot/getconfig', b, 10000);
    },
  };
}

function resolveHealthPort(overrides, file) {
  if (overrides && overrides.healthPort !== undefined) return Number(overrides.healthPort);
  if (process.env.DSH_ILINK_HEALTH_PORT !== undefined) return Number(process.env.DSH_ILINK_HEALTH_PORT);
  if (file.healthPort !== undefined) return Number(file.healthPort);
  return 8787;
}

export function loadConfig(overrides) {
  let file = {};
  const cfgPath = (overrides && overrides.configPath) || process.env.DSH_ILINK_CONFIG || "config.json";
  if (existsSync(cfgPath)) {
    try { file = JSON.parse(readFileSync(cfgPath, 'utf8')); }
    catch (e) { throw new Error('bad config.json: ' + e.message); }
  }
  return {
    token: (overrides && overrides.token) || process.env.DSH_WEIXIN_ILINK_TOKEN || file.token || null,
    baseUrl: (overrides && overrides.baseUrl) || process.env.DSH_ILINK_BASE_URL || file.baseUrl || WEIXIN_QR_BASE_URL,
    statePath: (overrides && overrides.statePath) || file.statePath || "state.json",
    healthPort: resolveHealthPort(overrides, file),
    healthHost: (overrides && overrides.healthHost) || file.healthHost || "127.0.0.1",
    longPollMs: Number(file.longPollMs || DEFAULT_LONG_POLL_TIMEOUT_MS),
    reply: file.reply || {},
  };
}

export function validateConfig(cfg) {
  if (!nonEmptyString(cfg.token)) throw new Error('missing token: set DSH_WEIXIN_ILINK_TOKEN');
  normalizeWeixinApiBaseUrl(cfg.baseUrl);
  return cfg;
}

export function loadState(p) {
  // Missing file = legitimate first boot. Everything else (parse error, wrong
  // root type, wrong field type) = corrupt: the caller must NOT silently poll
  // from an empty cursor, because iLink may replay history and we would reply
  // twice. Report it so runService can degrade observably instead.
  if (!existsSync(p)) return { getUpdatesBuf: '', seen: [], corrupt: false };
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { getUpdatesBuf: '', seen: [], corrupt: true };
    if (s.seen !== undefined && !Array.isArray(s.seen)) return { getUpdatesBuf: '', seen: [], corrupt: true };
    if (s.getUpdatesBuf !== undefined && typeof s.getUpdatesBuf !== 'string') return { getUpdatesBuf: '', seen: [], corrupt: true };
    return { getUpdatesBuf: typeof s.getUpdatesBuf === 'string' ? s.getUpdatesBuf : '', seen: Array.isArray(s.seen) ? s.seen : [], corrupt: false };
  } catch { return { getUpdatesBuf: '', seen: [], corrupt: true }; }
}

export function saveState(p, s) {
  // Persist ONLY the two canonical fields. state carries a transient `corrupt`
  // flag that must never be written to disk, and an explicit shape keeps the
  // on-disk format stable when new in-memory fields are added later.
  const tmp = p + '.tmp';
  const disk = { getUpdatesBuf: typeof s.getUpdatesBuf === 'string' ? s.getUpdatesBuf : '', seen: Array.isArray(s.seen) ? s.seen : [] };
  writeFileSync(tmp, JSON.stringify(disk, null, 2));
  renameSync(tmp, p);
}

export function codeHash() {
  return createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
}

// Drive one inbound batch. Reused by runService AND the gate (so dedup is real,
// not a test-only copy). client must expose sendText().
export async function processInbound(client, msgs, state, opts) {
  const seen = state.seen;
  let received = 0, replied = 0;
  for (const msg of orderWeixinMessages(msgs)) {
    if (msg && msg.message_type === 2) continue;
    const conv = directConversation(msg);
    if (!conv) continue;
    const mid = weixinMessageId(msg);
    if (!mid || seen.has(mid)) continue;
    const text = extractWeixinText(msg);
    received += 1;
    // A message with no extractable text needs no reply, but must still be
    // marked seen so we do not re-count it on every iLink redelivery.
    if (!text) { seen.add(mid); continue; }
    const reply = computeReply(text, (opts && opts.reply) || {});
    const ct = nonEmptyString(msg.context_token) || undefined;
    // Dedup ONLY after a successful send. If sendText throws, the id stays out
    // of `seen`; runService leaves the get_updates_buf cursor unadvanced, so
    // iLink redelivers this message next cycle and we retry the send — this is
    // at-least-once delivery with message-id dedup, NOT a silent at-most-once
    // drop. Marking seen before the await (the old order) lost the message
    // forever on a transient send failure while /_health still read status=ok.
    await client.sendText({ toUserId: conv.replyTarget, text: reply, contextToken: ct });
    seen.add(mid);
    replied += 1;
  }
  return { received, replied };
}

export async function runService(overrides, deps) {
  const cfg = validateConfig(loadConfig(overrides));
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const logger = (deps && deps.logger) || console;
  const client = createClient({ fetchImpl, baseUrl: cfg.baseUrl, token: cfg.token, longPollMs: cfg.longPollMs, logger });
  const state = loadState(cfg.statePath);
  const seen = new Set(state.seen);
  const stats = { messagesReceived: 0, messagesReplied: 0, lastError: null, startedAt: Date.now(), healthPort: 0,
    status: 'ok', needsRelogin: false };
  // Set the degraded status BEFORE the health server is created, so /_health
  // never shows a transient status=ok for a corrupt on-disk state.
  if (state.corrupt) {
    stats.status = 'corrupt_state';
    stats.lastError = 'state.json corrupt; restore a valid state or remove it for a fresh start';
  }
  let stopped = false;
  let degradedLogged = false;
  let idleWake = null;
  // On a stale token we IDLE (not exit) so /_health stays observable: systemd
  // must not see an exit, which under Restart=always/RestartSec=5 becomes a
  // 5-second infinite crash loop hammering iLink with no relogin signal.
  const reloginIdleMs = deps && deps.reloginIdleMs !== undefined ? deps.reloginIdleMs : 5000;
  const maxIdleTicks = deps && deps.maxIdleTicks !== undefined ? deps.maxIdleTicks : Infinity;

  const health = createServer((req, res) => {
    if (req.url && req.url.indexOf('/_health') === 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: stats.status, service: 'dsh-ilink-bot', needsRelogin: stats.needsRelogin,
        uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
        messagesReceived: stats.messagesReceived, messagesReplied: stats.messagesReplied,
        lastError: stats.lastError, codeHash: codeHash(), pid: process.pid,
        ts: new Date().toISOString(),
      }));
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  // stop() also wakes the degraded idle sleep so SIGTERM shuts the service
  // down immediately instead of lingering for one full reloginIdleMs tick.
  const stop = () => {
    if (stopped) return; stopped = true;
    if (idleWake) { const w = idleWake; idleWake = null; w(); }
    try { health.close(); } catch {}
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);

  // Wait in a degraded state without exiting: the /_health server handle keeps
  // the event loop alive, stop() (SIGTERM) wakes the idle immediately, and a
  // bounded maxIdleTicks lets tests terminate. Shared by corrupt-state and
  // stale-token degradation so both behave identically under systemd.
  const idleUntilStop = async () => {
    let ticks = 0;
    while (!stopped && ticks < maxIdleTicks) {
      await new Promise((rs) => {
        const t = setTimeout(rs, reloginIdleMs);
        if (t && t.unref) t.unref();
        idleWake = () => { clearTimeout(t); rs(); };
      });
      ticks += 1;
    }
  };

  await new Promise((resolve) => health.listen(cfg.healthPort, cfg.healthHost, resolve));
  stats.healthPort = health.address().port;
  // Await onListen so the gate can fetch /_health while the server is still up.
  if (deps && deps.onListen) await deps.onListen(stats.healthPort);

  if (state.corrupt) {
    // Corrupt on-disk state (e.g. state.json truncated by a sudden power loss).
    // Polling from an empty cursor risks iLink replaying history -> duplicate
    // replies, and saveState would overwrite the only forensic copy. Fail
    // closed: keep /_health observable at status=corrupt_state, do NOT poll,
    // send, or save; log once; idle until SIGTERM (bounded ticks in tests).
    logger.warn('DSH-ILINK-BOT CORRUPT_STATE refusing to poll; restore state.json then redeploy');
    if (deps && deps.onDegraded) await deps.onDegraded(stats.healthPort);
    await idleUntilStop();
    try { health.close(); } catch {}
    return stats;
  }

  let failures = 0, cycle = 0;
  while (!stopped) {
    try {
      const r = await client.getUpdates(state.getUpdatesBuf);
      const rej = rejectedProviderResponse(r, ['errcode', 'ret']);
      if (rej) throw new WeixinApiError(rej === '-14' ? 'stale-token' : 'updates-rejected', 'updates rejected', { providerCode: rej });
      failures = 0; stats.lastError = null;
      const res = await processInbound(client, r && r.msgs, { seen }, { reply: cfg.reply });
      stats.messagesReceived += res.received;
      stats.messagesReplied += res.replied;
      if (r && typeof r.get_updates_buf === 'string' && r.get_updates_buf) state.getUpdatesBuf = r.get_updates_buf;
      state.seen = Array.from(seen).slice(-2000);
      saveState(cfg.statePath, state);
    } catch (e) {
      failures += 1; stats.lastError = String(e && e.message || e);
      if (stopped) break;
      if (e instanceof WeixinApiError && e.code === 'stale-token') {
        // Provider says session timeout (errcode -14): the token must be
        // refreshed by login.mjs + a gated redeploy. Exiting here would, under
        // systemd Restart=always/RestartSec=5, become an infinite 5s crash
        // loop that keeps polling iLink with no observable signal. Instead
        // enter a DEGRADED state: keep /_health up, report needs_relogin,
        // STOP polling, log once, idle until SIGTERM (or bounded test ticks).
        stats.status = 'needs_relogin';
        stats.needsRelogin = true;
        if (!degradedLogged) {
          degradedLogged = true;
          logger.warn('DSH-ILINK-BOT NEEDS_RELOGIN token expired; run login.mjs once, then redeploy via deploy.sh');
        }
        if (deps && deps.onDegraded) await deps.onDegraded(stats.healthPort);
        await idleUntilStop();
        break;
      }
      const backoff = Math.min(2000 * Math.pow(2, failures - 1), 10000);
      await new Promise((rs) => setTimeout(rs, deps && deps.fastFail ? 1 : backoff));
    }
    cycle += 1;
    if (deps && deps.maxCycles && cycle >= deps.maxCycles) { stop(); break; }
  }
  try { health.close(); } catch {}
  return stats;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isMain = invokedPath && import.meta.url === invokedPath;
if (isMain) {
  runService().then((s) => {
    console.log("DSH-ILINK-BOT stopped", JSON.stringify(s));
  }).catch((e) => {
    console.error("DSH-ILINK-BOT fatal", e && e.code, e && e.message);
    process.exit(1);
  });
}
