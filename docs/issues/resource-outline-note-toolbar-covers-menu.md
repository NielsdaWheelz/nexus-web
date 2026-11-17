# a note toolbar may cover a neighbouring row menu

source hypothesis after `fcd6843db`; not a rendered reproduction. the floating
formatting toolbar in `apps/web/src/components/notes/NoteEditor.module.css` is
absolute at z-index 35. `NoteEditor.tsx` `placeToolbar` now positions it near the
selection, but does not account for a neighbouring row's trailing action target
(`ResourceOutline.module.css` `.actions`).

impact: a toolbar near the end of a line may cover the row menu or its neighbour.
this is the reverse of pane chrome obscuring the toolbar, and needs its own
hit-test evidence before a placement repair is chosen.

resolved when: formatting and nearby row actions remain reachable with the
selection preserved, without reserving a permanent full-height action column.
