# three production processing repairs wait for the release, then #387

status: open, blocked on [the production release](production-release-pending-since-7dc68929b.md) · origin: 2026-09-28 investigation of pr #387 · area: processing recovery / release

## what is true

on 2026-09-28 a read-only production check found production at `7dc68929b` with alembic `0241`.

- the operator commands `normalize-web`, `correct-source-type` and `reprocess-source` (`python/nexus/ops/processing_recovery.py`) exist only on main. they came in with `fdfb911ea` on 2026-09-26, and production does not run that code. `docs/processing-recovery-execution.md` at `407fcc735` says "production release and exact-item repair not run".
- no `operator_*` rows exist in `resource_mutations`, so no repair has run.
- the three items:

| item | media | production state | publication generation | filings |
|---|---|---|---|---|
| this living hand | `16b411ce-d0f6-47aa-8bc6-22827cfb9ab0` | `web_article`, `ready_for_reading`; index revision 0, `pending` since 2026-06-08 | 2 | 1 |
| letters of keats to fanny brawne | `51c2b8a8-1352-4bde-9f87-4a8234e6dc13` | same | 2 | 1 |
| gutenberg 38145 | `08d23b86-7042-4c72-bfe6-7faa5a696bee` | `web_article`, `failed`, `E_INGEST_FAILED` (2026-07-03); latest attempt `3d0b5134-9fc9-4ce0-925b-26bf0ce7ef22` is `generic_web_url` | none | 2 |

pr #387 deletes `normalize-web` and `correct-source-type`. merging it before these repairs would delete the only tooling for them. it also conflicts with main in `python/nexus/services/reader_publication.py`, after #403. the 0243 fix its body asks for (`3029201f9`) is already on main.

## what to do, after the release

1. re-read the guards. migrations 0242–0252 may move them:
   ```sql
   SELECT p.media_id, p.generation, s.revision, s.status
   FROM reader_publications p
   JOIN content_index_states s ON s.owner_kind = 'media' AND s.owner_id = p.media_id
   WHERE p.media_id IN ('16b411ce-d0f6-47aa-8bc6-22827cfb9ab0', '51c2b8a8-1352-4bde-9f87-4a8234e6dc13');
   SELECT id, source_type, status FROM media_source_attempts
   WHERE media_id = '08d23b86-7042-4c72-bfe6-7faa5a696bee' ORDER BY created_at DESC LIMIT 1;
   ```
2. run each command once, on the production host, with a fresh mutation id. rerunning with the same id returns the same receipt:
   ```sh
   docker exec nexus-api-1 python -m nexus.ops.processing_recovery normalize-web 16b411ce-d0f6-47aa-8bc6-22827cfb9ab0 <generation> <index_revision> <mutation_id>
   docker exec nexus-api-1 python -m nexus.ops.processing_recovery normalize-web 51c2b8a8-1352-4bde-9f87-4a8234e6dc13 <generation> <index_revision> <mutation_id>
   docker exec nexus-api-1 python -m nexus.ops.processing_recovery correct-source-type 08d23b86-7042-4c72-bfe6-7faa5a696bee <attempt_id> generic_web_url <mutation_id>
   ```
   paste each printed json receipt here.
3. verify the keats items, per [the keats ticket](old-web-publications-lack-index-heading-normalization.md):
   - both indexes are `ready`, and search resolves their passages;
   - reader positions survive. letters keeps its revision-1 cursor at text offset 52 in the same fragment. this living hand keeps its empty revision-2 cursor.
4. verify the gutenberg item, per [the gutenberg ticket](gutenberg-failed-import-retains-obsolete-web-adapter.md): it publishes as a readable epub under the same media id, with its 2 filings and its history intact and no failed duplicate.
5. close those two tickets. rebase #387 onto main, resolving the `reader_publication.py` conflict, rerun `./scripts/test` and merge it.

## done when

the three receipts are recorded here, all three items pass verification, both tickets are closed, and #387 is merged.
