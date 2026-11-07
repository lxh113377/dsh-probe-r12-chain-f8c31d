# probe-r12 — off-PC full judge-chain probe

Self-contained BYTE-FROZEN snapshot of the round 6-11 judge chain, assembled by the Lead
for one purpose: prove the LATEST chain runs unmodified on a clean Linux (ubuntu-latest)
hosted runner. This is NOT a deployment and NOT evidence that the objective is achieved.

- server-deploy/ : 24 BYTE-FROZEN files (MANIFEST.sha256 in provision/ seals them)
- provision/     : 12 live provision + judge files (copied verbatim, byte-identical)
- _goal-server/  : reboot_acceptance_gate.mjs (copied verbatim)
- .gitattributes : `* -text` so git cannot rewrite CRLF and drift byte hashes

Layout invariant: provision/, _goal-server/, server-deploy/ MUST stay siblings, because
collect_acceptance.mjs imports ../_goal-server/reboot_acceptance_gate.mjs, the gate imports
../provision/public_host_guard.mjs, and verify_frozen defaults to ../server-deploy.

Proves: latest judge chain + frozen product package are portable to a real clean Linux box.
Does NOT prove: 7x24 always-on service, real iLink token, real message round-trip, real
reboot self-start, PC-off survival, or public /_health. Ephemeral CI runner != always-on host.

Verdict is fail-closed with a negative control: every step emits a HIT: token; the final
step requires all nine and self-checks that deleting one token turns the check red.