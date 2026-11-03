# an embed-only outline row is named by its raw ref

priority: deferred presentation/accessibility follow-up; prioritize before relying on spoken navigation or when revisiting embed labels.

problem: a note whose whole body is an unlabelled embed gets its accessible name
from `OutlineController.label`, which takes the first line of
`clipboardPlainText` (`apps/web/src/lib/notes/clipboard.ts`); that serialises an
unlabelled embed as its ref. the row's group reads `outline item:
note_block:fad7…`, its bullet `open note: note_block:fad7…`, and a drag ghost of
the row shows the same ref.

impact: screen-reader users hear an opaque id instead of the embedded item's
title; sighted users see it only in the drag ghost. predates the outline redesign.

evidence: lab run `20261102-132035-282ed7dfcc13` (case `adversary-L3-f-followups`)
reads both names; the ghost in run `20261102-131155-e6d2c7c6c800` (case
`adversary-L3-e-embed`).

resolved when an embed-only row's group, bullet and ghost name the embedded
resource by its title (or `empty note` when it has none), and no ref appears in
any accessible name.
