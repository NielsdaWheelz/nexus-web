# a new outline row keeps the accessible name it was created with

status: open · origin: notes re-slice harness (outline/O33, defect D10), 2026-10-21; fixed
only by the dropped P2 editor commit · area: note bodies and editor
(`components/notes/NoteEditor.tsx`)

a row's editor is named `edit note: <label>`, the label following the note's saved text.
after Enter and typing "words of the new row" (saved), the editor is still named "edit
note: Note" (or its first saved character). a reload names it by its text.

impact: screen readers announce a stale name for every row created in this visit, and
afaict for any row whose first line changed since its last save landed.

evidence (main `c0063b28e`):
- `lib/notes/outline.ts:265` names a new row "Note" until its text is saved;
  `components/resources/ResourceOutlineRow.tsx:1281` and
  `components/notes/OutlineEditor.tsx:216` pass a label derived from the saved text.
- `components/notes/NoteEditor.tsx:528-559`: `aria-label` is a ProseMirror view attribute
  (`:551`), recomputed only on a view update.
- `components/notes/NoteEditor.tsx:1008-1024`: the effect that calls `setProps` does not
  depend on `props.label`, so a label that changes after the last keystroke (the save's
  reply) never reaches the dom.
- outline/O33 is an xfail on main and on P1 (#734).

repro: Enter after a row, type a few words, wait 2 s for the save; read the new editor's
accessible name.

starting point: P2 (`34c68acda`) added `props.label` to that effect's dependencies.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O33 passes (the saved row is named by its text without a reload).
