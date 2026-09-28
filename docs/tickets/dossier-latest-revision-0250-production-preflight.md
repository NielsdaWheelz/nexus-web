# 0250 needs a read-only production preflight before deploy

status: open · origin: 2026-09-28 cleanup pr-08 (cleanup/dossier-latest-revision) · area: dossiers / typed wire / production migration

`migrations/alembic/versions/0250_dossier_latest_revision_only.py` irreversibly
deletes every non-current dossier revision with its build, events, queue row and
edges, drops `artifact_revisions.promoted_at` and the three `artifact_learn_*`
tables. nobody has counted what that loses in production.

the same PR drops the `None` defaults and list factories from the models that
load stored json on read: dossier manifests (head read), the chat
`context_ref_added` activation (`services/message_trust_trails.py:145`) and the
oracle `passage` citation (`schemas/oracle.py` `OracleReadingEventOut`). 0250's
`upgrade()` refuses, before any change, while a stored row lacks one of those
keys. run that guard's query read-only first, so the release does not stop
halfway: if it returns rows, add a backfill `UPDATE` per case to 0250 (key as
`[]` or `null`); do not restore the defaults.

prerequisite: read access to the production database. run, read-only, the guard
query in `upgrade()` (must return no rows) and the loss counts:

```sql
SELECT a.subject_scheme, count(*) FROM artifact_revisions r
  JOIN artifact_builds b ON b.id = r.build_id JOIN artifacts a ON a.id = b.artifact_id
WHERE a.current_revision_id IS DISTINCT FROM r.id GROUP BY 1;
SELECT e.origin, e.ordinal IS NOT NULL AS cited,
       e.source_scheme = 'artifact_revision' AS from_revision, count(*)
  FROM resource_edges e JOIN artifact_revisions r
    ON (e.source_scheme = 'artifact_revision' AND e.source_id = r.id)
    OR (e.target_scheme = 'artifact_revision' AND e.target_id = r.id)
  JOIN artifact_builds b ON b.id = r.build_id JOIN artifacts a ON a.id = b.artifact_id
WHERE a.current_revision_id IS DISTINCT FROM r.id GROUP BY 1, 2, 3;
SELECT (SELECT count(*) FROM artifact_learn_requests),
       (SELECT count(*) FROM artifact_learn_successes),
       (SELECT count(*) FROM artifact_learn_failures);
```

edges with `cited` and not `from_revision` (a chat citing an old revision)
survive and resolve missing; every other counted edge (citations the revision
made, user links, conversation context, link-note motifs whole) is deleted.

the backend deploy and 0250 follow the web deploy (the web reads both head
shapes). verify the backup first: it is the only copy of what 0250 deletes, and
the pre-0250 backend cannot run on the migrated schema, so a backend rollback
means restoring the previous application and the backup together, losing every
write since.

acceptance: recorded loss counts and an empty guard query, then 0250 applies and
each head has at most one revision. delete this ticket after.

main now follows `0250` with irreversible migration `0251`; its separate
production loss inventory is tracked in
[the 0251 ticket](schema-0251-production-loss-preflight.md). one verified backup
must cover the full migration chain.
