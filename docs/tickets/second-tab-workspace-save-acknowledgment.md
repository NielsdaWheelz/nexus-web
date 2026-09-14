# workspace persistence acknowledges failed writes

- status: open
- origin: 2026-09-13 second-tab investigation; revision `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: workspace persistence

the same acknowledgment and unhandled-flush defects are present in deployed
revision `7e8fd48244b3b436965037738e05785bb4931be1` (verified with `git show`).
that revision additionally lacks the obsolete capture cleanup already present
at the local revision; this ticket concerns the defects remaining locally.

## evidence

`apps/web/src/lib/workspace/useWorkspaceSession.ts:29-35` advances the saved
snapshot before the request succeeds and handles only authentication failure.
after a network or server failure, the same state compares equal to that
snapshot (`:26`), and page-hide flush only considers a pending debounce timer
(`:50-58`). the failed snapshot therefore has no remaining retry or flush owner.
`useWorkspaceSession.browser.test.tsx:33-76` proves successful capture and flush,
but does not exercise failed acknowledgment.

the lifecycle flush at `useWorkspaceSession.ts:58` also discards its promise
without handling rejection. `apps/web/src/lib/api/client.ts:363-373` propagates
transport and non-success responses, so a failed flush can emit an unhandled
rejection when opening another browser tab backgrounds the first.

this is a persistence defect established by control flow, not a demonstrated
cause of the reported second-tab crash.

## prerequisites and fix

define the workspace save contract and its relationship to page lifecycle.
track the last acknowledged snapshot separately from dirty and in-flight work;
retain failed work until acknowledgment, supersession by newer state, or an
explicit discard. expose persistence failure through the owning workspace
surface and provide bounded recovery. page-hide must consider dirty work even
after a prior request was dispatched.

## acceptance

through `./scripts/test`, demonstrate that a rejected save remains pending,
retry or lifecycle flush persists the latest state, and an acknowledgment for
an older snapshot cannot mark newer state saved. failed lifecycle saves produce
an owned, classified outcome without an unhandled rejection. observe the regression proof
fail on this revision before accepting the fix.
