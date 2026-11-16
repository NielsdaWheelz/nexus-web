# backend deployment on dev-server is unqualified

status: implementation in progress; live cutover and target acceptance NOT_RUN.
operating contract: [deployment](../../deployment.md).

target preparation: reviewed host roles are applied; deployment elevation,
developer sudo/socket denial, kernel memory limits and idle-engine preservation
passed. development uses 2 gib soft / 3 gib hard limits, including the retained
hardware runner. existing services, sessions and rootless containers survived.
full rolling fleet apply was not run; inherited rootless activation remains deferred.
the new encrypted volume passed canonical-path close/reopen
with its separate off-host key and private uid/gid 10001 directories. no native
account has been enrolled and no old account files were copied.

owner choices: planned downtime/manual repair; existing system docker production
model; unchanged backend limits; nightly backups with nominal day-scale loss;
manual backup checks; old vps retained powered off. frontend and backend public
origins, auth, wire and product schema remain unchanged. no automatic alerts,
jarvis changes, host resize, memory tuning or forced host reboot.

scoped owner-approved exception: align the target pgvector catalog to `0.8.7`
after real restore/search checks, using the same pinned image and installed
library. preserve the source host's `0.8.2` catalog. this permits no other
extension, image, schema or wire upgrade; the
[catalog qualification](dev-server-vector-catalog.md) remains open until verified.

the shared devbox has 4 vcpus and 7.6 gib ram. its frontend, jarvis and development
load must fit together with nexus; idle measurements do not establish capacity.
dev-server owns host prerequisites, production-engine availability and development
limits. nexus owns release, data, runtime grants, native enrollment and backups.

remaining owner steps:

- qualify concurrent production/development load under the selected limits.
- publish split runtime/admin configuration, establish `nexus_runtime`, and
  rehearse an actual restore with the exact pg15/extensions image. prove ordinary
  api/worker use, administrative denial and retained migration/backup authority.
  archive traversal in `release_backup.py` alone does not prove restoration.
- freeze one new paired candidate at the deployed schema/wire. old-host work must
  settle through its owners before the final stopped-writer/session census and
  fresh backup.
- restore accepted state without copying backup receipts, release pointers or
  native account files. enroll the target account only after old native execution
  is fenced. run the existing paired release; never serve two restored histories.
- verify actual web/android/extension writing and catch-up, search, import,
  configured webhook delivery, native generation, fresh backup and manual unlock.
  qualify a normal nightly on an unused utc date; an old-cluster same-day archive
  stays intact. retire old containers/restart paths and installed credentials,
  retain only inventoried offline data/encrypted recovery material, then power off.

[developer root access](dev-server-developer-root-access.md),
[production docker ownership](dev-server-production-docker-owner.md) and
[runtime database privileges](production-database-login-is-superuser.md) stay open
until their real boundaries pass. close them individually with the implementation.

[backup notification](production-backup-freshness-alert.md) is explicitly deferred.
manual inspection confirms the timer is enabled and checks listed backup age and
journal; failures can remain unnoticed until then. listing is not byte verification.
the existing backend capacity issues and [authored disaster rewind](authored-database-restore-recovery.md)
remain separate accepted follow-ups. after target writes begin, the old database
cannot be resumed as failback.

resolved when the exact paired release and all above boundaries pass, manual
recovery works, only the new production path remains, and the old vps is fenced
and powered off. local/static proof alone does not establish that outcome.
