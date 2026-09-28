# evidence span block pointers are write-only

status: open · origin: 2026-09-28, pr-05 cleanup/search-locators (claude session) · area:
content index / schema

`evidence_spans.start_block_id`, `end_block_id`, `start_block_offset` and
`end_block_offset`, with `evidence_spans_{start,end}_block_id_fkey`,
`ix_evidence_spans_{start,end}_block_id`, `ck_evidence_spans_offsets` and
`ck_evidence_spans_start` (`migrations/alembic/versions/0236_baseline_schema.sql:1035-1050,5069,5090,6051,6059`),
have no reader. the only one was `locator_resolver._evidence_span_snapshot_matches`,
deleted by cleanup/search-locators. `content_indexing.publish_content_index`
(`python/nexus/services/content_indexing.py:855-908`) still writes them, and
collects `block_ids` through `RETURNING id` only to fill them. `content_blocks`
itself stays: `vault._load_content_blocks` (`python/nexus/services/vault.py:611-618`)
reads its text.

fix: one migration drops the four columns, both fks, both indexes and both
checks; the writer stops collecting `block_ids`. the columns are `NOT NULL`, so
the migration and the writer change ship in one backend deploy; a reindex that
an old worker runs after the migration fails and retries.

acceptance: the static gate passes; reindexing a pdf, an epub and a note
succeeds; search and `GET /media/{id}/evidence/{span}` return the same json as
before.
