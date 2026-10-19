# 0250 needs a read-only production preflight before deploy

status: open · origin: 2026-09-28 cleanup pr-08; 2026-10-05 established-findings audit · area: dossiers / typed wire / production migration

`migrations/alembic/versions/0250_dossier_latest_revision_only.py` irreversibly
deletes every non-current dossier revision with its build, events, queue row and
edges, drops `artifact_revisions.promoted_at` and the three `artifact_learn_*`
tables. record what those operations lose in production before release.

that release removed defaults from stored-json read models for dossier
manifests, chat `context_ref_added` activation and oracle `passage` citation.
these describe the historical 0250 boundary, not today's retired oracle event
output model. 0250 checks those facts before deleting revisions, but its guard
is incomplete. at `fc47d05a8754060181246f97f4d6935b744f10b8`,
`migrations/alembic/versions/0250_dossier_latest_revision_only.py:73–77` uses a
null-propagating `NOT` predicate: an otherwise complete citation without
`activation` produces sql null and escapes `WHERE`; line 69 has the same hole
for chat activation. this is source-qualified; production occurrence is
uninspected.

prerequisite: correct required-key predicates, including absent parents, with
`IS NOT TRUE` completeness checks before relying on this preflight. with read
access to production, count/report missing facts read-only and define any
backfill from actual stored meaning; do not invent activation or restore output
defaults. the corrected guard must return no rows. also record the loss counts:

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

acceptance: on a restored pre-0250 backup, missing-parent and incomplete chat
and citation activation controls refuse before mutation; complete controls,
including valid nullable members, stay valid. record actual missing-fact and
loss counts, verify the backup, and apply the corrected full chain. each head
has at most one revision after 0250, before later schema removals. delete this
ticket after.

main now follows `0250` with irreversible migration `0251`; its separate
production loss inventory is tracked in
[the 0251 ticket](schema-0251-production-loss-preflight.md). one verified backup
must cover the full migration chain.
