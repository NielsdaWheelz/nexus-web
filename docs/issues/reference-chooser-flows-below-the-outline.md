# the reference chooser is not positioned beside its row

source finding at `fcd6843db` on 2026-11-15. the survey photograph selected the
last row, so it did not demonstrate the suspected long-outline failure.

`apps/web/src/components/notes/NoteEditor.tsx:1783–1791` renders
`data-reference-chooser` after the editor in normal flow, without anchored
placement. its collection's height cap limits its size, not its position.
the formatting toolbar has a selection-relative placement owner; the chooser
does not use one.

impact inferred from source: typing `@` near the top of a long outline can put
the chooser far below the row, potentially outside the viewport.

resolved when: the chooser remains near the edited row and within the visible
scrollport while typing and choosing, preserving the selection and using the
existing overlay/placement contracts rather than another overlay system.
