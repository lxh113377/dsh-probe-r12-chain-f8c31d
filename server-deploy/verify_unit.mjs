// server-deploy/verify_unit.mjs
// #47 machine gate 6 (r4): the REAL systemd parser must accept the installed
// unit + generated drop-in BEFORE any restart. A pure static string gate cannot
// catch a malformed unit or a nonexistent ExecStart binary; the real
// `systemd-analyze verify` can (RC=1 on bad ExecStart / bad setting, RC=0 +
// warning on unknown key / missing '='). judge() is pure: mutants + a forced-fail
// negative control prove the gate is not a constant-green shell. Closes D6.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Patterns the real parser emits when something is wrong. Some are fatal
// (RC=1), some are warnings (RC=0); reject BOTH so the gate has teeth.
// "unrecognized option" also counts: a bad CLI form (e.g. passing the unit as
// an option) must never be mistaken for a clean verify.
const BAD_PATTERNS = [
  /not executable/i,
  /bad unit file setting/i,
  /more than one ExecStart/i,
  /Refusing/i,
  /Unknown key/i,
  /Missing '='/i,
  /Unknown section/i,
  /unrecognized option/i,
];

export function judge(sa, opts) {
  const gw = !!(opts && opts.greenwash);
  const rc = Number(sa.rc);
  const out = String(sa.output || '');
  const hits = BAD_PATTERNS.filter((p) => p.test(out));
  const checks = [];
  checks.push({ n: 'parser_available', ok: sa.available !== false, ev: 'available=' + sa.available });
  checks.push({ n: 'rc_zero', ok: rc === 0, ev: 'rc=' + rc });
  checks.push({ n: 'no_parser_defects', ok: hits.length === 0, ev: hits.map(String).join(',') });
  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, total: checks.length, greenwash: gw, ok: gw ? false : passed === checks.length };
}

// Real mode: run the actual systemd parser on the unit at unitPath; adjacent
// .d/*.conf drop-ins are discovered automatically (proven on WSL2 systemd 259).
export function verifyReal(unitPath) {
  const r = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    return { available: false, rc: 127, output: 'systemd-analyze not found (ENOENT): fail-closed' };
  }
  return { available: true, rc: r.status, output: (r.stdout || '') + (r.stderr || '') };
}

function selftest() {
  const CLEAN = { available: true, rc: 0, output: '' };
  const mutants = [
    ['M1_BAD_RC', { available: true, rc: 1, output: 'bad unit file setting' }],
    ['M2_NOT_EXEC', { available: true, rc: 0, output: 'Command /x/node is not executable: No such file' }],
    ['M3_UNKNOWN_KEY', { available: true, rc: 0, output: "Unknown key 'Bogus' in section [Service], ignoring." }],
    ['M4_MISSING_EQ', { available: true, rc: 0, output: "Missing '=', ignoring line." }],
    ['M5_NO_PARSER', { available: false, rc: 127, output: 'ENOENT' }],
    ['M6_DUP_EXECSTART', { available: true, rc: 1, output: 'Service has more than one ExecStart= setting. Refusing.' }],
    // Real r4 bug: deploy.sh passed `--verify` AS the unit path, so the child
    // ran `systemd-analyze verify --verify`. Even at rc=0 a parser that merely
    // warns must be rejected, so the gate has teeth on the CLI form too.
    ['M7_UNRECOGNIZED_OPTION', { available: true, rc: 0, output: "systemd-analyze: unrecognized option '--verify'" }],
  ];
  const lines = [ 'BASE clean accepted=' + judge(CLEAN, {}).ok ];
  let allRejected = true;
  for (const [name, sa] of mutants) {
    const rejected = !judge(sa, {}).ok;
    lines.push(name + ' rejected=' + rejected);
    if (!rejected) allRejected = false;
  }
  const gwRejected = !judge(CLEAN, { greenwash: true }).ok;
  lines.push('GREENWASH rejected=' + gwRejected);
  const ok = allRejected && gwRejected && judge(CLEAN, {}).ok;
  console.log(lines.join('\n'));
  console.log((ok ? 'VERIFY-UNIT-SELFTEST-OK' : 'VERIFY-UNIT-SELFTEST-FAIL') + ' mutants=' + (mutants.length + 1));
  process.exitCode = ok ? 0 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
const isMain = invoked && import.meta.url === invoked;
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--selftest') { selftest(); }
  else {
    // Accept both the explicit form deploy.sh uses (--verify <unit>) and the
    // bare positional form (<unit>). Older wiring passed `--verify` AS the unit
    // path, which produced `systemd-analyze verify --verify`; this parser keeps
    // that class of mistake from ever reaching a real deploy.
    const unit = args[0] === '--verify' ? args[1] : args[0];
    if (!unit) { console.error('usage: verify_unit.mjs --selftest | --verify <unit-path> | <unit-path>'); process.exitCode = 2; }
    else {
      const gw = process.env.VERIFY_UNIT_GREENWASH === '1';
      const sa = verifyReal(unit);
      const r = judge(sa, { greenwash: gw });
      r.checks.filter((c) => !c.ok).forEach((c) => console.log('  FAIL ' + c.n + ': ' + c.ev));
      console.log('VERIFY-UNIT-EVIDENCE ' + JSON.stringify({ rc: sa.rc, available: sa.available, outLen: String(sa.output).length, greenwash: r.greenwash }));
      // A fail-closed gate must say WHY. Emit the real parser text so a bad
      // unit/drop-in can be diagnosed without re-running systemd-analyze by hand.
      console.log('VERIFY-UNIT-OUTPUT ' + JSON.stringify(String(sa.output).slice(0, 500)));
      console.log((r.ok ? 'VERIFY-UNIT-OK' : 'VERIFY-UNIT-FAIL') + ' checks=' + r.passed + '/' + r.total + (gw ? ' greenwash=on' : ''));
      process.exitCode = r.ok ? 0 : 1;
    }
  }
}
