# testing reset, 2026-09-17

user decision: remove every automated test, with no survivor suite. remove the
fixtures, synthetic development seed data, harnesses, dependencies, caches,
and production seams that exist only to support them. keep static checks under
`./scripts/test` and proportionate
manual verification. new tests must earn their maintenance cost; rebuilding a
suite is not a goal.

[the local verification contract](local-rules/testing-standards.md) supersedes
older test and proof obligations, including shared testing rules. historical
product cutovers retain their requirements and original evidence, but their
removed test paths and commands are not current instructions. the obsolete
testing-infrastructure cutover is deleted.

retired proof-only follow-ups: oi-009, oi-014, oi-015, oi-017, oi-022, oi-037,
oi-038, and oi-041. oi-020 is resolved by removing the reindex embedding seam.
the superseded-testing-cutover ticket is resolved by deleting that plan.
retired infrastructure follow-ups: oi-088 (deleted setup action), oi-114 and
oi-120 (removed capacity qualification), and oi-117 (removed auth smoke).

unconfirmed product concerns from old runs remain as manual investigations:
durable activity storage, mobile reader navigation, and supervisor import
memory. actual defects and unreviewed product surfaces stay in the
[outstanding-work register](outstanding-issues.md).

the android player compatibility identity remains a runtime contract in
`contracts/android-player-protocol.json`; removing the corpus does not change
the identity accepted by installed clients. synthetic deployment auth smoke
and capacity canaries are removed too.
runtime health, readiness, identity, resource limits, and migration backups
remain deployment invariants.

verification: `./scripts/test`, the offline reader build, and the android debug
build passed. the offline build still emits the already-tracked custom-highlight
css warning. deployment changes were reviewed without running a production release.
