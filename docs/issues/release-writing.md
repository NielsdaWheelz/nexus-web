# release durable writing

status: implementation qualified locally; deployment is outside this change.

hard cutover replaces writing replies, attachment identities and browser delivery.
old writers must stop together with api/workers before migration; pair web, android
and extension clients through the existing release controller. writing advances
wire 13 to 14: production `99320b630` shipped wire 13 on october 22, before this
breaking acknowledgement and authoring cutover. web, api, apk and extension must
be built and paired at 14.

apply `0307_authored_identities` after the current `0306` baseline with a verified
backup and stopped writers. it backfills live roots and authored attachments and
refuses inconsistent owners. it cannot reconstruct identities deleted before the
migration. restore the backup for rollback; do not install an old writer against
the new schema.

review/export pending writing before a later incompatible journal/wire release;
never rewrite a sealed request under a new header or clear incompatible work.
release qualification includes the exact built desktop and android authoring,
restart recovery, replay after deletion, sign-out and receive/performance journeys.
the scoped concurrent writing/index-publication journey passed locally. this
does not establish global counter throughput or close the separate contention
stress qualification. native recovery-file cancellation, exact rich export and
completion-before-purge passed locally, as did desktop and android performance.
local server timings use the disposable database on tmpfs, with durability settings
disabled, and do not qualify production storage.

resolved when the paired source is released through the normal backup/migration
controller. local qualification is recorded in the pr; no
deployment or production-data change is authorized by this implementation task.
