status: open
origin: 2026-09-18 deployment preflight, candidate 8cc387c521ea6376cd7f89e63be9310702bc5068
area: release operations / backup capacity

the default backup policy cannot currently admit a release on the production
vps. read-only inspection found the product database is 8240 mb, while the
38-gib root filesystem has 5.9 gib free. `deploy/hetzner/release.py:4052-4060`
requires twice `pg_database_size` plus 256 mib before stopping writers.
`docker system df` reports only 4.939 gb of reclaimable images, which is
insufficient even before pulling the candidate. the only existing backup is
`/var/backups/nexus/823b371332e51244a1fc31632a3234f794288eb4.dump` (363 mib,
2026-08-12); it is not a fresh release recovery point.

prerequisite: choose sufficient backup storage or explicitly accept the
runbook's durable `--no-database-backup` waiver for this release. do not reduce
the capacity gate or remove durable production data to force admission.

acceptance: the default release preflight has sufficient verified disk for a
fresh stopped-writer backup, and the controller creates and verifies it. a
one-release waiver permits deployment but does not resolve this capacity gap.
