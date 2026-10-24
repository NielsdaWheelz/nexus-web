# Tab in an outline note moves the caret to the note's end

status: open · origin: notes re-slice harness (outline/O17, defect D2), 2026-10-21; fixed
only by the dropped web engine (P2) · area: notes outline
(`lib/notes/useOutlineSession.ts`, `components/notes/OutlineSurface.tsx`)

indenting a note with Tab puts the caret at the end of the indented note, wherever it
was. Shift+Tab (outdent) takes the same path.

impact: typing after Tab lands at the wrong place. caret at the start of "second", Tab,
type X: "secondX", not "Xsecond". nothing warns.

evidence (main `c0063b28e`):
- `components/notes/NoteEditor.tsx:869-874` passes the caret (`at`) to `keys.indent`.
- `components/notes/OutlineSurface.tsx:527-532` binds `indent: () => session.indent({ row, rows })`
  and drops it.
- `lib/notes/useOutlineSession.ts:2932-2945` (`indent`) calls `relinkPlacement`, which sets
  the after-selection at the body's end (`:2443-2449`) and focuses the new row at `"end"`
  (`:2508-2512`).
- outline/O17 is an xfail on main and on P1 (#734): tab shows `["first","secondX"]`.

repro: a page with "first" and "second"; caret at the start of "second"; Tab; type X.

starting point: P2 (`88acbbf1e`) carried the editor's caret through indent and outdent
into the relink's after-selection and the focus request.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O17 passes (Tab and Shift+Tab keep the caret's offset in the moved
note).
