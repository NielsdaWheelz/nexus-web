# The browser has no closed catalog of Imports failure codes

**Status:** open — browser owner in place, drift proof still missing (Track D2, 2026-09-08)
**Origin:** Imports workspace cutover, Track D1, 2026-09-08
**Area:** `apps/web/src/lib/imports/importRef.ts` (the browser owner); `apps/web/src/lib/imports/importsClient.ts`; `lib/status/imports.ts` (not yet written)

## What is wrong

The Imports wire carries `failure_code` as `SafeFailureCode` — the closed
catalog composed in `python/nexus/schemas/import_history.py` (contract D5).
The browser decoder accepts it as any nonempty string
(`importsClient.ts`, `importState` / `historyEntry` / `baselineOutcome`),
because no TypeScript owner of that catalog exists. The spec requires the
opposite: "Unknown same-system variants/codes defect" and "No parallel reason
dictionary".

The precedent for a closed browser copy is
`apps/web/src/lib/media/uploadVerification.ts` (`UPLOAD_VERIFICATION_CODES`),
which mirrors one small Python `Literal`. The D5 catalog is large and is
derived by scanning the source-ingest adapter modules, so a hand-copied
TypeScript list would drift silently.

## Prerequisites

Track C's `schemas/import_history.py` must exist with the final catalog and
the kernel proof that scans for completeness.

## Proposed fix

Give the codes one browser owner (a `SAFE_FAILURE_CODES` const beside the copy
templates in `lib/status/imports.ts`), narrow `failureCode` in
`importsClient.ts` to it with `expectOneOf`, and prove drift with a check that
the browser list equals the Python catalog (a generated or asserted list, not a
second hand-maintained dictionary).

## Acceptance

An unknown code fails the strict decode instead of reaching the copy layer, and
adding a code to the Python catalog without adding it to the browser owner
fails a proof.

## Resolution (Track D2, 2026-09-08)

`apps/web/src/lib/imports/importRef.ts` owns `SAFE_FAILURE_CODES as const` and the
`SafeFailureCode` type, mirroring `python/nexus/schemas/import_history.py`. The
decoder narrows `failure_code` with `expectOneOf` in all three places it appears
(item state, history envelope, source baseline outcome), and the URL codec narrows
it too, so an uncatalogued code can never reach the API or the copy layer.
`importsClient.unit.test.ts` has a named case refusing one.

Drift is still to be pinned mechanically, so the acceptance above is **not**
met and this ticket stays open: contract D18 puts a kernel case in
`python/tests/kernel/test_import_history_schema.py` that reads the TypeScript
source and asserts set equality with the Python catalog. That case is Track A's
file and is not written yet.

The gap is not hypothetical. On 2026-09-08 a review comparing the two lists
mechanically found the browser list had 46 entries against Python's 49, missing
`E_OWNER_REQUIRED`, `E_REPAIR_NOT_ALLOWED` and `E_RESOURCE_CONFLICT` — three
codes the Python owner gained after the browser copy was written. Every one of
them is reachable (`E_REPAIR_NOT_ALLOWED` from a refused source repair,
`E_RESOURCE_CONFLICT` from a stale recovery identity), and each would have
failed `expectOneOf` and rendered the whole Imports pane as a decode defect.
The three were added to `apps/web/src/lib/imports/importRef.ts` in sorted
position and set equality re-checked by hand. Until the kernel case exists,
nothing stops the next widening from repeating this.
