# three historical-only import failure codes need a data remap

status: open · origin: 2026-10-09 web dead-code sweep (cleanup/web-dead-code, claude session) · area: imports / failure vocabulary

nothing produces `E_BILLING_REQUIRED`, `E_LLM_BAD_REQUEST` or
`E_PODCAST_QUOTA_EXCEEDED` any more; they survive only so stored history rows
still decode: `python/nexus/schemas/import_history.py:59,69,76` (each commented
as historical), `apps/web/src/lib/imports/importRef.ts:33,45,52` and the copy
catalog `apps/web/src/lib/status/imports.ts:69,141,183`.

prerequisites: owner approval to rewrite stored history (hard cutover allowed by
the cleanup campaign) and a production census of rows carrying these codes.

fix: an alembic migration remaps those rows to `E_INGEST_FAILED`; then delete
the three codes from the python vocabulary, the web code list and the copy
catalog, and regenerate the wire.

acceptance: `git grep -n 'BILLING_REQUIRED\|LLM_BAD_REQUEST\|PODCAST_QUOTA_EXCEEDED' -- python apps node`
is empty outside migrations, and a migrated database decodes every history row.
