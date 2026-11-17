# the updated/title sort module has no importer

found 2026-11-15 at `839bb918b`, surveying the notes for a redesign. rechecked
at `6fc320a75`: its former callers no longer use the module.

## problem

`apps/web/src/lib/collections/updatedTitleIndexView.ts` (91 lines, 11 exports:
the view union and its decoded form, the canonical view, the option ids, codec,
query and option helpers) is imported by nothing. the notes index publishes
`order: null` and sorts only by the authored `pages` query
(`app/(authenticated)/notes/NotesPaneBody.tsx:54`); the conversations pane the
record named is gone.

## impact

dead code: a reader looking for how the notes index sorts finds a sort
contract that no pane uses.

## evidence

`rg -n updatedTitleIndexView apps/web/src` returns only the module itself.
last change `3df90a898` (2026-10-21, pane chrome leaves).

## resolved when

the module is deleted, or a pane imports it again.
