# `media_source_attempts.status = 'superseded'` is allowed but has no writer

**Status:** open (0227 is fail-closed against it)
**Origin:** Imports workspace cutover, Track A, 2026-09-08
**Area:** `python/nexus/db/models.py` (`ck_media_source_attempts_status`);
`migrations/alembic/versions/0227_imports_history.py`

## What is wrong

`ck_media_source_attempts_status` has admitted `'superseded'` since
`migrations/alembic/versions/0133_media_source_attempts.py:67`, and
`services/imports.py` classifies it as terminal-complete alongside
`'succeeded'` (lines 160–192). No code in `python/nexus/` ever writes it:
`services/media_source_ingest.py` returns a `{"status": "superseded"}` *job
result*, never an attempt status, and no migration sets one.

Migration 0227 must state every extant attempt as a history baseline outcome
(`Succeeded | Failed | InFlight`). A `'superseded'` attempt is none of those, so
`_assert_every_import_has_a_recordable_baseline` rejects it before any DDL and
leaves the schema at 0224
(`test_0227_preflight_rejects_an_uncatalogued_attempt_error_code` proves the
sibling rejection path). If a production row in that status exists, the
maintenance-window migration blocks and needs operator cleanup.

## Prerequisites

Read the production database:
`SELECT count(*) FROM media_source_attempts WHERE status = 'superseded'` — the
answer decides which fix applies.

## Proposed fix

If the count is zero, drop `'superseded'` from the status CHECK and from
`services/imports.py`'s classification, so the allowed set matches the writers.
If it is not zero, add a `Superseded` variant to `SourceBaselineOutcome` and map
it in the migration instead.

## Acceptance

The status CHECK admits exactly the statuses a writer produces, and 0227's
preflight has no unreachable rejection branch.
