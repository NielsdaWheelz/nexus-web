# restore across a removed register neighborhood

large page registers retain the viewport, pins, and a small head sample.
`apps/web/src/lib/workspace/paneReturnMemento.tsx` remembers the resulting
anchors in old rank order. sqlite resolves those identities in the new
revision. if the eye row and every remembered successor disappear while
the pane is away, restoration can miss a surviving successor outside the
previously admitted neighborhood.

reproduce with an oversized register. go deep, open a page, remove the
whole old viewport and overscan plus the eye row, then return. keep a
surviving successor just beyond that neighborhood. verify that the next
surviving occurrence in the old sqlite order takes the eye line, even if
a new title is now closer. this requires old-order evidence with the
retained visit. keep it revision scoped inside the sqlite owner.
