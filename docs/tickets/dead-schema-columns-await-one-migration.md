# dead schema columns and tables await one alembic revision

status: open · origin: 2026-09-17 slop sweep (claude session) · area: schema ·
oi-152

the slice PRs of the sweep remove the code-side writers and readers of a set of
columns and tables, each verified write-only or unread. the DDL is deliberately
held back into one serial alembic revision so the repo takes a single migration
and a single backup, rather than one per slice.

columns to drop, with the slice that removes their code side:

- `artifact_build_failures.support` + its CHECK (ART-05)
- `artifact_learn_failures.error_code` (ART-16; NOT NULL, and
  `record_learn_unresolved` writes the literal until this lands)
- `resource_mutations.changed_lanes` +
  `ck_resource_mutations_changed_lanes_object` (PYDB-05; write-only ledger
  column, `record_replay` parameter plus 27 call sites in 16 files)
- `passage_anchors.selector_version`, recreating `uq_passage_anchors_identity`
  (SVC-14)
- `stripe_webhook_events.processed_at` (py-db M-05)
- `document_embed_artifact_states.extraction_error_code` +
  `extraction_error_message` (SVCDOC-04)
- `fragment_blocks.block_type` + `is_empty` (SVCDOC-10)
- `epub_resources.fallback_item_id` + `manifest_item_id` + `properties`
  (SVCDOC-16 / M-01)
- `libraries.color` (SVCLIB-03; always NULL)
- `resource_versions.content_hash` + its CHECK (RS-11)
- `resource_grants.share_token_hash` + its unique index (RS-12)
- `resource_external_snapshots.source_snapshot` +
  `ck_resource_external_snapshots_source_object` (M-01)

tables to drop: `podcast_transcript_request_audits` (POD-01; write-only audit
ledger), `billing_entitlement_override_events` (SAM-02; write-only audit
table), `external_provider_events` with `record_external_provider_event`, its
three `x_ingest.py` call sites (1026, 1065, 1098) and the two FK-nulling UPDATEs
at `services/media_deletion.py:680,691` (GEN-02), plus the dead tables the py-db
verifier confirms.

not in scope: the trust prompt-assembly fields stay in `chat_prompt_assemblies`;
SCH-10 removes only their wire projection.

prerequisites: every listed slice PR has landed, so no code writes or reads the
column when the DDL runs. `external_provider_events` additionally contradicts
`docs/modules/web-article.md:35` and `docs/architecture.md:1093`, which must be
corrected in the same change. the release controller requires a verified backup
while a migration is pending.

fix: one alembic revision holding every DROP above, run after the slice PRs,
with the doc corrections in the same commit.

acceptance: `pg_dump --schema-only` shows none of the listed columns, tables,
constraints or indexes; the migration is at the new head; `./scripts/test`
passes and an import, a reader open and a dossier build still work.
