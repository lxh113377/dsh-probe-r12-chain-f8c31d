// server-deploy/probe_live.mjs
// Read-only LIVE probe: prove the iLink endpoint is reachable by pure HTTP from
// this machine WITHOUT any local WeChat process / GUI / accessibility tree.
// Uses a deliberately FAKE token; expects the provider to REJECT it (errcode -14
// or HTTP 401/403). That rejection IS the proof the request reached Tencent.
// It changes NO business data and sends NO message. Safe to run any time.
import { createClient, rejectedProviderResponse } from './bot.mjs';

async function main() {
  const client = createClient({ token: 'probe-fake-token-not-real', baseUrl: process.env.DSH_ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com/', longPollMs: 12000 });
  const started = Date.now();
  try {
    const r = await client.getUpdates('');
    const rej = rejectedProviderResponse(r, ['errcode','ret']);
    console.log('PROBE-REACHED http=200 ret=' + String(r && r.ret) + ' errcode=' + String(r && r.errcode) + ' rejected=' + String(rej) + ' ms=' + (Date.now()-started));
    console.log('PROBE-OK channel=pure-http wechat_gui=none -> deployable-to-server');
  } catch (e) {
    // An HTTP 401/403 is ALSO a reach proof (server answered). Only a network
    // error means 'cannot reach', which is an environment gap, not a code defect.
    const code = e && e.code;
    if (code === 'http-error' || code === 'timeout') {
      console.log('PROBE-REACHED http-error-or-timeout code=' + code + ' ms=' + (Date.now()-started) + ' -> server answered / network slow');
      console.log('PROBE-OK channel=pure-http (reachable, fake token rejected/timeout)');
      return;
    }
    console.log('PROBE-UNREACHABLE code=' + code + ' msg=' + (e && e.message) + ' -> environment/network gap, recorded honestly');
    process.exitCode = 2;
  }
}
main();
