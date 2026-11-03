# a merge displaces the existing link's former row while it holds writing

problem: a drop that merges (the destination parent already links the item, so
that link takes the drop's place and the source link goes) hands the existing link
to the placed row and retires the former occurrence's row at `rebuild`. while that
former row holds pending writing or the caret, `rebuild` (`apps/web/src/lib/notes/outlineController.ts`, the pending-field
splice in `collect` and the settled-field cleanup) splices its pending field back
as a row with the same link until the write settles, so two rows carry one link
and a caret in the former row is lost. `place` has no analogue of `removalBlocked`.

impact: lost caret or a transient duplicate row on a drop onto a parent whose
mirror of the item is being edited. low likelihood: it needs the user to drop the
same note onto the parent of the row they are typing in.

evidence: the adversary review of the outline engine (finding 8), by source
reading; not cased. the review's companion finding (the former row's open window
was dropped) is fixed: `reconcileRange` names the former row and `installRange`
moves its open state to the survivor.

proposed fix: `place` refuses, through `handle.refuse`, when the destination
link's former row is pending or holds the caret, as `removalBlocked` does for
removal (`finish the writing in this branch before removing it`), or defers the
gesture until the write settles.

resolved when: a lab case types in the mirror row, drops the source onto its
parent and observes either the refusal or one row with the link and the caret
kept, with no duplicate row at any point.
