# The browser has no closed catalog of Imports failure codes

**Status:** open (blocks the Imports copy owner, Track E)
**Origin:** Imports workspace cutover, Track D1, 2026-09-08
**Area:** `apps/web/src/lib/imports/importsClient.ts`; `lib/status/imports.ts` (not yet written)

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
