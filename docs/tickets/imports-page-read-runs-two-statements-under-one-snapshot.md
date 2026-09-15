# The Imports page read's counts and rows are two statements under one snapshot

**Status:** open
**Origin:** 2026-09-08, imports workspace hard cutover, Track C2
**Area:** `python/nexus/services/imports.py` (`read_import_page`), `python/tests/conftest.py`
(`nexus_app` fixture)

## What is wrong

`read_import_page` runs the classification CTE twice per request: once for
`matched_count`/`groups`/the invariant-defect check and once for the ordered,
limited page (both statements share `_IMPORTS_CTE` text). Their agreement rests on
the route's `get_repeatable_read_db` snapshot (`REPEATABLE READ`, `READ ONLY`).
The `nexus_app` fixture overrides that dependency with the shared savepoint
session and records that it "deliberately does NOT prove the per-request
REPEATABLE READ ... every snapshot route runs one SELECT". This route now runs two,
so the count/page agreement under a concurrent owner commit is unproven.

## Prerequisites

A process-level service proof shape that exercises the real
`get_repeatable_read_db` dependency against the run database (two sessions).

## Proposed fix

Either fold counts and page into one statement (a window `count(*) OVER ()` plus a
grouped aggregate in the same result), or add a two-session process proof that an
owner commit between the two statements cannot make `matched_count` disagree with
the page.

## Acceptance

Either `read_import_page` issues one statement, or a named service case observes
the same snapshot across both statements while another session commits a new
attention row between them.
