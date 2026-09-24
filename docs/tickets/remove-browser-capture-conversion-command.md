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

production prerequisite (2026-09-23 handoff review, pr #377 at `5087d9e5f`):
quiesce upload/capture requests and affected source jobs/retries before migration;
keep them stopped through conversion and its zero-work second run, then resume.
the pr body's “deploy; migrate; convert” sequence omits this boundary, required
by `docs/extension-firefox-v1-plan.md:252`. the conversion module's opening
contract also requires conversion before enabling captures; the new adapter
accepts packet inputs only. retain verified database/source backups and the
legacy blobs through rollback. do not interpret deployment as permission to
resume normal processing before conversion finishes.

source-confirmed deployment gap: `deploy/hetzner/release.py:578-580` calls
`migrate(candidate)` then `start(candidate)` with no conversion step. the
ordinary `deploy.sh` cannot currently hold this boundary. before production,
provide the one-shot conversion between those operations (or an explicit
operator sequence preserving the same stopped-writer boundary); do not run the
ordinary release and convert afterward. acceptance includes proving no affected
service resumes until conversion succeeds and a second run has no work.

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
