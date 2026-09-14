# workspace recovery offers an arbitrary row, including rows owned by live writers

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: workspace session recovery

## what is wrong

`apps/web/src/lib/workspace/sessionStore.ts:46` (`next`) returns the **first**
cursor row of the `accountId` index — arbitrary, since `writerId` is random — and
`WorkspaceRecovery` turns any such row into a Choose prompt. two consequences:

- a layout owned by a live writer in another window is offered for recovery.
- only ever the first row is offered; a user with several stored layouts cannot
  reach the others.

the recency half of the fix requires a required `capturedAt` field on
`PendingWorkspaceSession`, which breaks the row literals in
`apps/web/src/lib/workspace/WorkspaceRecovery.browser.test.tsx:13-16,36-39`.

separately, the new terminal "Discard this layout permanently" disposition in
`WorkspaceRecovery.tsx` landed **without a proof**: the conditional delete, the
`workspace_recovery_discard_failed` log and the `role=alert` return-to-choice
path are unexercised.

## prerequisites

decide what a recovery offer means when another window is live: skip such rows,
or offer them with a different sentence. do not silently prefer the first row.

## proposed fix

give `PendingWorkspaceSession` a required `capturedAt`, order candidates by it,
and let recovery walk them. update the browser proof's row literals in the same
change. add the missing discard proof: a failed conditional delete must return to
the choice with the alert and must not mark the row gone.

## acceptance

with three stored layouts and one live foreign writer, recovery offers the most
recent non-live layout and can reach the others; a declined layout can be
discarded once; a failed discard returns to the choice and the row survives.
