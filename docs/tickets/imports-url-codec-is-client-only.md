# The Imports URL codec cannot be read by a server component

**Status:** resolved (Track D2, 2026-09-08)
**Origin:** Imports workspace cutover, Track D1, 2026-09-08
**Area:** `apps/web/src/lib/imports/importsUrlState.ts`;
`apps/web/src/lib/imports/importsClient.ts`

## What is wrong

`importsUrlState.ts` carries no directive of its own, but it imports
`parseImportRef`, `IMPORT_STAGES` and `IMPORT_STATE_KINDS` from
`./importsClient`, whose first line is `"use client"` (the directive is there for
the `Imports.Invalidated` window/`BroadcastChannel` signal that contract §5 puts
in that module). Every export of a `"use client"` module reaches a server
component as a client reference, so a Track F server `page.tsx` that wanted to
read `searchParams` and call `decodeImportsUrlState` cannot.

Contract §7 has `page.tsx` return null and `ImportsPaneBody.tsx` (a client
component) drive `usePaneUrlState`, so nothing is broken today. The hazard is
that the constraint is invisible: the first server-side read of the Imports URL
fails at runtime, not at type-check.

## Prerequisites

None. Track F's route work is the first consumer that could hit it.

## Proposed fix

Split the directive-free half out: move the ref grammar and the stage/state
literal arrays into `lib/imports/importsContract.ts` with no `"use client"`, and
have `importsClient.ts` and `importsUrlState.ts` both import from it. (The
alternative — dropping the directive from `importsClient.ts` and giving the
invalidation signal its own client module — moves the signal out of the module
contract §5 names for it.)

## Acceptance

`decodeImportsUrlState` / `encodeImportsUrlState` are reachable from a module
with no `"use client"` in its import graph, and Track F's route can read the
Imports URL on the server if it chooses to.

## Resolution (Track D2, 2026-09-08)

`apps/web/src/lib/imports/importRef.ts` is directive-free and owns the import-ref
grammar plus the closed vocabularies the codec narrows to (`IMPORT_STAGES`,
`IMPORT_STATE_KINDS`, `SAFE_FAILURE_CODES`). `importsUrlState.ts` imports only from
it, `@/lib/media/kind` and `@/lib/api/presence`, so nothing in its import graph
carries `"use client"` and a server component can read the Imports URL.

Contract §5 names the file for the ref grammar alone and puts `SAFE_FAILURE_CODES`
in `importsClient.ts`; the vocabularies moved with the grammar because leaving them
behind would have left the codec client-only and this ticket open.
