# 0259 needs a read-only production preflight before deploy

status: open · origin: 2026-10-04 dossier reauthor (cleanup/dossier-reauthor) · area: dossiers / production migration

`migrations/alembic/versions/0259_dossier_head_carries_revision.py` folds
`artifact_revisions` into its head (revision ids preserved), replaces the three
terminal-child tables and the event log with `artifact_builds.status`, rekeys
idea subjects by `title_key` and drops `artifact_idea_resolutions`. it refuses,
before any change, on rows the new shape cannot hold (its docstring lists them)
and is irreversible.

run read-only against production first, from the docstring: the refusal query
(`_PREFLIGHT`, must return no rows) and the three loss counts (active builds the
migration cancels, heads that will read stale, superseded failed/cancelled
builds it deletes). verify the backup: it is the only copy of event rows,
failure detail of deleted builds, cancellation actors and idea resolutions.

dry run (2026-10-04, throwaway pg15, fixtures for every subject kind and build
outcome): refusal fired once per seeded defect and left the db at 0258; the
upgrade cancelled 8 active builds, deleted their jobs and released the held
Heavy lease, deleted 8 superseded builds, carried coverage counts per old
manifest kind and model/tokens from the ledger, and every `artifact_revision:`
ref (edges, view states, versions, turn contexts) still resolved.

release order: stop writers, backup, migrate, start api and worker, deploy web
(the head shape, sse protocol and learn copy change together).

acceptance: recorded production counts and an empty refusal query, then 0259
applies; delete this ticket after.
