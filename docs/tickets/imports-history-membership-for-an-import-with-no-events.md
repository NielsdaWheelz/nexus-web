# History membership when an import has no recorded event

**Status:** open (resolved one way in Track C1's proof; the contract sentence is
still ambiguous for the C2 implementation)
**Origin:** 2026-09-08, imports workspace hard cutover, Track C1 (reviewer finding)
**Area:** implementation contract §4 "Filters and views" / "Ordering and
cursors"; `python/nexus/services/imports.py` (Track C2)

## What is wrong

Contract §4 states History membership as a correlated predicate: "a row is
included iff one event of that import satisfies the correlated predicate P …
`matched_event` = the newest event satisfying P; order `(matched_event.
occurred_at DESC, ref)`", and the ordering key as `(matched_at DESC, ref ASC)`.
With no filter given, P has no filter clause, so the sentence does not say
whether an import with **zero** recorded events is listed. If it were, its
`matched_at` would not exist and the History order key would be undefined for
that row — the spec requires "Tie-break every order."

## What Track C1 decided

Membership follows the contract literally: an import appears in History only
when it has at least one recorded event, and every listed row therefore carries
a Present `matched_event` and an order key. This is not a restriction in
practice — migration 0225 writes one `HistoryBaseline` per extant upload session
and source attempt, and Track B records `UploadAccepted` / `SourceAccepted` in
the acceptance transaction — so an event-less import is an unreachable state.

`python/tests/service/test_imports.py::
test_history_lists_each_import_once_in_evidence_order_without_foreign_rows`
pins it: three imports with recorded evidence, ordered by matched-event time and
tie-broken by ref, with the published upload's whole matched `HistoryEntry`
asserted.

## Proposed fix

Amend contract §4 to say it outright: "unfiltered History lists every import
with at least one recorded event; `matched_event` is its newest event." Then
Track C2's CTE joins events rather than left-joining them, and no code path has
to invent an order key.

## Acceptance

The contract sentence names the unfiltered case, `services/imports.py` has no
branch producing a History row with an Absent `matched_event`, and the named
proof above stays green.
