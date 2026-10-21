# a pending split occurrence survives its inverse removal in the view

at `d90ed1033`, private run `20261021-131016-a53791bba604`, offline split → type
child → undo text → undo split restores parent focus/body but leaves the empty
child. `useOutlineSession.ts` drops the edge from its graph, then
`projectChildren` reinjects the original pending insertion. only relink registered
a pending removal marker.

register remove/consume markers under their exact operation, roll back only the
owned marker on refusal, and retire it through accepted read generations after
acknowledgement. resolved when the unchanged offline inverse survives restart
and a shared retained note's undo uses its canonical body with a fresh link id.
