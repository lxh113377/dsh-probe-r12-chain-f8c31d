// independent_probe.mjs — raw global fetch; does NOT import bot.mjs.
// Independent confirmation that the real iLink endpoint answers via pure HTTP.
const host = process.env.DSH_RAW_HOST || "https://ilinkai.weixin.qq.com/";
const url = new URL("ilink/bot/getupdates", host).toString();
const body = JSON.stringify({
  get_updates_buf: "",
  base_info: { channel_version: "2.4.6", bot_agent: "DeepSeekHarness/1.1.0" },
});
const headers = {
  "Content-Type": "application/json",
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": "132102",
  "AuthorizationType": "ilink_bot_token",
  "X-WECHAT-UIN": Buffer.from("1234").toString("base64"),
  "Authorization": "Bearer faketoken-not-real",
};
const t = Date.now();
try {
  const r = await fetch(url, { method: "POST", headers: headers, body: body, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  console.log("RAW-HTTP status=" + r.status + " ms=" + (Date.now() - t));
  console.log("RAW-BODY " + text.slice(0, 300));
  let rejected = false;
  try {
    const j = JSON.parse(text);
    rejected = (j.ret !== undefined && j.ret !== 0) || (j.errcode !== undefined && j.errcode !== 0);
  } catch (e) { rejected = r.status === 401 || r.status === 403; }
  console.log("RAW-PROBE-OK reached_real_endpoint=true fake_token_rejected=" + rejected + " pure_http=true");
} catch (e) {
  console.log("RAW-PROBE-UNREACHABLE code=" + (e && e.name) + " msg=" + (e && e.message));
  process.exitCode = 2;
}
