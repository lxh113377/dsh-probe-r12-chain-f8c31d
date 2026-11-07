#!/usr/bin/env node
// provision/public_host_guard.mjs - 达标闸 C2 私网/保留地址骗绿拦截器（Round 8 加严，非凑绿）
// WHY: 前轮 P13/P16 两次独立审计点出 judge() 的 C2 只挡 loopback，RFC1918 / CGNAT /
//   link-local / ULA IPv6 / TEST-NET 这类「非回环但明确非公网可路由」字面会被当合格 host
//   放行，正是 S2 伪造证据包骗绿反例的入口。本件补静态分类器，作为 judge() 的额外拒绝项。
// HOW: classifyPublicHost(h) 纯函数，只判「host 字面是否明显不可能是公网可路由目标」：
//   - IP 字面：私网/回环/CGNAT/link-local/TEST-NET/组播/保留 -> routable=false
//   - 域名：一律 routable=true 但 kind=DOMAIN，附注「静态不可证明 DNS/WAN 可达，由 C7 真 fetch 裁决」
//     （不伪造「域名已公网可达」结论；.test/.invalid/.example 等保留 TLD 由 C7 真 fetch 必然翻红兜底）
//   - localhost/*.local（mDNS，明确非公网）-> false
//   这是加严（新增拒绝项），让更多声明翻红，绝不推进 PASS。import-safe + --selftest 负控有牙。
// D10.2: 判据自身必须可被父级独立复跑 -> 导出纯函数，isMain 守卫，不 process.exit。

import { pathToFileURL } from 'node:url';

function isDigits(t) {
  if (!t) return false;
  for (let i = 0; i < t.length; i += 1) { const c = t.charCodeAt(i); if (c < 48 || c > 57) return false; }
  return true;
}

function ipv4(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  const n = [];
  for (const seg of p) { if (!isDigits(seg)) return null; const v = Number(seg); if (v < 0 || v > 255) return null; n.push(v); }
  return n;
}

