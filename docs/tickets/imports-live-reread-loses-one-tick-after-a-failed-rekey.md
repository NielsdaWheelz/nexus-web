# A re-key whose summary read fails costs the page and detail one live tick

**Status:** open (Track D2 found it; register OI-003)
**Origin:** Imports workspace cutover, Track D2 re-review 3, 2026-09-08, at
`512ed5693ef61967831bc550bcffe9232cdca7d0` + the cutover working tree
**Area:** `apps/web/src/lib/imports/useImportsPage.ts:113-127,146`;
`apps/web/src/lib/imports/useImportDetail.ts:58-70,86`;
`apps/web/src/lib/imports/ImportsProvider.tsx:138-146,154,190-193`

## What is wrong

`useImportsPage` / `useImportDetail` suppress the live re-read of an observation
that re-keyed their read, because the keyed `useResource` read is that
observation's answer (otherwise every invalidation costs two page-one reads).
The suppression compares the observation revision the last tick ran under
(`tickedRevisionRef`, `useImportsPage.ts:115,126-128`) with the current one.

When a manual refresh or an invalidation re-keys the read
(`ImportsProvider.tsx:190-193` bumps `revision`) and *its own summary read then
fails* (`ImportsProvider.tsx:154` sets `loadState` `Failed` and publishes no new
`observedAt`), no tick is delivered for that re-key. The next successful
automatic read (`ImportsProvider.tsx:138-146`) is then the first tick under the
new revision, and it is suppressed — the page and the selected detail refresh
once at ~10 s instead of the 5 s cadence contract D10 states. The data on screen
is not wrong (the keyed read for the new revision ran at re-key time); only the
cadence slips, once, and only after a failed refresh.

The two histories a hook sees — a successful re-key, and a failed re-key
followed by a later successful poll — both read `{revision: r, observedAt: T0}` →
`{r+1, T1}` on `observation` alone. They are not identical in the published
context: `loadState` reaches `{kind:"Failed"}` between the revision bump and the
next `observedAt` in the failed case and never in the successful one, and
`useImports()` (already called by both hooks) exposes it, so contract §5 needs no
signature change. What is open is whether a hook-local formulation of that fact
is worth its state: it needs a second cross-render marker ("`loadState` reached
`Failed` under this revision") whose staleness is another thing to get right, and
the whole defect is one lost tick after a failed refresh.

## Prerequisites

None; `ImportsProvider` and both hooks exist, and `loadState` is already on the
context (`ImportsProvider.tsx:63`).

## Proposed fix

Either let the hooks read `loadState` and re-arm the tick marker for a revision
whose settlement failed, or — if that marker reads worse than the defect — let
the observation itself say which read produced it (`ImportsObservationState`
gains the outcome that settled the re-key), which is a contract §5 shape change
for Track F to absorb. Decide on the smaller of the two; do not do both.

## Acceptance

A named case in `apps/web/src/lib/imports/ImportsProvider.browser.test.tsx`:
work active, the reader refreshes while the summary read fails, the next
successful automatic read arrives ~5 s later, and page one is re-read on that
observation.
