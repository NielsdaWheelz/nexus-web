# a cross-tab acknowledgment leaves the live writer with a stale baseline

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: hosted reader progress / pending work

## what is wrong

`apps/web/src/lib/reader/hostedReaderProgress.ts:313` deletes an acknowledged
row. when the acknowledging owner is a different tab, the live writer's
in-memory `previous.baseline` is not updated, so its next capture is compared
against a baseline the authority has already moved past and yields a self
conflict — the user is asked to choose between two of their own consecutive
positions.

## prerequisites

this was left open deliberately, not overlooked. the fix the finding proposes is
to stop deleting an acknowledged row and keep an `acknowledged` tombstone so the
owner's next capture inherits `previous.baseline`. that adds a row state the
spec's record shape does not have, changes the drain loop's termination
condition, and leaves per-writer tombstones that only a later recovery scan can
clean (one authority GET each) — machinery out of proportion to an outcome gate c
already permits.

decide first whether a cross-tab acknowledgment should update a live writer's
baseline at all, or whether the explicit conflict is the honest answer.

## proposed fix

if the tombstone is wanted: add the `acknowledged` state to the record shape,
make the drain terminate on it, and give orphan recovery the purge. if not:
close this ticket by recording the decision rather than leaving it implicit in a
delete.

## acceptance

two tabs, one reader: after the second tab acknowledges, the first tab's next
capture either succeeds against the moved baseline or reports a conflict whose
text names the other tab — never a self conflict between the user's own
consecutive positions. observe the current behaviour failing first.
