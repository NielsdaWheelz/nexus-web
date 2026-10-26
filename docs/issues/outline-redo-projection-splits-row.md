# semantic text redo duplicates a projected row

frozen `f8c2b2ed3`, actual firefox run
`20261026-035401-a0f47e0a1cf0`, passes the original immediate undo,
movement undo and movement redo. the following text redo fails at
`mobile-editor-firefox.spec.ts:47`: three dom fields share occurrence
`77c33d06-5651-4882-9c11-ee40756b2d51` for one note, with partial and complete
text. five other selected controls did not run; canonical cleanup completed.

`OutlineController.project` diffs the whole projection, then passes a closed
`next.content.cut` fragment to `replaceWith` even when the diff starts inside a
row's text. inspect open slice depths at that boundary; the projection must
preserve one occurrence node and its inline grammar. no selector narrowing,
idle wait or native input workaround is accepted. prove the unchanged firefox
journey, exact canonical writing, one field per occurrence and the held-receipt
history controls after the owner repair. native behavior remains unqualified.
