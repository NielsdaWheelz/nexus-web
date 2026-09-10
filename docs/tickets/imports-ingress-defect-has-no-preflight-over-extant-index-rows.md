# The new `failed` content-index defect has no preflight over extant rows

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain P review (OI-024 fix),
2026-09-09
**Area:** `python/nexus/services/imports.py` (`_item`),
`migrations/alembic/versions/0225_imports_history.py` (preflight)

## What is wrong

Before this phase, `services/imports.py` classified a media whose content index
reports `status = 'failed'` as `InvariantDefect` **only** when it did not have
its exact dead reindex job; the complementary shape fell through to
`WHEN index_job_status = 'dead' THEN 'NeedsAttention'` and was a listed,
repairable row. OI-024 replaced that branch with an unconditional ingress check:

```python
    if row["index_status"] == "failed":
        # justify-defect: `failed` is a note-index status; no media owner writes it.
        raise AssertionError("media content index reports a status no owner writes")
```

Every Imports read that materialises such a row (the page, the detail) now 500s.
The claim "no media owner writes it" was established by surveying today's
**writers** (`services/content_indexing.py`, `jobs/dead_letter_projections.py`);
nothing has surveyed the **stored rows**. If any `content_index_states` row with
`owner_kind = 'media'` and `status = 'failed'` exists in production — written by
an owner that has since been deleted or renamed — the cut turns a row that used
to render as `NeedsAttention` into a 500 on the pane a viewer lands on.

Migration 0225's preflight
(`_assert_every_import_has_a_recordable_baseline`) is the repository's own
pattern for exactly this class of assumption, but it asserts only over
`media_upload_sessions.verification_error_code` and
`media_source_attempts.status`/`error_code` (contract §2). It says nothing about
`content_index_states`.

## Prerequisites

None. The predicate is one select; the decision is where it belongs, since the
0225 preflight's stated claim is about *history recordability*, not about what
the Imports read can classify.

## Proposed fix

Either:

1. run `SELECT count(*) FROM content_index_states WHERE owner_kind = 'media' AND
   status = 'failed'` against production before the cut and record the result
   (zero rows retires this ticket outright); or
2. add that predicate to 0225 as its own named preflight — `RuntimeError` naming
   the offending media ids — so a database that cannot be read by the new
   classifier is refused at 0224 instead of failing at read time. That edit is
   Track A's file and needs a case in
   `python/tests/migrations/test_imports_history_migration.py`.

## Acceptance

The absence of `content_index_states` rows with `owner_kind = 'media'` and
`status = 'failed'` is either an evidenced fact recorded against the cut, or a
migration preflight that refuses the upgrade, before `_item`'s ingress defect
reaches production data.
