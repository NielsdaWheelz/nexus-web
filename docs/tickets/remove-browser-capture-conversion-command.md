# remove the browser-capture conversion command after its production run

status: open · origin: 2026-09-23 firefox capture v1 track a · area: cutover tooling

`python/nexus/services/browser_capture_conversion.py` and the
`nexus convert-browser-article-captures` subcommand in `python/nexus/cli.py`
exist for one verified run per environment after migration 0241. per media they
convert the pre-cutover `browser_article_capture` attempts (readable html plus,
when any attempt names it, the full source html) into one verified packet named
by the latest attempt, rewrite every attempt payload to the capture shape and
record `media.browser_capture_sha256`. each rewritten payload keeps its original
`.html`/`.source-html` blobs under `retained_legacy_paths`, which
`source_attempt_artifacts.source_attempt_storage_paths` reports, so the orphan
sweep spares them and media deletion removes them. that key IS the rollback
window: a code-plus-data rollback restores payloads naming blobs that still exist.

fix, in order:

1. after the production run prints its converted media and a second run converts
   nothing, delete the module and the cli wiring.
2. once rollback is no longer an option (the post-conversion backup is verified),
   close the window with one statement, then delete the `retained_legacy_paths`
   read from `source_attempt_storage_paths`:

   ```sql
   UPDATE media_source_attempts
   SET source_payload = source_payload - 'retained_legacy_paths'
   WHERE source_payload ? 'retained_legacy_paths';
   ```

   the existing orphan sweep reclaims the legacy objects at its next pass (they
   are older than its minimum age and now have no db owner).

acceptance: no attempt with `source_type = 'browser_article_capture'` lacks a
payload `sha256`; no payload carries `retained_legacy_paths`; the module, the
subcommand and the legacy-path read are gone; `./scripts/test` is green.
