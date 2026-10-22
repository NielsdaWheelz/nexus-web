# an external body change can show doubled text ("left right" → "leftt")

status: open · origin: notes re-slice second review (overlay/O-9g, the reviewer's "alphaa"),
2026-10-21; fixed only by the dropped P2 editor commit · area: note bodies and editor
(`components/notes/NoteEditor.tsx`)

when a note's body changes from outside the editor, `replaceDoc` replaces only the changed
range: from the first difference (`findDiffStart`) to the last (`findDiffEnd`). when the
removed text ends with the characters just before it, the common suffix overlaps the common
prefix, the end lies before the start, and the replacement keeps a character that should go.

impact: the editor shows text that is not the note's body: "left right" → "left" shows
"leftt", "helloo" → "hello" shows "helloo", "alphaa" → "alpha" shows "alphaa". the next
keystroke saves what is shown, so the wrong text becomes the note. external changes include
undo and redo in an outline note, a conflict's "use saved", another tab's save adopted by a
clean editor and a split's carried text (`lib/notes/texts.ts:199-203`). on main's engine the
split form (O-9g) showed one frame and healed when the reply landed; the undo and adoption
forms are by code and a model check, not run in a browser.

evidence (main `c0063b28e`):
- `components/notes/NoteEditor.tsx:1251-1259` (`replaceDoc`): `tr.replaceWith(start, end.a,
  doc.content.cut(start, end.b))` with no overlap correction; called from the body effect
  (`:977-982`) and after a composition (`:766`).
- `lib/notes/useOutlineSession.ts:1864-1865`: a text undo or redo goes through
  `store.replaceText`, so it reaches `replaceDoc`.
- the same function run against main's `prosemirror-model`/`prosemirror-state` on one
  paragraph: "left right" → "left" yields "leftt"; "aa" → "a" yields "aa"; "leftt" → "left"
  yields "leftt" (a second external change does not heal it).

repro (by code, unrun): in an outline note type "hello", click outside it (blur ends the
history step, `NoteEditor.tsx:713-716`), click back at its end, type "o", press Cmd-Z; the
editor should show "hello" and, afaict, shows "helloo"; type X and the saved text is
"hellooX".

starting point: P2 (`34c68acda`): `const overlap = start - Math.min(a, b); if (overlap > 0)
[a, b] = [a + overlap, b + overlap];` before `replaceWith`.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: a test of `replaceDoc` over overlapping prefix/suffix pairs ("left right" →
"left", "aa" → "a", "ab" → "abab") shows exactly the new body, and the undo repro shows
"hello".
