# the last interacted evidence row stays retained

`media/[id]/evidence/useEvidenceWindow.ts` initializes `sticky` to null, sets it
in `interact`, includes it in `held`, and never clears it. `ActionMenu.tsx` calls
`interact()` while its row-window pin is mounted. this predates companion density.

impact: after the overlay closes, the last interacted row can remain mounted and
influence the margin pivot even though the overlay-specific position hold ends.
open and dismiss a row menu, then move the reader away from its passage.

resolved when: the window owner defines and implements the interaction hold's
release boundary, with focus, selection, pending edits and failures still retained.
