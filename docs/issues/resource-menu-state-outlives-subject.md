# resource menu state can outlive its subject

status: implementation repaired; exact same-document visit qualification open.

original problem: the old resource reader retained unkeyed facts across ref
changes; a reused mobile header could expose commands for its previous subject.

current source: `lib/actions/useResourceActions.ts` keys facts by ref and exact
signal and aborts/forgets on replacement. `ActionMenu` binds its invocation to the
explicit subject; `ContextualActionMenu.tsx:59` keys that subject by the pane's
visit id, its subject key and the resource ref, in both projections of the pane
header `PaneShell` renders (the phone bar is its Mobile projection since the
pane chrome re-slice). source review passes. live pending departure and
different-resource checks use hard navigation and prove unmount retirement;
they do not independently prove same-document replacement of a visit to the same
resource in a pane header that stays mounted.

resolved when supported same-document visit/resource replacement during pending
and ready phases retires the old invocation without late publication or focus
theft, including a same-resource new visit. do not add an internal store test seam.
