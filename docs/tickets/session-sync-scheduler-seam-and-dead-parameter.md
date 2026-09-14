# a test-only scheduler seam and a dead positional parameter in the workspace session sync

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: workspace session sync / cleanliness

## what is wrong

`apps/web/src/lib/workspace/sessionSync.ts:110` exposes `scheduleDelivery`, whose
only caller is a proof
(`apps/web/src/lib/workspace/workspaceMissingRow.browser.test.tsx:12,33,46`), and
carries a `mounted` parameter that is literally `true` at its only production call
site (`apps/web/src/lib/workspace/WorkspaceSessionSync.tsx:15`). a seam that only
a test uses, and a parameter with one possible value, are both surface the
product does not have.

## prerequisites

none. the change is three files and must land together or the build breaks.

## proposed fix

delete the `mounted` parameter and inline `scheduleDelivery` into its production
path; rewrite `workspaceMissingRow.browser.test.tsx` to drive the component
(`WorkspaceSessionSync`) rather than the private scheduler, so the proof exercises
the path production takes.

## acceptance

`sessionSync.ts` exports no function whose only caller is a test, and the
missing-row proof still fails when the delivery path is broken.
