# History date bounds require an explicit UTC offset the date control cannot give

**Status:** resolved on the codec side (Track D2, 2026-09-08); pane proof pending Track E
**Origin:** 2026-09-08, imports workspace hard cutover, Track C1 (reviewer finding)
**Area:** `python/nexus/schemas/imports.py`,
`apps/web/src/lib/imports/importsUrlState.ts`

## What is wrong

Contract §4 says the History bounds are UTC instants, so
`ImportListQuery` rejects a naive `from`/`before` with 400 `E_INVALID_REQUEST`
(`python/nexus/schemas/imports.py:273-281`, pinned by
`python/tests/kernel/test_imports_schema.py::test_import_list_query_refuses_a_history_bound_without_an_offset`).

Contract §6 gives the pane "two `input type=date` with visible labels 'From' /
'Before'". A date control's value is a bare `YYYY-MM-DD`. If Track D's
`importsUrlState.ts` codec forwards that value unchanged, every History date
filter answers 400.

## Proposed fix

Keep the server strict — a bare date has no instant meaning — and make the
codec convert: `from=YYYY-MM-DD` → `…T00:00:00Z`, `before=YYYY-MM-DD` →
`…T00:00:00Z` (the bound is exclusive, `[from, before)`, so "Before 9 Sep"
excludes the 9th). The URL keeps the canonical instant, so a shared link means
one window everywhere.

## Acceptance

`importsUrlState.unit.test.ts` has a named case that a date-control value
encodes to an explicit `Z` instant, and the pane's History date filter returns
200 in `ImportsWorkspace.browser.test.tsx`.

## Resolution (Track D2, 2026-09-08)

The server stays strict and the codec converts, exactly as proposed — with one
correction to the proposal: the **URL** keeps the calendar day the date control
produced (contract D17: "The URL carries calendar dates"), and `importsQueryParams`
is the single place that emits `YYYY-MM-DDT00:00:00Z`. Putting the instant in the
URL would have made the shared link disagree with the date field a reader sees.
`importsUrlState.unit.test.ts` has the named case
`sends History bounds as the explicit UTC instants the API accepts`, and the codec
rejects a well-formed but impossible day (`2026-09-31`).

Still open: the second half of the acceptance — the pane's History date filter
returning 200 in `ImportsWorkspace.browser.test.tsx` — belongs to Track E.
