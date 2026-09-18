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

the 16.3-gib reservation is a physical-size heuristic, not a measured archive
size. on 2026-09-18 the operator selected a separate private cloudflare r2
bucket and explicitly accepted metered charges. no backup waiver is authorized.
existing media credentials cannot provision that bucket; the operator is
creating `nexus-database-backups` and supplying bucket-scoped credentials in
the ignored `deploy/env/env-prod-backup` file.

proposed fix: stream the stopped-writer custom-format dump to r2 with bounded
memory, retain the source digest before completing the multipart upload, and
require remote readback/archive verification before migration. keep credentials
out of ordinary application containers and preserve historical local evidence.

acceptance: a real r2 archive passes a disposable restore rehearsal; the default
release controller creates and verifies the fresh stopped-writer recovery point
without storing the full archive on the vps, and deployment succeeds with the
required backup policy. a waiver does not resolve this capacity gap.
