# The durable activity outbox suite fails in the imports runner container

## restoration update, 2026-09-14

pr #254 removes the automated suite/harness cited below. retain this historical
observation for manual product/capacity investigation; its old test commands and
proposed test-routing changes are superseded by the direct `./scripts/test`
contract. removal of the suite does not resolve an unconfirmed product concern.


**Status:** open
**Origin:** Imports workspace cutover, Phase 7 chain Z2, 2026-09-10
**Area:** `apps/web/src/lib/consumption/activityRuntime.browser.test.ts`

## What is wrong

`src/lib/consumption/activityRuntime.browser.test.ts` fails 8 of its 13 cases when
run in the imports cutover's Linux runner container, deterministically (two
consecutive runs, identical counts). The failures all read as writes that never
reached IndexedDB or a delivery that never started:

```
blocks at capacity without evicting durable rows
  expected { total: 2, pending: 0, … } to match object { total: 2, pending: 2 }
commits a closed span to IndexedDB before starting network delivery
  expected 'Failed' to be 'Synced'
recovers a committed span in a new runtime after an ambiguous process stop
  expected [] to have a length of 1 but got 0
regroups stable capture keys under a new outgoing mutation id           (same)
cancels an ambiguous old-account upload before opening another account  (same)
durably stores elapsed time closed by the browser lifecycle
  expected 'Failed' to be 'Pending'
marks only media-loss rows failed and keeps later work drainable
  expected [] to include '20000000-0000-4000-8000-000000000008'
retains a same-system rejection as a defect without wedging later rows  (same)
```

Nothing in this cutover touches it: `apps/web/src/lib/consumption/**` is
unmodified in the worktree and last changed in `2546a1e6` ("make consumption
activity durable", #181), well before the cutover branched. So this is either a
pre-existing product defect or — more likely, given the shape — an IndexedDB /
storage-persistence capability the container's Chromium does not provide.

It matters here because the suite is reachable by selection: adding
`apps/web/src/__tests__/helpers/contrast.ts` selected a risk broad enough to pull
in 26 browser suites including this one, and the governed run reported
`changed: fail` on a tree whose own proofs all pass. Any imports change wide
enough to select it inherits the failure.

## Evidence

- `bash <scratchpad>/runner/t.sh bash -lc 'cd apps/web && npx vitest run --project browser src/lib/consumption/activityRuntime.browser.test.ts'`
  → `Tests 8 failed | 5 passed (13)`, twice, at base `26b8161b`.
- `git status --porcelain -- apps/web/src/lib/consumption/` is empty.
- The batched run stopped at the first failure (`--bail=1`), which is why the
  governed summary named only one.

## Prerequisites

Someone has to decide which it is. Running the same suite outside the container
(the primary checkout, hosted CI) separates "container storage capability" from
"product defect"; hosted CI is currently unavailable (billing), so this needs the
Mac's own browser project or the primary checkout.

## Proposed fix

If it is the container: record the missing capability with the runner recipe so
the lane is not run there, or give the container what Chromium's durable storage
needs. If it is the product: the outbox never commits, which is the durability
claim #181 was built for, and it wants its own investigation.

## Acceptance

`activityRuntime.browser.test.ts` passes in whatever environment the repository
declares as the owner of `component` browser proofs, and the imports cutover's
`changed` runs stop inheriting a failure from a tree it does not touch.
