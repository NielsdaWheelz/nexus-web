# accepting an `@` page in the reader's passage note throws "Position N out of range"

status: open · origin: notes re-slice harness (reader/R6, defect D8), 2026-10-21; fixed only
by the dropped P2 editor commit · area: note bodies and editor
(`components/notes/NoteEditor.tsx`)

in the reader's selection dock, typing `@` and accepting a page saves the passage as a
highlight linked to that page (durably right), then the editor throws an uncaught
`RangeError: Position 21 out of range` (the query's length + 1).

impact: an uncaught page error right after a successful link. what else it breaks in
the dock is unmeasured (idk).

evidence (main `c0063b28e`):
- `components/notes/NoteEditor.tsx:984-1005`: on a completed reference the editor swaps its
  whole state for the saved body (`view.updateState`), while the browser's selection still
  points into the longer query text.
- `components/notes/NoteEditor.tsx:1262-1280`: `syncNativeSelection`, run on blur (`:714`)
  and before structural keys, maps the native selection with `posAtDOM` and resolves it
  (`state.doc.resolve`, `:1273-1274`) without checking it against the new document's size;
  prosemirror-model throws `Position N out of range`.
- reader/R6 is an xfail on main and on P1 (#734): the link lands, then the page error.

repro: open a document in the reader, select a passage, in the dock type `@` and a page's
title, accept the page.

starting point: P2 (`34c68acda`) returns from `syncNativeSelection` when either end exceeds
`state.doc.content.size`.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: reader/R6 passes with no page error.
