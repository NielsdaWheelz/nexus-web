# model cutover owner check queries a dropped table

status: open · origin: 2026-10-04 dossier reauthor (cleanup/dossier-reauthor, design §8.9) · area: model cutover / llm ledger

`python/nexus/model_cutover_archive.py:246-248` checks `artifact_learn_request`
owners with `EXISTS (SELECT 1 FROM artifact_learn_requests ...)`. migration 0250
dropped that table, so postgres rejects the whole statement at parse time and
the next model cutover's original-owner validation fails before it reads a row.
pre-existing since 0250; not fixed in the dossier slice.

related: deleting a build orphans its `artifact_build` ledger rows (owner check
`EXISTS (SELECT 1 FROM artifact_builds ...)` at `:246`). the dossier rewrite adds
orphans: publish deletes every other build of its head (superseded failures and
cancellations), and 0259 cancels in-flight builds and deletes failed or
cancelled builds older than their head's revision. a cutover must list these as
reviewed orphan parents (`archive_orphan_generation_ids`).

fix: drop the `artifact_learn_request` arm (no such owner can be written since
0250; any surviving ledger rows are orphans to acknowledge), and count dossier
build orphans in the cutover's reviewed list.

acceptance: the owner-existence query parses on a post-0259 schema, and a dry
cutover over a restored production copy lists every dossier orphan explicitly.
