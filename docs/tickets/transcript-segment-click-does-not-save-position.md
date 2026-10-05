# clicking a transcript segment saves nothing; reload reopens at segment 1

status: open, fixed by reader pr2 · origin: 2026-10-04 cleanup campaign (claude coordinator), reader harness baseline · area: web reader (hosted pane)

## what is wrong

clicking a transcript segment seeks the player but records no reading position; on reload the pane saves the segment at the top of the list (segment 1) and reopens there. pinned as xfail `R.T.J1.restore-selected-segment`. related, separate: `transcript-semantic-viewport-key-mismatch.md`.

## fix

treat a segment seek as reading movement in the continuous transcript (pr2). see `reader-pr2-replace-hosted-pane.md`.

## acceptance

the pinned journey passes on the hosted pane.