// classifyPublicHost：纯字符串判定，不用正则（避免反斜杠转义坑），fail-closed。
export function classifyPublicHost(h) {
  let s = typeof h === 'string' ? h.trim() : '';
  const note = 'DOMAIN: 静态不可证明公网可路由，最终由 C7 真 /_health fetch 裁决';
  // URL.hostname 对 IPv6 字面返回带方括号形态（[::1] / [fe80::1]），先剥掉再判；
  // 否则首字符 '[' 绕过 IPv6 回环/ULA/link-local 拦截，会被误判成 IPV6_GUA 放行。
  if (s.length >= 2 && s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') s = s.slice(1, -1);
  if (!s) return { routable: false, ok: false, kind: 'EMPTY', note: 'empty host' };
  if (s.indexOf('://') >= 0 || s.indexOf('/') >= 0 || s.indexOf('#') >= 0 || s.indexOf('?') >= 0 || s.indexOf(' ') >= 0)
    return { routable: false, ok: false, kind: 'NOT_HOST_LITERAL', note: 'URL/含非法字符，不是 host 字面' };
  const low = s.toLowerCase();
  if (low === 'localhost' || low.endsWith('.localhost') || low.endsWith('.local'))
    return { routable: false, ok: false, kind: 'LOCAL_MDNS', note: 'localhost/mDNS 明确非公网' };
  const hasColon = s.indexOf(':') >= 0;
  const hasDot = s.indexOf('.') >= 0;
  const v4 = hasDot && !hasColon ? ipv4(s) : null;
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return { routable: false, ok: true, kind: 'WILDCARD_UNSPEC', note: '0.0.0.0/8 通配/未指定' };
    if (a === 127) return { routable: false, ok: true, kind: 'LOOPBACK', note: '127/8 回环' };
    if (a === 10) return { routable: false, ok: true, kind: 'RFC1918', note: '10/8 私网' };
    if (a === 172 && b >= 16 && b <= 31) return { routable: false, ok: true, kind: 'RFC1918', note: '172.16/12 私网' };
    if (a === 192 && b === 168) return { routable: false, ok: true, kind: 'RFC1918', note: '192.168/16 私网' };
    if (a === 169 && b === 254) return { routable: false, ok: true, kind: 'LINK_LOCAL', note: '169.254/16 链路本地' };
    if (a === 100 && b >= 64 && b <= 127) return { routable: false, ok: true, kind: 'CGNAT', note: '100.64/10 运营商级 NAT' };
    if (a === 192 && b === 0 && v4[2] === 2) return { routable: false, ok: true, kind: 'TEST_NET', note: '192.0.2/24 TEST-NET-1' };
    if (a === 198 && b === 51 && v4[2] === 100) return { routable: false, ok: true, kind: 'TEST_NET', note: '198.51.100/24 TEST-NET-2' };
    if (a === 203 && b === 0 && v4[2] === 113) return { routable: false, ok: true, kind: 'TEST_NET', note: '203.0.113/24 TEST-NET-3' };
    if (a >= 224) return { routable: false, ok: true, kind: 'RESERVED_MULTICAST', note: '224/4 组播或 240/4 保留' };
    return { routable: true, ok: true, kind: 'PUBLIC_IPV4', note: '公网形态 IPv4（仍须 C7 真 fetch 证可达）' };
  }
  if (hasColon) {
    if (low === '::1' || low === '::' || low === '[::]') return { routable: false, ok: true, kind: 'IPV6_LOOPBACK_WILDCARD', note: 'IPv6 回环/通配' };
    if (low.startsWith('fc') || low.startsWith('fd')) return { routable: false, ok: true, kind: 'IPV6_ULA', note: 'fc00::/7 唯一本地地址' };
    if (low.startsWith('fe80') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb'))
      return { routable: false, ok: true, kind: 'IPV6_LINK_LOCAL', note: 'fe80::/10 链路本地' };
    return { routable: true, ok: true, kind: 'IPV6_GUA', note: 'IPv6 公网形态（仍须 C7 真 fetch 证可达）' };
  }
  if (hasDot) {
    if (!ipv4(s) && /[a-z]/i.test(s)) return { routable: true, ok: true, kind: 'DOMAIN', note: note };
    return { routable: false, ok: false, kind: 'BAD_HOST_LITERAL', note: '既非合法 IPv4 也非域名' };
  }
  return { routable: false, ok: false, kind: 'UNKNOWN_HOST_LITERAL', note: '无点无冒号的裸字面，不认定为公网 host' };
}

// isRoutableHost：judge() 用的薄封装，只暴露布尔，便于 import 作 need()。
export function isRoutableHost(h) { return classifyPublicHost(h).routable === true; }

function selftest() {
  const cases = [];
  const add = (name, ok) => cases.push({ name, ok });
  const blocked = ['10.0.0.1','192.168.1.1','172.16.0.1','172.31.255.254','169.254.1.1',
    '100.64.0.1','127.0.0.1','0.0.0.0','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1',
    '::1','::','[::]','fc00::1','fd12::1','fe80::1','[::1]','[fe80::1]','[fc00::1]','localhost','foo.local','wechat.localhost'];
  for (const h of blocked) add('NEG_BLOCK_' + h, classifyPublicHost(h).routable === false);
  const allowed = ['8.8.8.8','1.1.1.1','93.184.216.34','bot.example.com','ilinkai.weixin.qq.com','health.dsh-bot.net','2001:4860:4860::8888','[2001:4860:4860::8888]'];
  for (const h of allowed) add('POS_ALLOW_' + h, classifyPublicHost(h).routable === true);
  add('NEG_EMPTY', classifyPublicHost('').routable === false);
  add('NEG_URL_FORM', classifyPublicHost('https://bot.example.com/_health').routable === false);
  add('NEG_BAD_IPV4', classifyPublicHost('999.1.1.1').routable === false);
  add('DOMAIN_KIND_NOT_FAKING_WAN', classifyPublicHost('bot.example.com').kind === 'DOMAIN');
  // 有牙核心：把分类器从判定链摘掉（as-if 直通），私网 IP 又会「通过」；装上后才拒。
  const lan = '10.134.65.165';
  const withoutGuard = (h) => true;
  add('NEGCTL_GUARD_HAS_TEETH', withoutGuard(lan) === true && isRoutableHost(lan) === false);
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('SELFTEST ' + (c.ok ? 'OK  ' : 'FAIL') + ' ' + c.name);
  const teeth = cases.filter((c) => c.name.indexOf('NEG_') === 0 || c.name.indexOf('NEGCTL_') === 0).length;
  console.log('PUBLIC-HOST-GUARD-' + (bad.length === 0 ? 'OK' : 'FAIL') + ' cases=' + cases.length + ' teeth=' + teeth);
  return bad.length === 0;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
const isMain = invoked && import.meta.url === invoked;
if (isMain) { const ok = process.argv.slice(2).includes('--selftest') ? selftest() : (console.log(JSON.stringify(classifyPublicHost(process.argv[2] || ''))), true); process.exitCode = ok ? 0 : 1; }
