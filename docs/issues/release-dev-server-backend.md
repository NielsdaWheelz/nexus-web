# dev-server backend activation is incomplete

frozen candidate: `b666d936f89b9bfa4811560a9e00c5ccc5482d94`, schema `0346`,
wire `24`. implementation: nexus prs #953/#954 and dev-server pr #221.
operating contract: [deployment](../../deployment.md).

the old backend's writers/native host are stopped and its nightly timer is
disabled. its final stopped-writer snapshot and fresh maintenance archive are
verified. the target restore committed; critical rows/heads/prefixes match,
runtime grants/password authentication and `ANALYZE` passed, and the target kept
its distinct physical cluster identity. no predecessor receipt, pointer or
native account file was copied. the owner-approved target vector catalog is
`0.8.7` with the same pinned image/library; the source remains `0.8.2`.

target postgres and credential egress are healthy. api, workers, native host,
connector and timer are OFF. the paired frontend is sealed but not activated.
fresh device sign-in is pending; use the [enrollment procedure](../runbooks/codex-personal-agent-host.md)
with one-off container logging disabled. an owned firefox profile holds durable
offline writing and remains isolated. the actual phone is disconnected; installed
android acceptance is unverified. preserve all app/profile data.

remaining: enroll, stop the old connector, run the sole paired release, verify
exact public identities and actual client writing/catch-up/search/import/native
generation, and qualify shared workload, backup/nightly and manual recovery.
then remove old restart paths/installed secrets, inventory retained offline data,
power off the old vps, delete temporary tests/fixtures and run the final static
gate. the old vps is not a standby; after target writes, recovery moves forward.

host privilege/socket/kernel limits and idle-engine preservation passed;
development has 2 gib soft / 3 gib hard limits, including the retained runner.
full rolling fleet apply was not run; inherited rootless activation remains deferred.
backend limits, public origins and auth stay unchanged. no resize, new alerts,
jarvis changes, forced reboot or automatic disaster reconciliation belongs here.
[manual backup checks](production-backup-freshness-alert.md), existing capacity
issues and [authored rewind recovery](authored-database-restore-recovery.md) remain
separate accepted limits. email ingest was unconfigured on source; preserve that.

resolved only after live acceptance, old-host retirement and temporary-test
removal. current preparation is not deployment completion.
