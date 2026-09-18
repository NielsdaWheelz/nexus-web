# artifact_build_failures.support awaits its wire removal

status: open · origin: 2026-09-17 slop sweep (claude session) · area: schema ·
oi-152

migration 0234 dropped every other column and table this ticket held: the
`resource_mutations.changed_lanes` ledger column and its CHECK, the
`passage_anchors.selector_version` identity component (with
`uq_passage_anchors_identity` recreated without it),
`resource_grants.share_token_hash` and `uq_resource_grants_share_token_hash`
(replaced by a partial unique index on the live `share_token`),
`artifact_learn_failures.error_code`, `chat_runs.error_detail`,
`libraries.color`, `stripe_webhook_events.processed_at`,
`document_embed_artifact_states.extraction_error_code`/`extraction_error_message`,
`fragment_blocks.block_type`/`is_empty`,
`epub_resources.fallback_item_id`/`manifest_item_id`/`properties`,
`resource_versions.content_hash` + its CHECK,
`resource_external_snapshots.source_snapshot` + its CHECK, the
`billing_entitlement_override_events` table, and the orphan
`Consumption.Activity`/`Consumption.PreviewPosition` replay memos.

what remains: `artifact_build_failures.support` + its CHECK
`ck_artifact_build_failures_support_object`. the column is still read —
`services/artifacts/engine.py:2492` selects `f.support AS failure_support` into
`DossierUnsuccessfulBuildView` and `api/routes/dossiers.py:233,239` projects it
onto the dossier wire — so the DDL cannot land until oi-157's ART-05 removes
that projection and its three TS decoders. nothing writes the column: both
`INSERT INTO artifact_build_failures` statements name only
`(build_id, failure_code, detail)`.

fix: land oi-157 ART-05, then one alembic revision dropping the CHECK and the
column.

acceptance: `pg_dump --schema-only` shows neither
`artifact_build_failures.support` nor
`ck_artifact_build_failures_support_object`; the dossier failure wire still
decodes.
