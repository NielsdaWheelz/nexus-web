# consumption state carries four write-only timestamps

status: deferred (a later release drops the columns) · origin: 2026-09-28, consumption-stats reauthoring · area: consumption / schema

`consumption_overrides.created_at`, `reader_engagement_states.created_at`,
`reader_media_state.created_at` and `reader_media_state.updated_at` have no
reader in python, web, android or node (`rg` on the tables: the only outside
reader, `services/media_source_ingest.py`, asks `reader_media_state` for
`locator IS NOT NULL`). since the consumption-stats reauthoring nothing writes
them either; the column defaults fill new rows.

why not dropped now: the release before it still sets `created_at = now()` on
every override upsert and `updated_at = now()` on every cursor save, so a drop in
the same release breaks immediate rollback.

fix: in a release after the reauthoring has shipped, one migration drops the four
columns.

acceptance: the migration is applied; `rg` finds none of the four columns
outside migration history.
