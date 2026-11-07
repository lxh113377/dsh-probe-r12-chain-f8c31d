// server-deploy/login.mjs
// One-time QR login so the SERVER obtains its OWN iLink bot token.
// Pure HTTP, zero GUI. The only human step is scanning the QR once with WeChat.
// Never prints the token to stdout; writes it to an env file with mode 0600.
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient } from './bot.mjs';

const POLL_INTERVAL_MS = 2500;

async function main() {
  const envOut = process.env.DSH_ILINK_ENV_OUT || '/etc/dsh-ilink-bot/env';
  const client = createClient({ baseUrl: process.env.DSH_ILINK_BASE_URL || undefined, token: null });
  const begin = await client.beginLogin();
  console.log("QR_LOGIN url=" + begin.qrcodeUrl);
  console.log("QR_LOGIN scan the QR above with WeChat, then wait for confirmation (one-time).");
  let tries = 0;
  while (tries < 240) {
    const r = await client.pollLogin(begin.qrcode, process.env.DSH_ILINK_VERIFY_CODE);
    tries += 1;
    if (r.status === 'confirmed') {
      const token = r.bot_token, botId = r.ilink_bot_id, owner = r.ilink_user_id;
      if (!token || !owner) throw new Error('incomplete login response');
      const lines = [ 'DSH_WEIXIN_ILINK_TOKEN=' + token,
        'DSH_ILINK_OWNER_USER_ID=' + owner,
        'DSH_ILINK_BOT_ID=' + (botId || ''),
        (r.baseurl ? ('DSH_ILINK_BASE_URL=' + r.baseurl) : ''),
      ].filter(Boolean);
      // login runs BEFORE deploy.sh (README step 2), so its env directory may
      // not exist yet. Create it root-owned 0755; the token file itself stays 0600.
      mkdirSync(dirname(envOut), { recursive: true, mode: 0o755 });
      writeFileSync(envOut, lines.join('\n') + '\n', { mode: 0o600 });
      try { chmodSync(envOut, 0o600); } catch {}
      console.log("QR_LOGIN confirmed owner=" + owner + " env_file=" + envOut + " (token written, mode 0600, not printed)");
      return;
    }
    if (r.status === 'expired' || r.status === 'verify_code_blocked' || r.status === 'binded_redirect') {
      throw new Error('login ended: ' + r.status);
    }
    if (r.status === 'need_verifycode' && !process.env.DSH_ILINK_VERIFY_CODE) {
      console.log('QR_LOGIN need_verifycode: set DSH_ILINK_VERIFY_CODE and rerun');
    }
    await new Promise((rs) => setTimeout(rs, POLL_INTERVAL_MS));
  }
  throw new Error('login timed out waiting for QR confirmation');
}

main().catch((e) => { console.error("QR_LOGIN failed", e && e.message); process.exit(1); });
